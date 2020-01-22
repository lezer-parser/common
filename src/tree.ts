/// The default maximum length of a `TreeBuffer` node.
export const DefaultBufferLength = 1024

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

type EnterFunc<T> = (type: NodeType, start: number, end: number) => T | false | undefined

type LeaveFunc = (type: NodeType, start: number, end: number) => void

/// Passed to `Subtree.iterate`.
type IterateArgs<T> = {
  /// The function called when entering a node. It is given a node's
  /// type, start position, and end position, and can return...
  ///
  ///  * `undefined` to proceed iterating as normal.
  ///
  ///  * `false` to not further iterate this node, but continue
  ///    iterating nodes after it.
  ///
  ///  * Any other value to immediately stop iteration and return that
  ///    value from the `iterate` method.
  enter: EnterFunc<T>,
  /// The function to be called when leaving a node.
  leave?: LeaveFunc,
  /// The position in the tree to start iterating. All nodes that
  /// overlap with this position (including those that start/end
  /// directly at it) are included in the iteration. Defaults to the
  /// start of the subtree.
  from?: number,
  /// The position in the tree to iterate towards. May be less than
  /// `from` to perform a reverse iteration. Defaults to the end of
  /// the subtree.
  to?: number
}

class Iteration<T> {
  result: T | undefined = undefined

  constructor(readonly enter: EnterFunc<T>,
              readonly leave: LeaveFunc | undefined) {}

  get done() { return this.result !== undefined }

  doEnter(type: NodeType, start: number, end: number) {
    let value = this.enter(type, start, end)
    if (value === undefined) return true
    if (value !== false) this.result = value
    return false
  }
}

let nextPropID = 0

/// Each [node type](#tree.NodeType) can have metadata associated with
/// it in props. Instances of this class represent prop names.
export class NodeProp<T> {
  /// @internal
  id: number

  /// A method that deserializes a value of this prop from a string.
  /// Can be used to allow a prop to be directly written in a grammar
  /// file. Defaults to raising an error.
  deserialize: (str: string) => T

  /// Create a new node prop type. You can optionally pass a
  /// `deserialize` function.
  constructor({deserialize}: {deserialize?: (str: string) => T} = {}) {
    this.id = nextPropID++
    this.deserialize = deserialize || (() => {
      throw new Error("This node type doesn't define a deserialize function")
    })
  }

  /// Create a string-valued node prop whose deserialize function is
  /// the identity function.
  static string() { return new NodeProp<string>({deserialize: str => str}) }

  /// Create a number-valued node prop whose deserialize function is
  /// just `Number`.
  static number() { return new NodeProp<number>({deserialize: Number}) }

  /// Creates a boolean-valued node prop whose deserialize function
  /// returns true for any input.
  static flag() { return new NodeProp<boolean>({deserialize: () => true}) }

  /// Store a value for this prop in the given object. This can be
  /// useful when building up a prop object to pass to the
  /// [`NodeType`](#tree.NodeType) constructor. Returns its first
  /// argument.
  set(propObj: {[prop: number]: any}, value: T) {
    propObj[this.id] = value
    return propObj
  }

  /// This is meant to be used with
  /// [`NodeGroup.extend`](#tree.NodeGroup.extend) or
  /// [`Parser.withProps`](#lezer.Parser.withProps) to compute prop
  /// values for each node type in the group. Takes a [match
  /// object](#tree.NodeType.match) or function that returns undefined
  /// if the node type doesn't get this prop, and the prop's value if
  /// it does.
  add(match: {[selector: string]: T} | ((type: NodeType) => T | undefined)): NodePropSource {
    return new NodePropSource(this, typeof match == "function" ? match : NodeType.match(match))
  }

  /// The special node type that the parser uses to represent parse
  /// errors has this flag set. (You shouldn't use it for custom nodes
  /// that represent erroneous content.)
  static error = NodeProp.flag()

  /// Nodes that were produced by skipped expressions (such as
  /// comments) have this prop set to true.
  static skipped = NodeProp.flag()

  /// Prop that is used to describe a rule's delimiters. For example,
  /// a parenthesized expression node would set this to the string `"(
  /// )"` (the open and close strings separated by a space). This is
  /// added by the parser generator's `@detectDelim` feature, but you
  /// can also manually add them.
  static delim = NodeProp.string()

  /// Indicates that this node indicates a top level document.
  static top = NodeProp.flag()
}

/// Type returned by [`NodeProp.add`](#tree.NodeProp.add). Describes
/// the way a prop should be added to each node type in a node group.
export class NodePropSource {
  /// @internal
  constructor(
    /// @internal
    readonly prop: NodeProp<any>,
    /// @internal
    readonly f: (type: NodeType) => any) {}
}

/// Each node in a syntax tree has a node type associated with it.
export class NodeType {
  /// @internal
  constructor(
    /// The name of the node type. Not necessarily unique, but if the
    /// grammar was written properly, different node types with the
    /// same name within a node group should play the same semantic
    /// role.
    readonly name: string,
    /// @internal
    readonly props: {readonly [prop: number]: any},
    /// The id of this node in its group. Corresponds to the term ids
    /// used in the parser.
    readonly id: number) {}

  /// Retrieves a node prop for this type. Will return `undefined` if
  /// the prop isn't present on this node.
  prop<T>(prop: NodeProp<T>): T | undefined { return this.props[prop.id] }

  /// An empty dummy node type to use when no actual type is available.
  static none: NodeType = new NodeType("", Object.create(null), 0)

  /// Create a function from node types to arbitrary values by
  /// specifying an object whose property names are node names. Often
  /// useful with [`NodeProp.add`](#tree.NodeProp.add). You can put
  /// multiple node names, separated by spaces, in a single property
  /// name to map multiple node names to a single value.
  static match<T>(map: {[selector: string]: T}): (node: NodeType) => T | undefined {
    let direct = Object.create(null)
    for (let prop in map)
      for (let name of prop.split(" ")) direct[name] = map[prop]
    return (node: NodeType) => direct[node.name]
  }
}

/// A node group holds a collection of node types. It is used to
/// compactly represent trees by storing their type ids, rather than a
/// full pointer to the type object, in a number array. Each parser
/// [has](#lezer.Parser.group) a node group, and [tree
/// buffers](#tree.TreeBuffer) can only store collections of nodes
/// from the same group. A group can have a maximum of 2**16 (65536)
/// node types in it, so that the ids fit into 16-bit typed array
/// slots.
export class NodeGroup {
  /// Create a group with the given types. The `id` property of each
  /// type should correspond to its position within the array.
  constructor(
    /// The node types in this group, by id.
    readonly types: readonly NodeType[]
  ) {
    for (let i = 0; i < types.length; i++) if (types[i].id != i)
      throw new RangeError("Node type ids should correspond to array positions when creating a node group")
  }

  /// Create a copy of this group with some node properties added. The
  /// arguments to this method should be created with
  /// [`NodeProp.add`](#tree.NodeProp.add).
  extend(...props: NodePropSource[]): NodeGroup {
    let newTypes: NodeType[] = []
    for (let type of this.types) {
      let newProps = null
      for (let source of props) {
        let value = source.f(type)
        if (value !== undefined) {
          if (!newProps) {
            newProps = Object.create(null)
            for (let prop in type.props) newProps[prop] = type.props[prop]
          }
          newProps[source.prop.id] = value
        }
      }
      newTypes.push(newProps ? new NodeType(type.name, newProps, type.id) : type)
    }
    return new NodeGroup(newTypes)
  }
}

/// A subtree is a representation of part of the syntax tree. It may
/// either be the tree root, or a tagged node.
export abstract class Subtree {
  /// The subtree's parent. Will be `null` for the root node
  abstract parent: Subtree | null

  /// The node's type
  abstract type: NodeType
  // Shorthand for `.type.name`.
  get name() { return this.type.name }
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
  /// tree in, calling `args.enter` for each node it enters and, if
  /// given, `args.leave` when it leaves a node.
  abstract iterate<T = any>(args: IterateArgs<T>): T | undefined

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
    /// @internal
    readonly type: NodeType,
    /// The tree's child nodes. Children small enough to fit in a
    /// `TreeBuffer` will be represented as such, other children can be
    /// further `Tree` instances with their own internal structure.
    readonly children: readonly (Tree | TreeBuffer)[],
    /// The positions (offsets relative to the start of this tree) of
    /// the children.
    readonly positions: readonly number[],
    /// The total length of this tree @internal
    readonly length: number
  ) {
    super()
  }

  /// @internal
  get start() { return 0 }

  /// @internal
  get end() { return this.length }

  /// @internal
  toString(): string {
    let children = this.children.map(c => c.toString()).join()
    return !this.name ? children :
      (/\W/.test(this.name) && !this.type.prop(NodeProp.error) ? JSON.stringify(this.name) : this.name) +
      (children.length ? "(" + children + ")" : "")
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
      let found = -1
      tree.iterate({
        from: pos,
        to: side < 0 ? 0 : tree.length,
        enter() { return found < 0 ? undefined : false },
        leave(type, start, end) {
          if (found < 0 && !type.prop(NodeProp.error))
            found = side < 0 ? Math.min(pos, end - 1) : Math.max(pos, start + 1)
        }
      })
      return found > -1 ? found : side < 0 ? 0 : tree.length
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
    return new Tree(NodeType.none, children, positions, this.length + off)
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
    return new Tree(this.type, children, positions, at)
  }

  /// The empty tree
  static empty = new Tree(NodeType.none, [], [], 0)

  /// @internal
  iterate<T = any>({from = this.start, to = this.end, enter, leave}: IterateArgs<T>) {
    let iter = new Iteration(enter, leave)
    this.iterInner(from, to, 0, iter)
    return iter.result
  }

  /// @internal
  iterInner<T>(from: number, to: number, offset: number, iter: Iteration<T>) {
    if (this.type.name && !iter.doEnter(this.type, offset, offset + this.length))
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
    if (iter.leave && this.type.name) iter.leave(this.type, offset, offset + this.length)
    return
  }

  /// @internal
  resolveAt(pos: number): Subtree {
    if (cacheRoot == this) {
      for (let tree = cached;;) {
        let next = tree.parent
        if (!next) break
        if (tree.start < pos && tree.end > pos) return tree.resolve(pos)
        tree = next
      }
    }
    cacheRoot = this
    return cached = this.resolveInner(pos, 0, this)
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
          if (child.type.name) return new NodeSubtree(child, childStart, parent)
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
    return new Tree(this.type, this.children.concat(other.children), this.positions.concat(other.positions), other.length)
  }

  /// Balance the direct children of this tree.
  balance(maxBufferLength = DefaultBufferLength) {
    return this.children.length <= BalanceBranchFactor ? this
      : balanceRange(this.type, NodeType.none, this.children, this.positions, 0, this.children.length, 0,
                     maxBufferLength, this.length)
  }

  /// Build a tree from a postfix-ordered buffer of node information,
  /// or a cursor over such a buffer.
  static build(data: BuildData) { return buildTree(data) }
}

Tree.prototype.parent = null

/// Options passed to [`Tree.build`](#tree.Tree^build).
export type BuildData = {
  /// The buffer or buffer cursor to read the node data from.
  buffer: BufferCursor | readonly number[],
  /// The node types to use.
  group: NodeGroup,
  /// The id of the top node type, if any.
  topID?: number,
  /// The maximum buffer length to use. Defaults to
  /// [`DefaultBufferLength`](#tree.DefaultBufferLength).
  maxBufferLength?: number,
  /// An optional set of reused nodes that the buffer can refer to.
  reused?: (Tree | TreeBuffer)[],
  /// The first node type that indicates repeat constructs in this
  /// grammar.
  minRepeatType?: number
}

// Top-level `resolveAt` calls store their last result here, so that
// if the next call is near the last, parent trees can be cheaply
// reused.
let cacheRoot: Tree = Tree.empty
let cached: Subtree = Tree.empty

/// Tree buffers contain (type, start, end, endIndex) quads for each
/// node. In such a buffer, nodes are stored in prefix order (parents
/// before children, with the endIndex of the parent indicating which
/// children belong to it)
export class TreeBuffer {
  /// Create a tree buffer @internal
  constructor(
    /// @internal
    readonly buffer: Uint16Array,
    // The total length of the group of nodes in the buffer.
    readonly length: number,
    /// @internal
    readonly group: NodeGroup,
    /// An optional type tag, used to tag a buffer as being part of a
    /// repetition @internal
    readonly type = NodeType.none
  ) {}

  /// @internal
  toString() {
    let parts: string[] = []
    for (let index = 0; index < this.buffer.length;)
      index = this.childToString(index, parts)
    return parts.join(",")
  }

  /// @internal
  childToString(index: number, parts: string[]): number {
    let id = this.buffer[index], endIndex = this.buffer[index + 3]
    let type = this.group.types[id], result = type.name
    if (/\W/.test(result) && !type.prop(NodeProp.error)) result = JSON.stringify(result)
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
    return new TreeBuffer(newBuffer, Math.min(at, this.length), this.group)
  }

  iterate<T = any>({from = 0, to = this.length, enter, leave}: IterateArgs<T>): T | undefined {
    let iter = new Iteration(enter, leave)
    this.iterInner(from, to, 0, iter)
    return iter.result
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
    let type = this.group.types[this.buffer[index++]], start = this.buffer[index++] + offset,
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
        let id = this.buffer[base], start = this.buffer[base + 1] + offset, end = this.buffer[base + 2] + offset
        takeNext()
        if (start <= from && end >= to) {
          if (!iter.doEnter(this.group.types[id], start, end)) {
            // Skip the entire node
            index = base
            while (nextEnd > base) takeNext()
            continue run
          }
        }
      }
      let endIndex = this.buffer[--index], end = this.buffer[--index] + offset,
        start = this.buffer[--index] + offset, id = this.buffer[--index]
      if (start > from || end < to) continue
      if ((endIndex != index + 4 || iter.doEnter(this.group.types[id], start, end)) && iter.leave)
        iter.leave(this.group.types[id], start, end)
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

  toString() { return this.node.toString() }

  iterate<T = any>({from = this.start, to = this.end, enter, leave}: IterateArgs<T>) {
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

  get type() { return this.buffer.group.types[this.buffer.buffer[this.index]] }
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

  iterate<T = any>({from = this.start, to = this.end, enter, leave}: IterateArgs<T>) {
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
/// a tree buffer.
export interface BufferCursor {
  pos: number
  id: number
  start: number
  end: number
  size: number
  next(): void
  fork(): BufferCursor
}

class FlatBufferCursor implements BufferCursor {
  constructor(readonly buffer: readonly number[], public index: number) {}

  get id() { return this.buffer[this.index - 4] }
  get start() { return this.buffer[this.index - 3] }
  get end() { return this.buffer[this.index - 2] }
  get size() { return this.buffer[this.index - 1] }

  get pos() { return this.index }

  next() { this.index -= 4 }

  fork() { return new FlatBufferCursor(this.buffer, this.index) }
}

const BalanceBranchFactor = 8

function buildTree(data: BuildData) {
  let {buffer, group, topID = 0,
       maxBufferLength = DefaultBufferLength,
       reused = [],
       minRepeatType = group.types.length} = data as BuildData
  let cursor = Array.isArray(buffer) ? new FlatBufferCursor(buffer, buffer.length) : buffer as BufferCursor
  let types = group.types
  function takeNode(parentStart: number, minPos: number, children: (Tree | TreeBuffer)[], positions: number[],
                    tagBuffer: NodeType) {
    let {id, start, end, size} = cursor, buffer!: {size: number, start: number, skip: number} | null
    let startPos = start - parentStart
    if (size < 0) { // Reused node
      children.push(reused[id])
      positions.push(startPos)
      cursor.next()
      return
    }

    let type = types[id], node
    if (end - start <= maxBufferLength && (buffer = findBufferSize(cursor.pos - minPos))) {
      // Small enough for a buffer, and no reused nodes inside
      let data = new Uint16Array(buffer.size - buffer.skip)
      let endPos = cursor.pos - buffer.size, index = data.length
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer.start, data, index)
      node = new TreeBuffer(data, end - buffer.start, group, tagBuffer)
      startPos = buffer.start - parentStart
    } else { // Make it a node
      let endPos = cursor.pos - size
      cursor.next()
      let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
      // Check if this is a repeat wrapper. Store the id of the inner
      // repeat node in the variable if it is
      let repeating = id >= group.types.length ? id - (group.types.length - minRepeatType) : -1
      if (repeating > -1) {
        type = types[repeating]
        while (cursor.pos > endPos) {
          let isRepeat = cursor.id == repeating // This starts with an inner repeated node
          takeNode(start, endPos, localChildren, localPositions, isRepeat ? type : NodeType.none)
        }
      } else {
        while (cursor.pos > endPos)
          takeNode(start, endPos, localChildren, localPositions, NodeType.none)
      }
      localChildren.reverse(); localPositions.reverse()

      if (repeating > -1 && localChildren.length > BalanceBranchFactor)
        node = balanceRange(type, type, localChildren, localPositions, 0, localChildren.length, 0, maxBufferLength, end - start)
      else
        node = new Tree(type, localChildren, localPositions, end - start)
    }

    children.push(node)
    positions.push(startPos)
  }

  function findBufferSize(maxSize: number) {
    // Scan through the buffer to find previous siblings that fit
    // together in a TreeBuffer, and don't contain any reused nodes
    // (which can't be stored in a buffer)
    // If `type` is > -1, only include siblings with that same type
    // (used to group repeat content into a buffer)
    let fork = cursor.fork()
    let size = 0, start = 0, skip = 0, minStart = fork.end - maxBufferLength
    scan: for (let minPos = fork.pos - maxSize; fork.pos > minPos;) {
      let nodeSize = fork.size, startPos = fork.pos - nodeSize
      if (nodeSize < 0 || startPos < minPos || fork.start < minStart) break
      let localSkipped = fork.id >= minRepeatType ? 4 : 0
      let nodeStart = fork.start
      fork.next()
      while (fork.pos > startPos) {
        if (fork.size < 0) break scan
        if (fork.id >= minRepeatType) localSkipped += 4
        fork.next()
      }
      start = nodeStart
      size += nodeSize
      skip += localSkipped
    }
    return size > 4 ? {size, start, skip} : null
  }

  function copyToBuffer(bufferStart: number, buffer: Uint16Array, index: number): number {
    let {id, start, end, size} = cursor
    cursor.next()
    let startIndex = index
    if (size > 4) {
      let endPos = cursor.pos - (size - 4)
      while (cursor.pos > endPos)
        index = copyToBuffer(bufferStart, buffer, index)
    }
    if (id < minRepeatType) { // Don't copy repeat nodes into buffers
      buffer[--index] = startIndex
      buffer[--index] = end - bufferStart
      buffer[--index] = start - bufferStart
      buffer[--index] = id
    }
    return index
  }

  let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
  while (cursor.pos > 0) takeNode(0, 0, children, positions, NodeType.none)
  let length = children.length ? positions[0] + children[0].length : 0
  return new Tree(group.types[topID], children.reverse(), positions.reverse(), length)
}

function balanceRange(outerType: NodeType, innerType: NodeType,
                      children: readonly (Tree | TreeBuffer)[], positions: readonly number[],
                      from: number, to: number,
                      start: number, maxBufferLength: number, length: number): Tree {
  let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
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
        if (only instanceof Tree && only.type == innerType && only.length > maxChild << 1) { // Too big, collapse
          for (let j = 0; j < only.children.length; j++) {
            localChildren.push(only.children[j])
            localPositions.push(only.positions[j] + groupStart - start)
          }
          continue
        }
        localChildren.push(only)
      } else if (i == groupFrom + 1) {
        localChildren.push(children[groupFrom])
      } else {
        let inner = balanceRange(innerType, innerType, children, positions, groupFrom, i, groupStart,
                                 maxBufferLength, positions[i - 1] - groupStart)
        if (innerType != NodeType.none && !containsType(inner.children, innerType))
          inner = new Tree(NodeType.none, inner.children, inner.positions, inner.length)
        localChildren.push(inner)
      }
      localPositions.push(groupStart - start)
    }
  }
  return new Tree(outerType, localChildren, localPositions, length)
}

function containsType(nodes: readonly (Tree | TreeBuffer)[], type: NodeType) {
  for (let elt of nodes) if (elt.type == type) return true
  return false
}
