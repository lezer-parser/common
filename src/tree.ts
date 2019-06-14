export const DEFAULT_BUFFER_LENGTH = 1024
export const TYPE_TAGGED = 1

export interface ChangedRange {
  fromA: number
  toA: number
  fromB: number
  toB: number
}

type EnterFunc<T> = (type: number, start: number, end: number) => T | false | undefined
type LeaveFunc = (type: number, start: number, end: number) => void

class Iteration<T> {
  result: T | undefined = undefined

  constructor(readonly enter: EnterFunc<T>,
              readonly leave: LeaveFunc | undefined) {}

  get done() { return this.result !== undefined }

  doEnter(type: number, start: number, end: number) {
    let value = this.enter(type, start, end)
    if (value === undefined) return true
    if (value !== false) this.result = value
    return false
  }
}

export abstract class Subtree {
  abstract parent: Subtree | null

  abstract type: number
  abstract start: number
  abstract end: number

  get depth() {
    let d = 0
    for (let p = this.parent; p; p = p.parent) d++
    return d
  }

  get root(): Tree {
    let cx = this as Subtree
    while (cx.parent) cx = cx.parent
    return cx as Tree
  }

  abstract toString(tags?: TagMap<any>): string

  abstract iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc): T | undefined

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

  // @internal
  abstract resolveAt(pos: number): Subtree

  abstract childBefore(pos: number): Subtree | null
  abstract childAfter(pos: number): Subtree | null

  get firstChild() { return this.childAfter(this.start - 1) }
  get lastChild() { return this.childBefore(this.end + 1) }
}

// Only the top-level object of this class is directly exposed to
// client code. Inspecting subtrees is done by allocating Subtree
// instances.
export class Tree extends Subtree {
  parent!: null

  constructor(readonly children: (Tree | TreeBuffer)[],
              readonly positions: number[],
              readonly type = 0,
              readonly length: number = positions.length ? positions[positions.length - 1] + children[positions.length - 1].length : 0) {
    super()
  }

  get start() { return 0 }

  toString(tags?: TagMap<any>): string {
    let name = (this.type & TYPE_TAGGED) == 0 ? null : tags ? tags.get(this.type) : this.type
    let children = this.children.map(c => c.toString(tags)).join()
    return !name ? children : name + (children.length ? "(" + children + ")" : "")
  }

  get end() { return this.length }

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

  unchanged(changes: readonly ChangedRange[]) {
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

    for (let i = 0, pos = 0, off = 0;; i++) {
      let next = i == changes.length ? null : changes[i]
      let nextPos = next ? cutAt(this, next.fromA, -1) : this.length
      if (nextPos > pos) this.partial(pos, nextPos, off, children, positions)
      if (!next) break
      pos = cutAt(this, next.toA, 1)
      off += (next.toB - next.fromB) - (next.toA - next.fromA)
    }
    return new Tree(children, positions)
  }

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
    return new Tree(children, positions)
  }

  static empty = new Tree([], [])

  iterate<T = any>(from: number, to: number, enter: EnterFunc<T>, leave?: LeaveFunc) {
    let iter = new Iteration(enter, leave)
    this.iterInner(from, to, 0, iter)
    return iter.result
  }

  // @internal
  iterInner<T>(from: number, to: number, offset: number, iter: Iteration<T>) {
    if ((this.type & TYPE_TAGGED) && !iter.doEnter(this.type, offset, offset + this.length))
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
    if (iter.leave && (this.type & TYPE_TAGGED)) iter.leave(this.type, offset, offset + this.length)
    return
  }

  resolveAt(pos: number, side: -1 | 0 | 1 = 0): Subtree {
    return this.resolveInner(pos, 0, this)
  }

  childBefore(pos: number): Subtree | null {
    return this.findChild(pos, -1, 0, this)
  }

  childAfter(pos: number): Subtree | null {
    return this.findChild(pos, 1, 0, this)
  }

  // @internal
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
          if (child.type & TYPE_TAGGED) return new NodeSubtree(child, childStart, parent)
          return child.findChild(pos, side, childStart, parent)
        } else {
          let found = child.findIndex(pos, side, childStart, 0, child.buffer.length)
          if (found > -1) return new BufferSubtree(child, childStart, found, parent)
        }
      }
    }
    return null
  }

  // @internal
  resolveInner(pos: number, start: number, parent: Subtree): Subtree {
    let found = this.findChild(pos, 0, start, parent)
    return found ? found.resolveAt(pos) : parent
  }

  append(other: Tree) {
    if (other.positions[0] < this.length) throw new Error("Can't append overlapping trees")
    return new Tree(this.children.concat(other.children), this.positions.concat(other.positions))
  }

  balance(maxBufferLength = DEFAULT_BUFFER_LENGTH) {
    return this.children.length <= BALANCE_BRANCH_FACTOR ? this :
      balanceRange(this.type, this.children, this.positions, 0, this.children.length, 0, maxBufferLength)
  }

  static fromBuffer(buffer: readonly number[], maxBufferLength = DEFAULT_BUFFER_LENGTH): Tree {
    return buildTree(new FlatBufferCursor(buffer, buffer.length), maxBufferLength, [])
  }

  static build(cursor: BufferCursor, maxBufferLength: number = DEFAULT_BUFFER_LENGTH, reused: Tree[] = []) {
    return buildTree(cursor, maxBufferLength, reused)
  }
}

Tree.prototype.parent = null

// Tree buffers contain (type, start, end, endIndex) quads for each
// node. In such a buffer, nodes are stored in prefix order (parents
// before children, with the endIndex of the parent indicating which
// children belong to it)
export class TreeBuffer {
  // FIXME store a type in here to efficiently represent nodes whose children all fit in a buffer (esp repeat nodes)?
  constructor(readonly buffer: Uint16Array, readonly length: number) {}

  get nodeCount() { return this.buffer.length >> 2 }

  toString(tags?: TagMap<any>) {
    let parts: string[] = []
    for (let index = 0; index < this.buffer.length;)
      index = this.childToString(index, parts, tags)
    return parts.join(",")
  }

  childToString(index: number, parts: string[], tags?: TagMap<any>): number {
    let type = this.buffer[index], endIndex = this.buffer[index + 3]
    let result = String(tags ? tags.get(type)! : type)
    index += 4
    if (endIndex > index) {
      let children: string[] = []
      while (index < endIndex) index = this.childToString(index, children, tags)
      result += "(" + children.join(",") + ")"
    }
    parts.push(result)
    return index
  }

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
    return new TreeBuffer(newBuffer, Math.min(at, this.length))
  }

  iterInner<T>(from: number, to: number, offset: number, iter: Iteration<T>) {
    if (from <= to) {
      for (let index = 0; index < this.buffer.length;)
        index = this.iterChild(from, to, offset, index, iter)
    } else {
      this.iterRev(from, to, offset, 0, this.buffer.length, iter)
    }
  }

  iterChild<T>(from: number, to: number, offset: number, index: number, iter: Iteration<T>) {
    let type = this.buffer[index++], start = this.buffer[index++] + offset,
        end = this.buffer[index++] + offset, endIndex = this.buffer[index++]
    if (start > to) return this.buffer.length
    if (end >= from && iter.doEnter(type, start, end)) {
      while (index < endIndex && !iter.done) index = this.iterChild(from, to, offset, index, iter)
      if (iter.leave) iter.leave(type, start, end)
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
          if (!iter.doEnter(type, start, end)) {
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
      if ((endIndex != index + 4 || iter.doEnter(type, start, end)) && iter.leave)
        iter.leave(type, start, end)
    }
  }

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

  get type() { return this.node.type }

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

  toString(tags?: TagMap<any>) { return this.node.toString(tags) }

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

  get type() { return this.buffer.buffer[this.index] }
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

  toString(tags?: TagMap<any>) {
    let result: string[] = []
    this.buffer.childToString(this.index, result, tags)
    return result.join("")
  }
}

export const REUSED_VALUE = -1

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

const BALANCE_BRANCH_FACTOR = 8

function buildTree(cursor: BufferCursor, maxBufferLength: number, reused: Tree[]): Tree {
  function takeNode(parentStart: number, minPos: number, children: (Tree | TreeBuffer)[], positions: number[]) {
    let {type, start, end, size} = cursor, buffer!: {size: number, start: number, skip: number} | null
    let node, startPos = start - parentStart
    if (size == REUSED_VALUE) {
      cursor.next()
      node = reused[type]
    } else if (end - start <= maxBufferLength &&
               (buffer = findBufferSize(cursor.pos - minPos, type & TYPE_TAGGED ? -1 : type))) {
      // Small enough for a buffer, and no reused nodes inside
      let data = new Uint16Array(buffer.size - buffer.skip)
      let endPos = cursor.pos - buffer.size, index = data.length
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer.start, data, index)
      node = new TreeBuffer(data, end - buffer.start)
      // Wrap if this is a repeat node
      if ((type & TYPE_TAGGED) == 0) node = new Tree([node], [0], type, end - buffer.start)
      startPos = buffer.start - parentStart
    } else { // Make it a node
      let endPos = cursor.pos - size
      cursor.next()
      let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
      while (cursor.pos > endPos)
        takeNode(start, endPos, localChildren, localPositions)
      localChildren.reverse(); localPositions.reverse()
      node = new Tree(localChildren, localPositions, type, end - start)
    }

    children.push(node)
    positions.push(startPos)
    // End of a (possible) sequence of repeating nodes—might need to balance
    if ((type & TYPE_TAGGED) == 0 && (cursor.pos == 0 || cursor.type != type))
      maybeBalanceSiblings(children, positions, type)
  }

  function maybeBalanceSiblings(children: (Tree | TreeBuffer)[], positions: number[], type: number) {
    let to = children.length, from = to - 1
    for (; from > 0; from--) {
      let prev = children[from - 1]
      if (!(prev instanceof Tree) || prev.type != type) break
    }
    if (to - from < BALANCE_BRANCH_FACTOR) return
    let start = positions[to - 1]
    let wrapped = balanceRange(type, children.slice(from, to).reverse(), positions.slice(from, to).reverse(),
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
    // FIXME maxBufferLength is a _length_ not a size
    scan: for (let minPos = fork.pos - maxSize; fork.pos > minPos;) {
      let nodeSize = fork.size, startPos = fork.pos - nodeSize
      let localSkipped = fork.type & TYPE_TAGGED ? 0 : 4
      if (nodeSize == REUSED_VALUE || startPos < minPos || fork.start < minStart || type > -1 && fork.type != type) break
      let nodeStart = fork.start
      fork.next()
      while (fork.pos > startPos) {
        if (fork.size == REUSED_VALUE) break scan
        if ((fork.type & TYPE_TAGGED) == 0) localSkipped += 4
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
    if (type & TYPE_TAGGED) { // Don't copy repeat nodes into buffers
      buffer[--index] = startIndex
      buffer[--index] = end - bufferStart
      buffer[--index] = start - bufferStart
      buffer[--index] = type
    }
    return index
  }

  let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
  while (cursor.pos > 0) takeNode(0, 0, children, positions)
  return new Tree(children.reverse(), positions.reverse())
}

function balanceRange(type: number,
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
    let maxChild = Math.max(maxBufferLength, Math.ceil(length * 1.5 / BALANCE_BRANCH_FACTOR))
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
          only = new Tree([only], [0], type, only.length)
        }
        localChildren.push(only)
      } else {
        localChildren.push(balanceRange(type, children, positions, groupFrom, i, groupStart, maxBufferLength))
      }
      localPositions.push(groupStart - start)
    }
  }
  return new Tree(localChildren, localPositions, type, length)
}

export class TagMap<T> {
  constructor(readonly content: readonly (T | null)[]) {}

  get(type: number): T | null { return type & TYPE_TAGGED ? this.content[type >> 1] : null }

  static empty = new TagMap<any>([])
}
