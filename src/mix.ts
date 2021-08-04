import {Tree, TreeBuffer, NodeType, NodeProp, TreeCursor, MountedTree} from "./tree"
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
  overlay?: readonly {from: number, to: number}[] | ((node: TreeCursor) => {from: number, to: number} | boolean)
}

/// Create a parse wrapper that, after the inner parse completes,
/// scans its tree for mixed language regions with the `nest`
/// function, runs the resulting [inner parses](#common.NestedParse),
/// and then [mounts](#common.NodeProp^mounted) their results onto the
/// tree.
///
/// The nesting function is passed a cursor to provide context for a
/// node, but _should not_ move that cursor, only inspect its
/// properties and optionally access its
/// [node object](#common.TreeCursor.node).
export function parseMixed(nest: (node: TreeCursor, input: Input) => NestedParse | null): ParseWrapper {
  return (parse, input, fragments, ranges): PartialParse => new MixedParse(parse, nest, input, fragments, ranges)
}

class InnerParse {
  constructor(
    readonly parser: Parser,
    readonly parse: PartialParse,
    readonly overlay: readonly {from: number, to: number}[] | null,
    readonly target: Tree
  ) {}
}

class ActiveOverlay {
  depth = 0
  readonly ranges: {from: number, to: number}[] = []

  constructor(
    readonly parser: Parser,
    readonly predicate: (node: TreeCursor) => {from: number, to: number} | boolean,
    readonly mounts: readonly ReusableMount[],
    readonly index: number,
    readonly start: number,
    readonly target: Tree,
    readonly prev: ActiveOverlay | null,
  ) {}
}

class MixedParse implements PartialParse {
  baseParse: PartialParse | null
  inner: InnerParse[] = []
  innerDone = 0
  baseTree: Tree | null = null
  stoppedAt: number | null = null

  constructor(
    base: PartialParse,
    readonly nest: (node: TreeCursor, input: Input) => NestedParse | null,
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
    }
    if (this.innerDone == this.inner.length) return this.baseTree
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
    let next = this.inner[this.innerDone]
    return next ? next.parse.parsedPos : this.input.length
  }

  stopAt(pos: number) {
    this.stoppedAt = pos
    if (this.baseParse) this.baseParse.stopAt(pos)
    else for (let i = this.innerDone; i < this.inner.length; i++) this.inner[i].parse.stopAt(pos)
  }

  startInner() {
    let fragmentCursor = new FragmentCursor(this.fragments)
    scan: for (let cursor = this.baseTree!.fullCursor(), nest, overlay: ActiveOverlay | null = null;;) {
      let enter = true, range
      if (fragmentCursor.hasNode(cursor)) {
        if (overlay) {
          let match = overlay.mounts.find(m => m.frag.from <= cursor.from && m.frag.to >= cursor.to && m.mount.overlay)
          if (match) for (let r of match.mount.overlay!) {
            let from = r.from + match.pos, to = r.to + match.pos
            if (from >= cursor.from && to <= cursor.to) overlay.ranges.push({from, to})
          }
        }
        enter = false
      } else if (!cursor.type.isAnonymous && cursor.from < cursor.to && (nest = this.nest(cursor, this.input))) {
        if (!cursor.tree) materialize(cursor)
        let oldMounts = fragmentCursor.findMounts(nest.parser)
        if (typeof nest.overlay == "function") {
          overlay = new ActiveOverlay(nest.parser, nest.overlay, oldMounts, this.inner.length,
                                      cursor.from, cursor.tree!,  overlay)
        } else {
          let ranges = punchRanges(this.ranges, nest.overlay || [{from: cursor.from, to: cursor.to}])
          this.inner.push(new InnerParse(
            nest.parser,
            nest.parser.startParse(this.input, enterFragments(oldMounts, ranges), ranges),
            nest.overlay ? nest.overlay.map(r => ({from: r.from - cursor.from, to: r.to - cursor.from})) : null,
            cursor.tree!
          ))
          enter = false
        }
      } else if (overlay && (range = overlay.predicate(cursor))) {
        if (range === true) range = {from: cursor.from, to: cursor.to}
        if (range.from < range.to) overlay.ranges.push(range)
      }
      if (enter && cursor.firstChild()) {
        if (overlay) overlay.depth++
      } else {
        for (;;) {
          if (cursor.nextSibling()) break
          if (!cursor.parent()) break scan
          if (overlay && !--overlay.depth) {
            let ranges = punchRanges(this.ranges, overlay.ranges)
            this.inner.splice(overlay.index, 0, new InnerParse(
              overlay.parser,
              overlay.parser.startParse(this.input, enterFragments(overlay.mounts, ranges), ranges),
              overlay.ranges.map(r => ({from: r.from - overlay!.start, to: r.to - overlay!.start})),
              overlay.target
            ))
            overlay = overlay.prev
          }
        }
      }
    }
  }
}

// Take a piece of buffer and convert it into a stand-alone
// TreeBuffer.
function sliceBuf(buf: TreeBuffer, startI: number, endI: number, nodes: (Tree | TreeBuffer)[], positions: number[], off: number) {
  if (startI < endI) {
    let b = buf.buffer, from = b[startI + 1], to = b[endI - 2]
    let copy = new Uint16Array(endI - startI)
    for (let i = startI, j = 0; i < endI;) {
      copy[j++] = b[i++]
      copy[j++] = b[i++] - from
      copy[j++] = b[i++] - from
      copy[j++] = b[i++] - startI
    }
    nodes.push(new TreeBuffer(copy, to - from, buf.set))
    positions.push(b[startI + 1] - off)
  }
}

// This function takes a node that's in a buffer, and converts it, and
// its parent buffer nodes, into a Tree. This is again acting on the
// assumption that the trees and buffers have been constructed by the
// parse that was ran via the mix parser, and thus aren't shared with
// any other code, making violations of the immutability safe.
function materialize(cursor: TreeCursor) {
  let {node} = cursor, depth = 0
  // Scan up to the nearest tree
  do { cursor.parent(); depth++ } while (!cursor.tree)
  // Find the index of the buffer in that tree
  let i = 0, base = cursor.tree!, off = 0
  for (;; i++) {
    off = base.positions[i] + cursor.from
    if (off <= node.from && off + base.children[i].length >= node.to) break
  }
  let buf = base.children[i] as TreeBuffer, b = buf.buffer
  // Split a level in the buffer, putting the nodes before and after
  // the child that contains `node` into new buffers.
  function split(startI: number, endI: number, type: NodeType, innerOffset: number): Tree {
    let i = startI
    while (b[i + 2] + off <= node.from) i = b[i + 3]
    let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
    sliceBuf(buf, startI, i, children, positions, innerOffset)
    let isTarget = b[i + 1] + off == node.from && b[i + 2] + off == node.to && b[i] == node.type.id
    children.push(isTarget ? node.toTree() : split(i + 4, b[i + 3], buf.set.types[b[i]], b[i + 1]))
    positions.push(b[i + 1] - innerOffset)
    sliceBuf(buf, b[i + 3], endI, children, positions, innerOffset)
    let last = children.length - 1
    return new Tree(type, children, positions, positions[last] + children[last].length)
  }
  // Overwrite (!) the child at the buffer's index with the split-up tree
  ;(base.children as any)[i] = split(0, b.length, NodeType.none, 0)
  // Move the cursor back to the target node
  for (let d = 0; d <= depth; d++) cursor.childAfter(node.from)
}

class StructureCursor {
  trees: Tree[] = []
  start: number[] = []
  index: number[] = []
  nextStart: number

  constructor(
    root: Tree,
    start = 0,
    readonly from = start,
    readonly to = start + root.length
  ) {
    this.trees.push(root)
    this.start.push(start)
    this.index.push(0)
    this.nextStart = Math.max(start, from)
  }

  // `pos` must be >= any previously given `pos` for this cursor
  nextNodeAt(pos: number) {
    if (pos < this.nextStart) return null
    for (;;) {
      let last = this.trees.length - 1
      if (last < 0) {
        this.nextStart = 1e9
        return null
      }
      let top = this.trees[last], index = this.index[last]
      if (index == top.children.length) {
        this.trees.pop()
        this.start.pop()
        this.index.pop()
        continue
      }
      let next = top.children[index]
      let start = this.start[last] + top.positions[index]
      if (start > pos) {
        this.nextStart = start
        return null
      }
      if (next instanceof Tree) {
        this.index[last]++
        let end = start + next.length
        if (end >= Math.max(this.from, pos)) { // Enter this node
          this.trees.push(next)
          this.start.push(start)
          this.index.push(0)
          if (start == pos && end <= this.to) return next
        }
      } else {
        this.index[last]++
        this.nextStart = start + next.length
      }
    }
  }
}

class FragmentCursor {
  curFrag: TreeFragment | null
  fragI = 0
  inner: StructureCursor | null

  constructor(readonly fragments: readonly TreeFragment[]) {
    if (fragments.length) {
      let first = this.curFrag = fragments[0]
      this.inner = new StructureCursor(first.tree, -first.offset, first.from, first.to)
    } else {
      this.curFrag = this.inner = null
    }
  }

  nextNodeAt(pos: number) {
    while (this.curFrag && pos >= this.curFrag.to) this.nextFrag()
    if (!this.inner) return null
    return this.inner.nextNodeAt(pos)
  }

  nextFrag() {
    this.fragI++
    if (this.fragI == this.fragments.length) {
      this.curFrag = this.inner = null
    } else {
      let frag = this.curFrag = this.fragments[this.fragI]
      this.inner = new StructureCursor(frag.tree, -frag.offset, frag.from, frag.to)
    }
  }

  hasNode(cursor: TreeCursor) {
    let tree = cursor.tree
    if (tree) for (let nodeHere; nodeHere = this.nextNodeAt(cursor.from);)
      if (nodeHere == tree) return true
    return false
  }

  // FIXME this is possibly not reliable when the start of the old node was overwritten
  findMounts(parser: Parser) {
    let result: ReusableMount[] = []
    if (this.inner) for (let i = this.inner.trees.length - 1; i >= 0; i--) {
      let tree = this.inner.trees[i], mount = tree.prop(NodeProp.mounted)
      if (mount && mount.parser == parser) {
        let from = this.inner.start[i], to = from + tree.length
        for (let i = this.fragI; i < this.fragments.length; i++) {
          let frag = this.fragments[i]
          if (frag.from >= to) break
          let pos = from + this.curFrag!.offset - frag.offset
          if (frag.tree == this.curFrag!.tree) result.push({frag, pos, mount})
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
        copy[j] = {from: r.from, to: gapFrom}
        if (r.to > gapTo) copy.splice(j + 1, 0, {from: gapTo, to: r.to})
      } else if (r.to > gapTo) {
        copy[j--] = {from: gapTo, to: r.to}
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
      if (start < end) result.push({from: start, to: end})
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
      let overlay = mount.overlay.map(r => ({from: r.from + pos, to: r.to + pos}))
      let changes = findCoverChanges(ranges, overlay, from, to)
      for (let i = 0, pos = from;; i++) {
        let last = i == changes.length, end = last ? to : changes[i].from
        if (end > pos)
          result.push(new TreeFragment(pos, end, mount.tree, -startPos, frag.from >= pos, frag.to <= end))
        if (last) break
        pos = changes[i].to
      }
    } else {
      result.push(new TreeFragment(from, to, mount.tree, -startPos, frag.from >= startPos, frag.to <= endPos))
    }
  }
  return result
}
