/// The default maximum length of a `TreeBuffer` node.
export const DefaultBufferLength = 1024

// Checks whether the given node type is a tagged node.
function isTagged(type: number) { return (type & 1) > 0 }

/// The `unchanged` method expects changed ranges in this format.
export interface ChangedRange {
  /// The start of the change in the start document
  fromA: number
  /// The end of the change in the start document
  toA: number
  /// The start of the replacement in the new document
  fromB: number
  /// The end of the replacement in the new document
  toB: number
}

/// Signature of the `enter` function passed to `Subtree.iterate`. It is given
/// a node's tag, start position, and end position for every node,
/// and can return...
///
///  * `undefined` to proceed iterating as normal.
///
///  * `false` to not further iterate this node, but continue
///    iterating nodes after it.
///
///  * Any other value to immediately stop iteration and return the
///    value from the `iterate` method.
export type EnterFunc<T> = (tag: Tag, start: number, end: number) => T | false | undefined

/// Signature of the `leave` function passed to `Subtree.iterate`.
export type LeaveFunc = (tag: Tag, start: number, end: number) => void

class Iteration<T> {
  result: T | undefined = undefined

  constructor(readonly enter: EnterFunc<T>,
              readonly leave: LeaveFunc | undefined) {}

  get done() { return this.result !== undefined }

  doEnter(tag: Tag, start: number, end: number) {
    let value = this.enter(tag, start, end)
    if (value === undefined) return true
    if (value !== false) this.result = value
    return false
  }
}

/// A subtree is a representation of part of the syntax tree. It may
/// either be the tree root, or a tagged node.
export abstract class Subtree {
  /// The subtree's parent. Will be `null` for the root node
  abstract parent: Subtree | null

  /// The node's tag. Will be `Tag.empty` for the root
  abstract tag: Tag
  /// The start source offset of this subtree
  abstract start: number
  /// The end source offset
  abstract end: number

  /// The depth (number of parent nodes) of this subtree
  get depth() {
    let d = 0
    for (let p = this.parent; p; p = p.parent) d++
    return d
  }

  /// The root of the tree that this subtree is part of
  get root(): Tree {
    let cx = this as Subtree
    while (cx.parent) cx = cx.parent
    return cx as Tree
  }

  /// @internal
  abstract toString(): string

  /// Iterate over all nodes in this subtree. Will iterate through the
  /// tree in, calling `enter` for each node it enters and, if given,
  /// `leave` when it leaves a node.
  abstract iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc): T | undefined

  /// Find the node at a given position. By default, this will return
  /// the lowest-depth subtree that covers the position from both
  /// sides, meaning that nodes starting or ending at the position
  /// aren't entered. You can pass a `side` of `-1` to enter nodes
  /// that end at the position, or `1` to enter nodes that start
  /// there.
  resolve(pos: number, side: -1 | 0 | 1 = 0): Subtree {
    let result = this.resolveAt(pos)
    // FIXME this is slightly inefficient in that it scans the result
    // of resolveAt twice (but further complicating child-finding
    // logic seems unattractive as well)
    if (side != 0) for (;;) {
      let child = (side < 0 ? result.childBefore(pos) : result.childAfter(pos))
      if (!child || (side < 0 ? child.end : child.start) != pos) break
      result = child
    }
    return result
  }

  /// @internal
  abstract resolveAt(pos: number): Subtree

  /// Find the child tree before the given position, if any.
  abstract childBefore(pos: number): Subtree | null
  /// Find the child tree after the given position, if any.
  abstract childAfter(pos: number): Subtree | null

  /// Get the first child of this subtree.
  get firstChild() { return this.childAfter(this.start - 1) }
  /// Find the last child of this subtree.
  get lastChild() { return this.childBefore(this.end + 1) }
}

/// A piece of syntax tree. There are two ways to approach these
/// trees: the way they are actually stored in memory, and the
/// convenient way.
///
/// Syntax trees are stored as a tree of `Tree` and `TreeBuffer`
/// objects. By packing detail information into `TreeBuffer` leaf
/// nodes, the representation is made a lot more memory-efficient.
///
/// However, when you want to actually work with tree nodes, this
/// representation is very awkward, so most client code will want to
/// use the `Subtree` interface instead, which provides a view on some
/// part of this data structure, and can be used (through `resolve`,
/// for example) to zoom in on any single node.
export class Tree extends Subtree {
  /// @internal
  parent!: null

  /// @internal
  constructor(
    /// The tree's child nodes. Children small enough to fit in a
    /// `TreeBuffer` will be represented as such, other children can be
    /// further `Tree` instances with their own internal structure.
    readonly children: (Tree | TreeBuffer)[],
    /// The positions (offsets relative to the start of this tree) of
    /// the children.
    readonly positions: number[],
    /// The total length of this tree.
    readonly length: number,
    /// Mapping from node types to tags for this grammar @internal
    readonly tags: readonly Tag[],
    /// This tree's node type. The root node has type 0. @internal
    readonly type: number = 0
  ) {
    super()
  }

  /// @internal
  get start() { return 0 }

  /// @internal
  get end() { return this.length }

  /// @internal
  get tag() { return isTagged(this.type) ? this.tags[this.type >> 1] : Tag.empty }

  /// Check whether this tree's tag belongs to a given set of tags.
  /// Can be used to determine that a node belongs to the grammar
  /// defined by a specific parser.
  isPartOf(tags: readonly Tag[]) { return this.tags == tags }

  /// @internal
  toString(): string {
    let name = !isTagged(this.type) ? null : this.tag.tag
    let children = this.children.map(c => c.toString()).join()
    return !name ? children : name + (children.length ? "(" + children + ")" : "")
  }

  private partial(start: number, end: number, offset: number, children: (Tree | TreeBuffer)[], positions: number[]) {
    for (let i = 0; i < this.children.length; i++) {
      let from = this.positions[i]
      if (from > end) break
      let child = this.children[i], to = from + child.length
      if (to < start) continue
      if (start <= from && end >= to) {
        children.push(child)
        positions.push(from + offset)
      } else if (child instanceof Tree) {
        child.partial(start - from, end - from, offset + from, children, positions)
      }
    }
  }

  /// Apply a set of edits to a tree, removing all nodes that were
  /// touched by the edits, and moving remaining nodes so that their
  /// positions are updated for insertions/deletions before them. This
  /// is likely to destroy a lot of the structure of the tree, and
  /// mostly useful for extracting the nodes that can be reused in a
  /// subsequent incremental re-parse.
  applyChanges(changes: readonly ChangedRange[]) {
    if (changes.length == 0) return this
    let children: (Tree | TreeBuffer)[] = [], positions: number[] = []

    function cutAt(tree: Tree, pos: number, side: -1 | 1) {
      let sub = tree.resolve(pos)
      for (let cur = pos;;) {
        let sibling = side < 0 ? sub.childBefore(cur) : sub.childAfter(cur)
        if (sibling) return side < 0 ? sibling.end - 1 : sibling.start + 1
        if (!sub.parent) return side < 0 ? 0 : 1e9
        cur = side < 0 ? sub.start : sub.end
        sub = sub.parent!
      }
    }

    let off = 0
    for (let i = 0, pos = 0;; i++) {
      let next = i == changes.length ? null : changes[i]
      let nextPos = next ? cutAt(this, next.fromA, -1) : this.length
      if (nextPos > pos) this.partial(pos, nextPos, off, children, positions)
      if (!next) break
      pos = cutAt(this, next.toA, 1)
      off += (next.toB - next.fromB) - (next.toA - next.fromA)
    }
    return new Tree(children, positions, this.length + off, this.tags)
  }

  /// Take the part of the tree up to the given position.
  cut(at: number): Tree {
    if (at >= this.length) return this
    let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
    for (let i = 0; i < this.children.length; i++) {
      let from = this.positions[i]
      if (from >= at) break
      let child = this.children[i], to = from + child.length
      children.push(to <= at ? child : child.cut(at - from))
      positions.push(from)
    }
    return new Tree(children, positions, at, this.tags, this.type)
  }

  /// The empty tree
  static empty = new Tree([], [], 0, [])

  /// @internal
  iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc) {
    let iter = new Iteration(enter, leave)
    this.iterInner(from, to, 0, iter)
    return iter.result
  }

  /// @internal
  iterInner<T>(from: number, to: number, offset: number, iter: Iteration<T>) {
    if (isTagged(this.type) && !iter.doEnter(this.tag, offset, offset + this.length))
      return

    if (from <= to) {
      for (let i = 0; i < this.children.length && !iter.done; i++) {
        let child = this.children[i], start = this.positions[i] + offset, end = start + child.length
        if (start > to) break
        if (end < from) continue
        child.iterInner(from, to, start, iter)
      }
    } else {
      for (let i = this.children.length - 1; i >= 0 && !iter.done; i--) {
        let child = this.children[i], start = this.positions[i] + offset, end = start + child.length
        if (end < to) break
        if (start > from) continue
        child.iterInner(from, to, start, iter)
      }
    }      
    if (iter.leave && isTagged(this.type)) iter.leave(this.tag, offset, offset + this.length)
    return
  }

  /// @internal
  resolveAt(pos: number, side: -1 | 0 | 1 = 0): Subtree {
    return this.resolveInner(pos, 0, this)
  }

  /// @internal
  childBefore(pos: number): Subtree | null {
    return this.findChild(pos, -1, 0, this)
  }

  /// @internal
  childAfter(pos: number): Subtree | null {
    return this.findChild(pos, 1, 0, this)
  }

  /// @internal
  findChild(pos: number, side: number, start: number, parent: Subtree): Subtree | null {
    for (let i = 0; i < this.children.length; i++) {
      let childStart = this.positions[i] + start, select = -1
      if (childStart >= pos) {
        if (side < 0 && i > 0) select = i - 1
        else if (side > 0) select = i
        else break
      }
      if (select < 0 && (childStart + this.children[i].length > pos || side < 0 && i == this.children.length - 1))
        select = i
      if (select >= 0) {
        let child = this.children[select], childStart = this.positions[select] + start
        if (child.length == 0 && childStart == pos) continue
        if (child instanceof Tree) {
          if (isTagged(child.type)) return new NodeSubtree(child, childStart, parent)
          return child.findChild(pos, side, childStart, parent)
        } else {
          let found = child.findIndex(pos, side, childStart, 0, child.buffer.length)
          if (found > -1) return new BufferSubtree(child, childStart, found, parent)
        }
      }
    }
    return null
  }

  /// @internal
  resolveInner(pos: number, start: number, parent: Subtree): Subtree {
    let found = this.findChild(pos, 0, start, parent)
    return found ? found.resolveAt(pos) : parent
  }

  /// Append another tree to this tree. `other` must have empty space
  /// big enough to fit this tree at its start.
  append(other: Tree) {
    if (other.children.length && other.positions[0] < this.length) throw new Error("Can't append overlapping trees")
    return new Tree(this.children.concat(other.children), this.positions.concat(other.positions), other.length, this.tags, this.type)
  }

  /// Balance the direct children of this tree. Should only be used on
  /// non-tagged trees.
  balance(maxBufferLength = DefaultBufferLength) {
    return this.children.length <= BalanceBranchFactor ? this :
      balanceRange(this.type, this.tags, this.children, this.positions, 0, this.children.length, 0, maxBufferLength)
  }

  /// Build a tree from a postfix-ordered buffer of node information,
  /// or a cursor over such a buffer.
  static build(buffer: BufferCursor | readonly number[],
               tags: readonly Tag[],
               maxBufferLength: number = DefaultBufferLength,
               reused: Tree[] = []) {
    return buildTree(Array.isArray(buffer) ? new FlatBufferCursor(buffer, buffer.length) : buffer as BufferCursor,
                     tags, maxBufferLength, reused)
  }
}

Tree.prototype.parent = null

/// Tree buffers contain (type, start, end, endIndex) quads for each
/// node. In such a buffer, nodes are stored in prefix order (parents
/// before children, with the endIndex of the parent indicating which
/// children belong to it)
export class TreeBuffer {
  /// Create a tree buffer
  // FIXME store a type in here to efficiently represent nodes whose children all fit in a buffer (esp repeat nodes)?
  constructor(readonly buffer: Uint16Array, readonly length: number, readonly tags: readonly Tag[]) {}

  /// @internal
  toString() {
    let parts: string[] = []
    for (let index = 0; index < this.buffer.length;)
      index = this.childToString(index, parts)
    return parts.join(",")
  }

  /// @internal
  childToString(index: number, parts: string[]): number {
    let type = this.buffer[index], endIndex = this.buffer[index + 3]
    let result = this.tags[type >> 1].tag
    index += 4
    if (endIndex > index) {
      let children: string[] = []
      while (index < endIndex) index = this.childToString(index, children)
      result += "(" + children.join(",") + ")"
    }
    parts.push(result)
    return index
  }

  /// @internal
  cut(at: number) {
    let cutPoint = 0
    while (cutPoint < this.buffer.length && this.buffer[cutPoint + 1] < at) cutPoint += 4
    let newBuffer = new Uint16Array(cutPoint)
    for (let i = 0; i < cutPoint; i += 4) {
      newBuffer[i] = this.buffer[i]
      newBuffer[i + 1] = this.buffer[i + 1]
      newBuffer[i + 2] = Math.min(at, this.buffer[i + 2])
      newBuffer[i + 3] = Math.min(this.buffer[i + 3], cutPoint)
    }
    return new TreeBuffer(newBuffer, Math.min(at, this.length), this.tags)
  }

  /// @internal
  iterInner<T>(from: number, to: number, offset: number, iter: Iteration<T>) {
    if (from <= to) {
      for (let index = 0; index < this.buffer.length;)
        index = this.iterChild(from, to, offset, index, iter)
    } else {
      this.iterRev(from, to, offset, 0, this.buffer.length, iter)
    }
  }

  /// @internal
  iterChild<T>(from: number, to: number, offset: number, index: number, iter: Iteration<T>) {
    let tag = this.tags[this.buffer[index++] >> 1], start = this.buffer[index++] + offset,
        end = this.buffer[index++] + offset, endIndex = this.buffer[index++]
    if (start > to) return this.buffer.length
    if (end >= from && iter.doEnter(tag, start, end)) {
      while (index < endIndex && !iter.done) index = this.iterChild(from, to, offset, index, iter)
      if (iter.leave) iter.leave(tag, start, end)
    }
    return endIndex
  }

  private parentNodesByEnd(startIndex: number, endIndex: number) {
    // Build up an array of node indices reflecting the order in which
    // non-empty nodes end, to avoid having to scan for parent nodes
    // at every position during reverse iteration.
    let order: number[] = []
    let scan = (index: number) => {
      let end = this.buffer[index + 3]
      if (end == index + 4) return end
      for (let i = index + 4; i < end;) i = scan(i)
      order.push(index)
      return end
    }
    for (let index = startIndex; index < endIndex;) index = scan(index)
    return order
  }

  /// @internal
  iterRev<T>(from: number, to: number, offset: number, startIndex: number, endIndex: number, iter: Iteration<T>) {
    let endOrder = this.parentNodesByEnd(startIndex, endIndex)
    // Index range for the next non-empty node
    let nextStart = -1, nextEnd = -1
    let takeNext = () => {
      if (endOrder.length > 0) {
        nextStart = endOrder.pop()!
        nextEnd = this.buffer[nextStart + 3]
      } else {
        nextEnd = -1
      }
    }
    takeNext()

    run: for (let index = endIndex; index > startIndex && !iter.done;) {
      while (nextEnd == index) {
        let base = nextStart
        let type = this.buffer[base], start = this.buffer[base + 1] + offset, end = this.buffer[base + 2] + offset
        takeNext()
        if (start <= from && end >= to) {
          if (!iter.doEnter(this.tags[type >> 1], start, end)) {
            // Skip the entire node
            index = base
            while (nextEnd > base) takeNext()
            continue run
          }
        }
      }
      let endIndex = this.buffer[--index], end = this.buffer[--index] + offset,
        start = this.buffer[--index] + offset, type = this.buffer[--index]
      if (start > from || end < to) continue
      if ((endIndex != index + 4 || iter.doEnter(this.tags[type >> 1], start, end)) && iter.leave)
        iter.leave(this.tags[type >> 1], start, end)
    }
  }

  /// @internal
  findIndex(pos: number, side: number, start: number, from: number, to: number) {
    let lastI = -1
    for (let i = from, buf = this.buffer; i < to;) {
      let start1 = buf[i + 1] + start, end1 = buf[i + 2] + start
      let ignore = start1 == end1 && start1 == pos
      if (start1 >= pos) {
        if (side > 0 && !ignore) return i
        break
      }
      if (end1 > pos) return i
      if (!ignore) lastI = i
      i = buf[i + 3]
    }
    return side < 0 ? lastI : -1
  }
}

class NodeSubtree extends Subtree {
  constructor(readonly node: Tree,
              readonly start: number,
              readonly parent: Subtree) {
    super()
  }

  get tag() { return this.node.tag }

  get end() { return this.start + this.node.length }

  resolveAt(pos: number): Subtree {
    if (pos <= this.start || pos >= this.end)
      return this.parent.resolveAt(pos)
    return this.node.resolveInner(pos, this.start, this)
  }

  childBefore(pos: number): Subtree | null {
    return this.node.findChild(pos, -1, this.start, this)
  }

  childAfter(pos: number): Subtree | null {
    return this.node.findChild(pos, 1, this.start, this)
  }

  toString() { return this.node.toString() }

  iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc) {
    let iter = new Iteration(enter, leave)
    this.node.iterInner(from, to, this.start, iter)
    return iter.result
  }
}

class BufferSubtree extends Subtree {
  constructor(readonly buffer: TreeBuffer,
              readonly bufferStart: number,
              readonly index: number,
              readonly parent: Subtree) {
    super()
  }

  get tag() { return this.buffer.tags[this.buffer.buffer[this.index] >> 1] }
  get start() { return this.buffer.buffer[this.index + 1] + this.bufferStart }
  get end() { return this.buffer.buffer[this.index + 2] + this.bufferStart }

  private get endIndex() { return this.buffer.buffer[this.index + 3] }

  childBefore(pos: number): Subtree | null {
    let index = this.buffer.findIndex(pos, -1, this.bufferStart, this.index + 4, this.endIndex)
    return index < 0 ? null : new BufferSubtree(this.buffer, this.bufferStart, index, this)
  }

  childAfter(pos: number): Subtree | null {
    let index = this.buffer.findIndex(pos, 1, this.bufferStart, this.index + 4, this.endIndex)
    return index < 0 ? null : new BufferSubtree(this.buffer, this.bufferStart, index, this)
  }

  iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc) {
    let iter = new Iteration(enter, leave)
    if (from <= to)
      this.buffer.iterChild(from, to, this.bufferStart, this.index, iter)
    else
      this.buffer.iterRev(from, to, this.bufferStart, this.index, this.endIndex, iter)
    return iter.result
  }

  resolveAt(pos: number): Subtree {
    if (pos <= this.start || pos >= this.end) return this.parent.resolveAt(pos)
    let found = this.buffer.findIndex(pos, 0, this.bufferStart, this.index + 4, this.endIndex)
    return found < 0 ? this : new BufferSubtree(this.buffer, this.bufferStart, found, this).resolveAt(pos)
  }

  toString() {
    let result: string[] = []
    this.buffer.childToString(this.index, result)
    return result.join("")
  }
}

/// This is used by `Tree.build` as an abstraction for iterating over
/// a tree buffer. You probably won't need it.
export interface BufferCursor {
  pos: number
  type: number
  start: number
  end: number
  size: number
  next(): void
  fork(): BufferCursor
}

class FlatBufferCursor implements BufferCursor {
  constructor(readonly buffer: readonly number[], public index: number) {}

  get type() { return this.buffer[this.index - 4] }
  get start() { return this.buffer[this.index - 3] }
  get end() { return this.buffer[this.index - 2] }
  get size() { return this.buffer[this.index - 1] }

  get pos() { return this.index }

  next() { this.index -= 4 }

  fork() { return new FlatBufferCursor(this.buffer, this.index) }
}

const BalanceBranchFactor = 8

function buildTree(cursor: BufferCursor, tags: readonly Tag[], maxBufferLength: number, reused: Tree[]): Tree {
  function takeNode(parentStart: number, minPos: number, children: (Tree | TreeBuffer)[], positions: number[]) {
    let {type, start, end, size} = cursor, buffer!: {size: number, start: number, skip: number} | null
    let node, startPos = start - parentStart
    if (size < 0) {
      cursor.next()
      node = reused[type]
    } else if (end - start <= maxBufferLength &&
               (buffer = findBufferSize(cursor.pos - minPos, isTagged(type) ? -1 : type))) {
      // Small enough for a buffer, and no reused nodes inside
      let data = new Uint16Array(buffer.size - buffer.skip)
      let endPos = cursor.pos - buffer.size, index = data.length
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer.start, data, index)
      node = new TreeBuffer(data, end - buffer.start, tags)
      // Wrap if this is a repeat node
      if (!isTagged(type)) node = new Tree([node], [0], end - buffer.start, tags, type)
      startPos = buffer.start - parentStart
    } else { // Make it a node
      let endPos = cursor.pos - size
      cursor.next()
      let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
      while (cursor.pos > endPos)
        takeNode(start, endPos, localChildren, localPositions)
      localChildren.reverse(); localPositions.reverse()
      node = new Tree(localChildren, localPositions, end - start, tags, type)
    }

    children.push(node)
    positions.push(startPos)
    // End of a (possible) sequence of repeating nodes—might need to balance
    if (!isTagged(type) && (cursor.pos == 0 || cursor.type != type))
      maybeBalanceSiblings(children, positions, type)
  }

  function maybeBalanceSiblings(children: (Tree | TreeBuffer)[], positions: number[], type: number) {
    let to = children.length, from = to - 1
    for (; from > 0; from--) {
      let prev = children[from - 1]
      if (!(prev instanceof Tree) || prev.type != type) break
    }
    if (to - from < BalanceBranchFactor) return
    let start = positions[to - 1]
    let wrapped = balanceRange(type, tags, children.slice(from, to).reverse(), positions.slice(from, to).reverse(),
                               0, to - from, start, maxBufferLength)
    children.length = positions.length = from + 1
    children[from] = wrapped
    positions[from] = start
  }

  function findBufferSize(maxSize: number, type: number) {
    // Scan through the buffer to find previous siblings that fit
    // together in a TreeBuffer, and don't contain any reused nodes
    // (which can't be stored in a buffer)
    // If `type` is > -1, only include siblings with that same type
    // (used to group repeat content into a buffer)
    let fork = cursor.fork()
    let size = 0, start = 0, skip = 0, minStart = fork.end - maxBufferLength
    scan: for (let minPos = fork.pos - maxSize; fork.pos > minPos;) {
      let nodeSize = fork.size, startPos = fork.pos - nodeSize
      let localSkipped = isTagged(fork.type) ? 0 : 4
      if (nodeSize < 0 || startPos < minPos || fork.start < minStart || type > -1 && fork.type != type) break
      let nodeStart = fork.start
      fork.next()
      while (fork.pos > startPos) {
        if (fork.size < 0) break scan
        if (!isTagged(fork.type)) localSkipped += 4
        fork.next()
      }
      start = nodeStart
      size += nodeSize
      skip += localSkipped
    }
    return size > 4 ? {size, start, skip} : null
  }

  function copyToBuffer(bufferStart: number, buffer: Uint16Array, index: number): number {
    let {type, start, end, size} = cursor
    cursor.next()
    let startIndex = index
    if (size > 4) {
      let endPos = cursor.pos - (size - 4)
      while (cursor.pos > endPos)
        index = copyToBuffer(bufferStart, buffer, index)
    }
    if (isTagged(type)) { // Don't copy repeat nodes into buffers
      buffer[--index] = startIndex
      buffer[--index] = end - bufferStart
      buffer[--index] = start - bufferStart
      buffer[--index] = type
    }
    return index
  }

  let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
  while (cursor.pos > 0) takeNode(0, 0, children, positions)
  let length = children.length ? positions[0] + children[0].length : 0
  return new Tree(children.reverse(), positions.reverse(), length, tags)
}

function balanceRange(type: number,
                      tags: readonly Tag[],
                      children: readonly (Tree | TreeBuffer)[], positions: readonly number[],
                      from: number, to: number,
                      start: number, maxBufferLength: number): Tree {
  let length = (positions[to - 1] + children[to - 1].length) - start
  if (from == to - 1 && start == 0) {
    let first = children[from]
    if (first instanceof Tree) return first
  }
  let localChildren = [], localPositions = []
  if (length <= maxBufferLength) {
    for (let i = from; i < to; i++) {
      localChildren.push(children[i])
      localPositions.push(positions[i] - start)
    }
  } else {
    let maxChild = Math.max(maxBufferLength, Math.ceil(length * 1.5 / BalanceBranchFactor))
    for (let i = from; i < to;) {
      let groupFrom = i, groupStart = positions[i]
      i++
      for (; i < to; i++) {
        let nextEnd = positions[i] + children[i].length
        if (nextEnd - groupStart > maxChild) break
      }
      if (i == groupFrom + 1) {
        let only = children[groupFrom]
        if (only instanceof Tree && only.type == type) {
          // Already wrapped
          if (only.length > maxChild << 1) { // Too big, collapse
            for (let j = 0; j < only.children.length; j++) {
              localChildren.push(only.children[j])
              localPositions.push(only.positions[j] + groupStart - start)
            }
            continue
          }
        } else {
          // Wrap with our type to make reuse possible
          only = new Tree([only], [0], only.length, tags, type)
        }
        localChildren.push(only)
      } else {
        localChildren.push(balanceRange(type, tags, children, positions, groupFrom, i, groupStart, maxBufferLength))
      }
      localPositions.push(groupStart - start)
    }
  }
  return new Tree(localChildren, localPositions, length, tags, type)
}

function badTag(tag: string): never {
  throw new SyntaxError("Invalid tag " + JSON.stringify(tag))
}

/// Tags represent information about nodes. They are an ordered
/// collection of parts (more specific ones first) written in the form
/// `boolean.literal.expression` (where `boolean` further specifies
/// `literal`, which in turn further specifies `expression`).
///
/// A part may also have a value, written after an `=` sign, as in
/// `tag.selector.lang=css`. Part names and values may be double
/// quoted (using JSON string notation) when they contain non-word
/// characters.
///
/// This wrapper object pre-parses the tag for easy querying.
export class Tag {
  /// @internal
  parts: readonly string[]

  /// Create a tag object from a string.
  constructor(
    /// The string that the tag is based on.
    readonly tag: string
  ) {
    let parts = []
    if (tag.length) for (let pos = 0;;) {
      let start = pos
      while (pos < tag.length) {
        let next = tag.charCodeAt(pos)
        if (next == 61 || next == 46) break // "=" or "."
        pos++
      }
      if (pos == start) badTag(tag)
      let name = tag.slice(start, pos), value = ""
      if (tag.charCodeAt(pos) == 61) {
        let valStart = ++pos
        if (tag.charCodeAt(pos) == 34 /* '"' */) {
          for (pos++;;) {
            if (pos >= tag.length) badTag(tag)
            let next = tag.charCodeAt(pos++)
            if (next == 92) pos++
            else if (next == 34) break
          }
          value = JSON.parse(tag.slice(valStart, pos))
        } else {
          while (pos < tag.length && tag.charCodeAt(pos) != 46) pos++
          value = tag.slice(valStart, pos)
        }
      }
      parts.push(name, value)
      if (pos == tag.length) break
      if (tag.charCodeAt(pos) != 46) badTag(tag)
      pos++
    }
    this.parts = parts
  }

  private find(name: string, value?: string) {
    for (let i = 0; i < this.parts.length; i += 2) {
      if (this.parts[i] == name && (value == null || this.parts[i + 1] == value)) return i
    }
    return -1
  }

  /// Check whether this tag has a part by the given name. If `value`
  /// is given, this will only return true when that part also has
  /// that specific value.
  has(name: string, value?: string) {
    return this.find(name, value) > -1
  }

  /// See whether this tag contains all the parts present in the
  /// argument tag, and, if the part has a value in the query tag, the
  /// same value in this tag. Returns a specificity score—0 means
  /// there was no match, a higher score means the query matched more
  /// specific parts of the tag.
  match(tag: Tag) {
    let score = 0
    if (tag.parts.length == 0) return 1
    for (let i = 0; i < tag.parts.length; i += 2) {
      let val = tag.parts[i + 1]
      let found = this.find(tag.parts[i], val || undefined)
      if (found < 0) return 0
      score += 2 ** ((tag.parts.length - i) >> 1) + (val ? 1 : 0)
    }
    return score
  }

  /// The empty tag, returned for nodes that don't have a meaningful
  /// tag.
  static empty = new Tag("")
}

class MatchRule<T> {
  constructor(readonly inner: Tag, readonly parents: readonly Tag[], readonly value: T) {}
}

const none: readonly any[] = []

export class TagMatch<T> {
  private buckets: {readonly [partName: string]: readonly MatchRule<T>[]}

  constructor(readonly spec: {readonly [selector: string]: T}) {
    let rules = [], tag = /\s*([^\s"]|"(?:[^"\\]|\\.)+")*/g
    for (let selector in spec) {
      let tags = [], m
      while (m = tag.exec(selector)) tags.push(new Tag(m[1]))
      if (!tags.length) throw new Error("Invalid selector " + JSON.stringify(selector))
      rules.push(new MatchRule(tags[tags.length - 1], tags.length > 1 ? tags.slice(0, tags.length - 1) : none, spec[selector]))
    }
    let frequencies: {[name: string]: number} = Object.create(null)
    for (let rule of rules) {
      for (let i = 0; i < rule.inner.parts.length; i += 2) {
        let part = rule.inner.parts[i]
        frequencies[part] = (frequencies[part] || 0) + 1
      }
    }
    let buckets: {[partName: string]: MatchRule<T>[]} = Object.create(null)
    for (let rule of rules) {
      let rarePart = null, rarity = 1e9
      for (let i = 0; i < rule.inner.parts.length; i += 2) {
        let part = rule.inner.parts[i], freq = frequencies[part]
        if (freq < rarity) { rarePart = part; rarity = freq }
      }
      ;(buckets[rarePart!] || (buckets[rarePart!] = [])).push(rule)
    }
    this.buckets = buckets
  }

  match(tag: Tag, context: readonly Tag[] = none) {
    let best = null, bestScore = 0, bestParents = 0
    for (let i = 0; i < tag.parts.length; i += 2) {
      let bucket = this.buckets[tag.parts[i]]
      if (bucket) for (let rule of bucket) {
        let score = tag.match(rule.inner)
        if (score > 0 && score >= bestScore) {
          let parents = this.matchContext(rule, context)
          if (!parents) continue
          if (score > bestScore || parents > bestParents) {
            best = rule.value
            bestScore = score
            bestParents = parents
          }
        }
      }
    }
    return best
  }

  private matchContext(rule: MatchRule<T>, context: readonly Tag[]) {
    if (rule.parents.length == 0) return 1
    let pos = context.length, count = 1
    outer: for (let i = rule.parents.length - 1; i >= 0; i--) {
      let parent = rule.parents[i]
      for (let j = pos - 1; j >= 0; j--) {
        let score = context[j].match(parent)
        if (score > 0) {
          pos = j - 1
          count++
          continue outer
        }
      }
      return 0
    }
    return count
  }
}
