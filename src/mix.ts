import {Tree, TreeBuffer, NodeType, SyntaxNodeRef, SyntaxNode, NodeProp,
        TreeCursor, MountedTree, Range, IterMode, TreeNode, BufferNode} from "./tree"
import {Input, Parser, PartialParse, TreeFragment, ParseWrapper} from "./parse"

/// Objects returned by the function passed to
/// [`parseMixed`](#common.parseMixed) should conform to this
/// interface.
export interface NestedParse {
  /// The parser to use for the inner region.
  parser: Parser

  /// When this property is not given, the entire node is parsed with
  /// this parser, and it is [mounted](#common.NodeProp^mounted) as a
  /// non-overlay node, replacing its host node in tree iteration.
  ///
  /// When an array of ranges is given, only those ranges are parsed,
  /// and the tree is mounted as an
  /// [overlay](#common.MountedTree.overlay).
  ///
  /// When a function is given, that function will be called for
  /// descendant nodes of the target node, not including child nodes
  /// that are covered by another nested parse, to determine the
  /// overlay ranges. When it returns true, the entire descendant is
  /// included, otherwise just the range given. The mixed parser will
  /// optimize range-finding in reused nodes, which means it's a good
  /// idea to use a function here when the target node is expected to
  /// have a large, deep structure.
  overlay?: readonly {from: number, to: number}[] | ((node: SyntaxNodeRef) => {from: number, to: number} | boolean)
}

/// Create a parse wrapper that, after the inner parse completes,
/// scans its tree for mixed language regions with the `nest`
/// function, runs the resulting [inner parses](#common.NestedParse),
/// and then [mounts](#common.NodeProp^mounted) their results onto the
/// tree.
export function parseMixed(nest: (node: SyntaxNodeRef, input: Input) => NestedParse | null): ParseWrapper {
  return (parse, input, fragments, ranges): PartialParse => new MixedParse(parse, nest, input, fragments, ranges)
}

class InnerParse {
  constructor(
    readonly parser: Parser,
    readonly parse: PartialParse,
    readonly overlay: readonly {from: number, to: number}[] | null,
    readonly target: Tree,
    readonly from: number
  ) {}
}

function checkRanges(ranges: readonly {from: number, to: number}[]) {
  if (!ranges.length || ranges.some(r => r.from >= r.to))
    throw new RangeError("Invalid inner parse ranges given: " + JSON.stringify(ranges))
}

class ActiveOverlay {
  depth = 0
  readonly ranges: {from: number, to: number}[] = []

  constructor(
    readonly parser: Parser,
    readonly predicate: (node: SyntaxNodeRef) => {from: number, to: number} | boolean,
    readonly mounts: readonly ReusableMount[],
    readonly index: number,
    readonly start: number,
    readonly target: Tree,
    readonly prev: ActiveOverlay | null,
  ) {}
}

type CoverInfo = null | {ranges: readonly {from: number, to: number}[], depth: number, prev: CoverInfo}

const stoppedInner = new NodeProp<number>({perNode: true})

class MixedParse implements PartialParse {
  baseParse: PartialParse | null
  inner: InnerParse[] = []
  innerDone = 0
  baseTree: Tree | null = null
  stoppedAt: number | null = null

  constructor(
    base: PartialParse,
    readonly nest: (node: SyntaxNodeRef, input: Input) => NestedParse | null,
    readonly input: Input,
    readonly fragments: readonly TreeFragment[],
    readonly ranges: readonly {from: number, to: number}[]
  ) {
    this.baseParse = base
  }

  advance() {
    if (this.baseParse) {
      let done = this.baseParse.advance()
      if (!done) return null
      this.baseParse = null
      this.baseTree = done
      this.startInner()
      if (this.stoppedAt != null) for (let inner of this.inner) inner.parse.stopAt(this.stoppedAt)
    }
    if (this.innerDone == this.inner.length) {
      let result = this.baseTree!
      if (this.stoppedAt != null)
        result = new Tree(result.type, result.children, result.positions, result.length,
                          result.propValues.concat([[stoppedInner, this.stoppedAt]]))
      return result
    }
    let inner = this.inner[this.innerDone], done = inner.parse.advance()
    if (done) {
      this.innerDone++
      // This is a somewhat dodgy but super helpful hack where we
      // patch up nodes created by the inner parse (and thus
      // presumably not aliased anywhere else) to hold the information
      // about the inner parse.
      let props = Object.assign(Object.create(null), inner.target.props)
      props[NodeProp.mounted.id] = new MountedTree(done, inner.overlay, inner.parser)
      ;(inner.target as any).props = props
    }
    return null
  }

  get parsedPos() {
    if (this.baseParse) return 0
    let pos = this.input.length
    for (let i = this.innerDone; i < this.inner.length; i++) {
      if (this.inner[i].from < pos)
        pos = Math.min(pos, this.inner[i].parse.parsedPos)
    }
    return pos
  }

  stopAt(pos: number) {
    this.stoppedAt = pos
    if (this.baseParse) this.baseParse.stopAt(pos)
    else for (let i = this.innerDone; i < this.inner.length; i++) this.inner[i].parse.stopAt(pos)
  }

  startInner() {
    let fragmentCursor = new FragmentCursor(this.fragments)
    let overlay: ActiveOverlay | null = null
    let covered: CoverInfo = null
    let cursor = new TreeCursor(new TreeNode(this.baseTree!, this.ranges[0].from, 0, null),
                                IterMode.IncludeAnonymous | IterMode.IgnoreMounts)
    scan: for (let nest, isCovered;;) {
      let enter = true, range
      if (this.stoppedAt != null && cursor.from >= this.stoppedAt) {
        enter = false
      } else if (fragmentCursor.hasNode(cursor)) {
        if (overlay) {
          let match = overlay.mounts.find(m => m.frag.from <= cursor.from && m.frag.to >= cursor.to && m.mount.overlay)
          if (match) for (let r of match.mount.overlay!) {
            let from = r.from + match.pos, to = r.to + match.pos
            if (from >= cursor.from && to <= cursor.to && !overlay.ranges.some(r => r.from < to && r.to > from))
              overlay.ranges.push({from, to})
          }
        }
        enter = false
      } else if (covered && (isCovered = checkCover(covered.ranges, cursor.from, cursor.to))) {
        enter = isCovered != Cover.Full
      } else if (!cursor.type.isAnonymous && (nest = this.nest(cursor, this.input)) &&
                 (cursor.from < cursor.to || !nest.overlay)) {
        if (!cursor.tree) materialize(cursor)

        let oldMounts = fragmentCursor.findMounts(cursor.from, nest.parser)
        if (typeof nest.overlay == "function") {
          overlay = new ActiveOverlay(nest.parser, nest.overlay, oldMounts, this.inner.length,
                                      cursor.from, cursor.tree!,  overlay)
        } else {
          let ranges = punchRanges(this.ranges, nest.overlay ||
            (cursor.from < cursor.to ? [new Range(cursor.from, cursor.to)] : []))
          if (ranges.length) checkRanges(ranges)
          if (ranges.length || !nest.overlay) this.inner.push(new InnerParse(
            nest.parser,
            ranges.length ? nest.parser.startParse(this.input, enterFragments(oldMounts, ranges), ranges)
              : nest.parser.startParse(""),
            nest.overlay ? nest.overlay.map(r => new Range(r.from - cursor.from, r.to - cursor.from)) : null,
            cursor.tree!,
            ranges.length ? ranges[0].from : cursor.from,
          ))
          if (!nest.overlay) enter = false
          else if (ranges.length) covered = {ranges, depth: 0, prev: covered}
        }
      } else if (overlay && (range = overlay.predicate(cursor))) {
        if (range === true) range = new Range(cursor.from, cursor.to)
        if (range.from < range.to) {
          let last = overlay.ranges.length - 1
          if (last >= 0 && overlay.ranges[last].to == range.from)
            overlay.ranges[last] = {from: overlay.ranges[last].from, to: range.to}
          else
            overlay.ranges.push(range)
        }
      }
      if (enter && cursor.firstChild()) {
        if (overlay) overlay.depth++
        if (covered) covered.depth++
      } else {
        for (;;) {
          if (cursor.nextSibling()) break
          if (!cursor.parent()) break scan
          if (overlay && !--overlay.depth) {
            let ranges = punchRanges(this.ranges, overlay.ranges)
            if (ranges.length) {
              checkRanges(ranges)
              this.inner.splice(overlay.index, 0, new InnerParse(
                overlay.parser,
                overlay.parser.startParse(this.input, enterFragments(overlay.mounts, ranges), ranges),
                overlay.ranges.map(r => new Range(r.from - overlay!.start, r.to - overlay!.start)),
                overlay.target,
                ranges[0].from
              ))
            }
            overlay = overlay.prev
          }
          if (covered && !--covered.depth) covered = covered.prev
        }
      }
    }
  }
}

const enum Cover { None = 0, Partial = 1, Full = 2 }

function checkCover(covered: readonly {from: number, to: number}[], from: number, to: number) {
  for (let range of covered) {
    if (range.from >= to) break
    if (range.to > from) return range.from <= from && range.to >= to ? Cover.Full : Cover.Partial
  }
  return Cover.None
}

// Take a piece of buffer and convert it into a stand-alone
// TreeBuffer.
function sliceBuf(buf: TreeBuffer, startI: number, endI: number, nodes: (Tree | TreeBuffer)[], positions: number[], off: number) {
  if (startI < endI) {
    let from = buf.buffer[startI + 1]
    nodes.push(buf.slice(startI, endI, from))
    positions.push(from - off)
  }
}

// This function takes a node that's in a buffer, and converts it, and
// its parent buffer nodes, into a Tree. This is again acting on the
// assumption that the trees and buffers have been constructed by the
// parse that was ran via the mix parser, and thus aren't shared with
// any other code, making violations of the immutability safe.
function materialize(cursor: TreeCursor) {
  let {node} = cursor, stack: number[] = []
  let buffer = (node as BufferNode).context.buffer
  // Scan up to the nearest tree
  do { stack.push(cursor.index); cursor.parent() } while (!cursor.tree)
  // Find the index of the buffer in that tree
  let base = cursor.tree!, i = base.children.indexOf(buffer)
  let buf = base.children[i] as TreeBuffer, b = buf.buffer, newStack: number[] = [i]
  // Split a level in the buffer, putting the nodes before and after
  // the child that contains `node` into new buffers.
  function split(startI: number, endI: number, type: NodeType, innerOffset: number, length: number, stackPos: number): Tree {
    let targetI = stack[stackPos]
    let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
    sliceBuf(buf, startI, targetI, children, positions, innerOffset)
    let from = b[targetI + 1], to = b[targetI + 2]
    newStack.push(children.length)
    let child = stackPos
      ? split(targetI + 4, b[targetI + 3], buf.set.types[b[targetI]], from, to - from, stackPos - 1)
      : node.toTree()
    children.push(child)
    positions.push(from - innerOffset)
    sliceBuf(buf, b[targetI + 3], endI, children, positions, innerOffset)
    return new Tree(type, children, positions, length)
  }
  // Overwrite (!) the child at the buffer's index with the split-up tree
  ;(base.children as any)[i] = split(0, b.length, NodeType.none, 0, buf.length, stack.length - 1)
  // Move the cursor back to the target node
  for (let index of newStack) {
    let tree = cursor.tree.children[index] as Tree, pos = cursor.tree.positions[index]
    cursor.yield(new TreeNode(tree, pos + cursor.from, index, cursor._tree))
  }
}

class StructureCursor {
  cursor: TreeCursor
  done = false

  constructor(
    root: Tree,
    private offset: number
  ) {
    this.cursor = root.cursor(IterMode.IncludeAnonymous | IterMode.IgnoreMounts)
  }

  // Move to the first node (in pre-order) that starts at or after `pos`.
  moveTo(pos: number) {
    let {cursor} = this, p = pos - this.offset
    while (!this.done && cursor.from < p) {
      if (cursor.to >= pos && cursor.enter(p, 1, IterMode.IgnoreOverlays | IterMode.ExcludeBuffers)) {}
      else if (!cursor.next(false)) this.done = true
    }
  }

  hasNode(cursor: TreeCursor) {
    this.moveTo(cursor.from)
    if (!this.done && this.cursor.from + this.offset == cursor.from && this.cursor.tree) {
      for (let tree = this.cursor.tree!;;) {
        if (tree == cursor.tree) return true
        if (tree.children.length && tree.positions[0] == 0 && tree.children[0] instanceof Tree) tree = tree.children[0]
        else break
      }
    }
    return false
  }
}

class FragmentCursor {
  curFrag: TreeFragment | null
  curTo = 0
  fragI = 0
  inner: StructureCursor | null

  constructor(readonly fragments: readonly TreeFragment[]) {
    if (fragments.length) {
      let first = this.curFrag = fragments[0]
      this.curTo = first.tree.prop(stoppedInner) ?? first.to
      this.inner = new StructureCursor(first.tree, -first.offset)
    } else {
      this.curFrag = this.inner = null
    }
  }

  hasNode(node: TreeCursor) {
    while (this.curFrag && node.from >= this.curTo) this.nextFrag()
    return this.curFrag && this.curFrag.from <= node.from && this.curTo >= node.to && this.inner!.hasNode(node)
  }

  nextFrag() {
    this.fragI++
    if (this.fragI == this.fragments.length) {
      this.curFrag = this.inner = null
    } else {
      let frag = this.curFrag = this.fragments[this.fragI]
      this.curTo = frag.tree.prop(stoppedInner) ?? frag.to
      this.inner = new StructureCursor(frag.tree, -frag.offset)
    }
  }

  findMounts(pos: number, parser: Parser) {
    let result: ReusableMount[] = []
    if (this.inner) {
      this.inner.cursor.moveTo(pos, 1)
      for (let pos: SyntaxNode | null = this.inner.cursor.node; pos; pos = pos.parent) {
        let mount = pos.tree?.prop(NodeProp.mounted)
        if (mount && mount.parser == parser) {
          for (let i = this.fragI; i < this.fragments.length; i++) {
            let frag = this.fragments[i]
            if (frag.from >= pos.to) break
            if (frag.tree == this.curFrag!.tree) result.push({
              frag,
              pos: pos.from - frag.offset,
              mount
            })
          }
        }
      }
    }
    return result
  }
}

function punchRanges(outer: readonly {from: number, to: number}[], ranges: readonly {from: number, to: number}[]) {
  let copy: {from: number, to: number}[] | null = null, current = ranges
  for (let i = 1, j = 0; i < outer.length; i++) {
    let gapFrom = outer[i - 1].to, gapTo = outer[i].from
    for (; j < current.length; j++) {
      let r = current[j]
      if (r.from >= gapTo) break
      if (r.to <= gapFrom) continue
      if (!copy) current = copy = ranges.slice()
      if (r.from < gapFrom) {
        copy[j] = new Range(r.from, gapFrom)
        if (r.to > gapTo) copy.splice(j + 1, 0, new Range(gapTo, r.to))
      } else if (r.to > gapTo) {
        copy[j--] = new Range(gapTo, r.to)
      } else {
        copy.splice(j--, 1)
      }
    }
  }
  return current
}

type ReusableMount = {
  frag: TreeFragment,
  mount: MountedTree,
  pos: number
}

function findCoverChanges(a: readonly {from: number, to: number}[],
                          b: readonly {from: number, to: number}[],
                          from: number, to: number) {
  let iA = 0, iB = 0, inA = false, inB = false, pos = -1e9
  let result = []
  for (;;) {
    let nextA = iA == a.length ? 1e9 : inA ? a[iA].to : a[iA].from
    let nextB = iB == b.length ? 1e9 : inB ? b[iB].to : b[iB].from
    if (inA != inB) {
      let start = Math.max(pos, from), end = Math.min(nextA, nextB, to)
      if (start < end) result.push(new Range(start, end))
    }
    pos = Math.min(nextA, nextB)
    if (pos == 1e9) break
    if (nextA == pos) {
      if (!inA) inA = true
      else { inA = false; iA++ }
    }
    if (nextB == pos) {
      if (!inB) inB = true
      else { inB = false; iB++ }
    }
  }
  return result
}

// Given a number of fragments for the outer tree, and a set of ranges
// to parse, find fragments for inner trees mounted around those
// ranges, if any.
function enterFragments(mounts: readonly ReusableMount[], ranges: readonly {from: number, to: number}[]) {
  let result: TreeFragment[] = []
  for (let {pos, mount, frag} of mounts) {
    let startPos = pos + (mount.overlay ? mount.overlay[0].from : 0), endPos = startPos + mount.tree.length
    let from = Math.max(frag.from, startPos), to = Math.min(frag.to, endPos)
    if (mount.overlay) {
      let overlay = mount.overlay.map(r => new Range(r.from + pos, r.to + pos))
      let changes = findCoverChanges(ranges, overlay, from, to)
      for (let i = 0, pos = from;; i++) {
        let last = i == changes.length, end = last ? to : changes[i].from
        if (end > pos)
          result.push(new TreeFragment(pos, end, mount.tree, -startPos,
                                       frag.from >= pos || frag.openStart, frag.to <= end || frag.openEnd))
        if (last) break
        pos = changes[i].to
      }
    } else {
      result.push(new TreeFragment(from, to, mount.tree, -startPos,
                                   frag.from >= startPos || frag.openStart, frag.to <= endPos || frag.openEnd))
    }
  }
  return result
}
