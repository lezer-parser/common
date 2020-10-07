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
  /// object](#tree.NodeType^match) or function that returns undefined
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

  /// Prop that is used to describe matching delimiters. For opening
  /// delimiters, this holds an array of node names (written as a
  /// space-separated string when declaring this prop in a grammar)
  /// for the node types of closing delimiters that match it.
  static closedBy = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

  /// The inverse of [`openedBy`](#tree.NodeProp^closedBy). This is
  /// attached to closing delimiters, holding an array of node names
  /// of types of matching opening delimiters.
  static openedBy = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

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

/// A cursor object focuses on a given node in a syntax tree, and
/// allows you to move to adjacent nodes.
///
/// **Note:** The interface for the cursor-motion methods
/// (`firstChild`, `nextSibling`, `parent`, `next`, etc) is slightly
/// tricky. When they return null, the original object is unchanged.
/// But when they return a cursor value, there is no guarantee about
/// what happened to the original object—it might be unchanged, or it
/// might be updated and returned as the position, depending on
/// implementation details. So if you want to keep track of a given
/// cursor position, [clone](#tree.TreeCursor.clone) it before moving
/// forward.
export interface TreeCursor {
  /// The node's type
  type: NodeType

  // Shorthand for `.type.name`.
  name: string

  /// The start source offset of this subtree
  start: number

  /// The end source offset
  end: number

  /// The depth (number of named parent nodes) of this node.
  depth: number

  /// The root of the tree that this cursor points into.
  root: Tree

  /// @internal
  toString(): string

  /// Create a copy of this cursor. Can be useful when you need to
  /// keep track of a given node, but also to iterate further from it.
  clone(): TreeCursor

  /// Get the first child of this node, if any. _Might_ (but is not
  /// guaranteed to) mutate the current object. The returned value, if
  /// any, is a cursor pointing at the child.
  firstChild(): TreeCursor | null

  /// Get a cursor pointing at the last child of this node, if any.
  lastChild(): TreeCursor | null

  /// Move to this node's next sibling, if any.
  nextSibling(): TreeCursor | null

  /// Move to this node's previous sibling, if any.
  prevSibling(): TreeCursor | null

  /// Move the node's parent node, if this isn't the top node.
  parent(): TreeCursor | null

  /// Move the cursor to the innermost node that covers `pos`. If
  /// `side` is -1, it will enter nodes that end at `pos`. If it is 1,
  /// it will enter nodes that start at `pos`.
  moveTo(pos: number, side?: -1 | 0 | 1): TreeCursor

  /// Move to the next node in a
  /// [pre-order](https://en.wikipedia.org/wiki/Tree_traversal#Pre-order_(NLR))
  /// traversal, going from a node to its first child or, if the
  /// current node is empty, its next sibling or the next sibling of
  /// the first parent node that has one.
  next(): TreeCursor | null

  /// Move to the next node in a last-to-first pre-order traveral. A
  /// node is followed by ist last child or, if it has none, its
  /// previous sibling or the previous sibling of the first parent
  /// node that has one.
  prev(): TreeCursor | null

  /// @internal
  atLastNode(dir: -1 | 1): boolean
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
/// use the `TreeCursor` interface instead, which provides a view on
/// some part of this data structure, and can be used to move around
/// to adjacent nodes.
export class Tree {
  /// Construct a new tree. You usually want to go through
  /// [`Tree.build`](#tree.Tree^build) instead.
  constructor(
    readonly type: NodeType,
    /// The tree's child nodes. Children small enough to fit in a
    /// `TreeBuffer` will be represented as such, other children can be
    /// further `Tree` instances with their own internal structure.
    readonly children: readonly (Tree | TreeBuffer)[],
    /// The positions (offsets relative to the start of this tree) of
    /// the children.
    readonly positions: readonly number[],
    /// The total length of this tree
    readonly length: number
  ) {}

  /// @internal
  toString(): string {
    let children = this.children.map(c => c.toString()).join()
    return !this.type.name ? children :
      (/\W/.test(this.type.name) && !this.type.prop(NodeProp.error) ? JSON.stringify(this.type.name) : this.type.name) +
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
      let cursor: TreeCursor | null = tree.cursor()
      for (;;) {
        cursor = side < 0 ? cursor.prev() : cursor.next()
        if (!cursor) return side < 0 ? 0 : tree.length
        if ((side < 0 ? cursor.end <= pos : cursor.start >= pos) && !cursor.type.prop(NodeProp.error))
          return side < 0 ? Math.min(pos, cursor.end - 1) : Math.max(pos, cursor.start + 1)
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

  /// Get a [tree cursor](#tree.TreeCursor) rooted at this tree.
  cursor(): TreeCursor { return new NodeCursor(this, 0, 0, null) }

  resolve(pos: number, side: -1 | 0 | 1 = 0): TreeCursor {
    if (cacheRoot == this) return cachedCursor = cachedCursor.clone().moveTo(pos, side)
    scheduleCacheClear()
    cacheRoot = this
    return cachedCursor = this.cursor().moveTo(pos, side)
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

type BuildData = {
  /// The buffer or buffer cursor to read the node data from.
  ///
  /// When this is an array, it should contain four values for every
  /// node in the tree.
  ///
  ///  - The first holds the node's type, as a node ID pointing into
  ///    the given `NodeGroup`.
  ///  - The second holds the node's start offset.
  ///  - The third the end offset.
  ///  - The fourth the amount of space taken up in the array by this
  ///    node and its children. Since there's four values per node,
  ///    this is the total number of nodes inside this node (children
  ///    and transitive children) plus one for the node itself, times
  ///    four.
  ///
  /// Parent nodes should appear _after_ child nodes in the array. As
  /// an example, a node of type 10 spanning positions 0 to 4, with
  /// two children, of type 11 and 12, might look like this:
  ///
  ///     [11, 0, 1, 4, 12, 2, 4, 4, 10, 0, 4, 12]
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

  /// Find the last child at the level starting at `parentStart` that
  /// ends at `pos`. @internal
  childBefore(pos: number, parentStart: number) {
    let buf = this.buffer
    for (let i = parentStart;;) {
      let curEnd = buf[i + 3]
      if (curEnd == pos) return i
      i = curEnd
    }
  }
}

// A tree cursor pointing at a `Tree` node. These form a linked list
// back to the root of the tree, and are not mutated after being
// created (the cursor-motion methods always return a new cursor
// object).
class NodeCursor implements TreeCursor {
  constructor(readonly node: Tree,
              readonly start: number,
              readonly index: number,
              readonly above: NodeCursor | null) {}

  get type() { return this.node.type }

  get name() { return this.node.type.name }

  get end() { return this.start + this.node.length }

  toString() { return this.node.toString() }

  get root() {
    let cur: NodeCursor = this
    while (cur.above) cur = cur.above
    return cur.node
  }

  get depth() {
    let cur: NodeCursor = this, d = 1
    while (cur.above) { if (cur.name) d++; cur = cur.above }
    return d
  }

  clone() { return this }

  nextChild(i: number, dir: 1 | -1): TreeCursor | null {
    for (let {children, positions} = this.node, e = dir > 0 ? children.length : -1; i != e; i += dir) {
      let next = children[i], start = positions[i] + this.start
      if (next instanceof TreeBuffer) {
        return new BufCursor(next, start, i, this, [], dir < 0 ? next.childBefore(next.buffer.length, 0) : 0)
      } else if (next.type.name || hasChild(next)) {
        let inner = new NodeCursor(next, start, i, this)
        return inner.name ? inner : (dir < 0 ? inner.lastChild() : inner.firstChild())
      }
    }
    return this.name || !this.above ? null : this.above.nextChild(this.index + dir, dir)
  }

  firstChild() { return this.nextChild(0, 1) }
  lastChild() { return this.nextChild(this.node.children.length - 1, -1) }

  nextSibling() { return this.above ? this.above.nextChild(this.index + 1, 1) : null }
  prevSibling() { return this.above ? this.above.nextChild(this.index - 1, -1) : null }

  parent() {
    let parent = this.above
    while (parent && !parent.name) parent = parent.above
    return parent
  }

  next() { return cursorNext(this, 1) }
  prev() { return cursorNext(this, -1) }

  moveTo(pos: number, side: -1 | 0 | 1 = 0) { return moveCursor(this, pos, side) }

  isLastNode(index: number, dir: -1 | 1) {
    for (let parent: NodeCursor | null = this; parent; {index, above: parent} = parent) {
      for (let i = index + dir, e = dir < 0 ? -1 : parent.node.children.length; i != e; i += dir) {
        let child = parent.node.children[i]
        if (child.type.name || child instanceof TreeBuffer || hasChild(child)) return false
      }
    }
    return true
  }

  atLastNode(dir: -1 | 1) {
    return this.above ? this.above.isLastNode(this.index, dir) : true
  }
}

// A cursor position in a TreeBuffer. These are mutable, for
// performance reasons, and update as they move. Not to be confused
// with the exported interface `BufferCursor`, which serves an
// entirely different role.
class BufCursor implements TreeCursor {
  index!: number
  type!: NodeType
  start!: number
  end!: number

  constructor(readonly buffer: TreeBuffer,
              readonly bufferStart: number,
              readonly parentIndex: number,
              readonly above: NodeCursor,
              readonly stack: number[],
              index: number) {
    this.goto(index)
  }

  private goto(index: number) {
    this.index = index
    let {buffer} = this.buffer
    this.type = this.buffer.group.types[buffer[index]]
    this.start = this.bufferStart + buffer[index + 1]
    this.end = this.bufferStart + buffer[index + 2]
    return this
  }

  get name() { return this.type.name }

  toString() {
    let result: string[] = []
    this.buffer.childToString(this.index, result)
    return result.join("")
  }

  get root() { return this.above.root }

  get depth() { return this.above.depth + this.stack.length }

  clone() {
    return new BufCursor(this.buffer, this.bufferStart, this.parentIndex, this.above, this.stack.slice(), this.index)
  }

  private enter(dir: -1 | 1) {
    let nodeStart = this.index + 4, nodeEnd = this.buffer.buffer[this.index + 3]
    if (nodeStart == nodeEnd) return null
    this.stack.push(this.index)
    return this.goto(dir < 0 ? this.buffer.childBefore(nodeEnd, nodeStart) : nodeStart)
  }

  firstChild() { return this.enter(1) }
  lastChild() { return this.enter(-1) }

  private sibling(dir: 1 | -1) {
    let d = this.stack.length - 1
    if (dir < 0) {
      let parentStart = d < 0 ? 0 : this.stack[d] + 4
      if (this.index != parentStart)
        return this.goto(this.buffer.childBefore(this.index, parentStart))
    } else {
      let {buffer} = this.buffer, after = buffer[this.index + 3]
      if (after < (d < 0 ? buffer.length : buffer[this.stack[d] + 3]))
        return this.goto(after)
    }
    return d >= 0 ? null : this.above.nextChild(this.parentIndex + dir, dir)
  }

  nextSibling() { return this.sibling(1) }

  prevSibling() { return this.sibling(-1) }

  parent() {
    return this.stack.length ? this.goto(this.stack.pop()!) : this.above.name ? this.above : this.above.parent()
  }

  next() { return cursorNext(this, 1) }
  prev() { return cursorNext(this, -1) }

  moveTo(pos: number, side: -1 | 0 | 1 = 0) { return moveCursor(this, pos, side) }

  atLastNode(dir: 1 | -1) {
    if (dir > 0) {
      if (this.index < this.buffer.buffer.length) return false
    } else {
      for (let i = 0; i < this.index; i++) if (this.buffer.buffer[i + 3] < this.index) return false
    }
    return this.above.atLastNode(dir)
  }
}

function moveCursor(cursor: TreeCursor, pos: number, side: -1 | 0 | 1) {
  // Move up to a node that actually holds the position, if possible
  while ((side < 1 ? cursor.start >= pos : cursor.start > pos) ||
         (side > -1 ? cursor.end <= pos : cursor.end < pos)) {
    let above = cursor.parent()
    if (!above) break
    cursor = above
  }

  // Then scan down into child nodes as far as possible
  enter: for (;;) {
    let next = cursor.firstChild()
    if (!next) return cursor
    do {
      cursor = next
      if (side < 1 ? cursor.start >= pos : cursor.start > pos) break
      if (side > -1 ? cursor.end > pos : cursor.end >= pos)
        continue enter
    } while (next = cursor.nextSibling())
    cursor = cursor.parent()!
    break
  }
  return cursor
}

function cursorNext(cursor: TreeCursor, dir: -1 | 1) {
  let inner = dir < 0 ? cursor.lastChild() : cursor.firstChild()
  if (inner) return inner
  for (;;) {
    let sibling = dir < 0 ? cursor.prevSibling() : cursor.nextSibling()
    if (sibling) return sibling
    if (cursor.atLastNode(dir)) return null
    let parent = cursor.parent()
    if (!parent) return null
    cursor = parent
  }
}

function hasChild(tree: Tree): boolean {
  return tree.children.some(ch => ch.type.name || ch instanceof TreeBuffer || hasChild(ch))
}

const emptyCursor = new NodeCursor(Tree.empty, 0, 0, null)

// Top-level `resolve` calls store their last result here, so that
// if the next call is near the last, parent trees can be cheaply
// reused.
let cacheRoot: Tree = Tree.empty
let cachedCursor: TreeCursor = emptyCursor

let scheduledCacheClear = false

function scheduleCacheClear() {
  if (!scheduledCacheClear) {
    let value = setTimeout(clearCache, 3000) as any
    if (typeof value == "object" && value.unref) value.unref()
  }
}

function clearCache() {
  scheduledCacheClear = false
  cacheRoot = Tree.empty
  cachedCursor = emptyCursor
}

/// This is used by `Tree.build` as an abstraction for iterating over
/// a tree buffer. A cursor initially points at the very last element
/// in the buffer. Every time `next()` is called it moves on to the
/// previous one.
export interface BufferCursor {
  /// The current buffer position (four times the number of nodes
  /// remaining).
  pos: number
  /// The node ID of the next node in the buffer.
  id: number
  /// The start position of the next node in the buffer.
  start: number
  /// The end position of the next node.
  end: number
  /// The size of the next node (the number of nodes inside, counting
  /// the node itself, times 4).
  size: number
  /// Moves `this.pos` down by 4.
  next(): void
  /// Create a copy of this cursor.
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
  function takeNode(parentStart: number, minPos: number,
                    children: (Tree | TreeBuffer)[], positions: number[],
                    inRepeat: number) {
    let {id, start, end, size} = cursor
    while (id == inRepeat) { cursor.next(); ({id, start, end, size} = cursor) }

    let startPos = start - parentStart
    if (size < 0) { // Reused node
      children.push(reused[id])
      positions.push(startPos)
      cursor.next()
      return
    }

    let type = types[id], node, buffer: {size: number, start: number, skip: number} | undefined
    if (end - start <= maxBufferLength && (buffer = findBufferSize(cursor.pos - minPos, inRepeat))) {
      // Small enough for a buffer, and no reused nodes inside
      let data = new Uint16Array(buffer.size - buffer.skip)
      let endPos = cursor.pos - buffer.size, index = data.length
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer.start, data, index, inRepeat)
      node = new TreeBuffer(data, end - buffer.start, group, inRepeat < 0 ? NodeType.none : types[inRepeat])
      startPos = buffer.start - parentStart
    } else { // Make it a node
      let endPos = cursor.pos - size
      cursor.next()
      let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
      let localInRepeat = id >= minRepeatType ? id : -1
      while (cursor.pos > endPos)
        takeNode(start, endPos, localChildren, localPositions, localInRepeat)
      localChildren.reverse(); localPositions.reverse()

      if (localInRepeat > -1 && localChildren.length > BalanceBranchFactor)
        node = balanceRange(type, type, localChildren, localPositions, 0, localChildren.length, 0, maxBufferLength, end - start)
      else
        node = new Tree(type, localChildren, localPositions, end - start)
    }

    children.push(node)
    positions.push(startPos)
  }

  function findBufferSize(maxSize: number, inRepeat: number) {
    // Scan through the buffer to find previous siblings that fit
    // together in a TreeBuffer, and don't contain any reused nodes
    // (which can't be stored in a buffer).
    // If `inRepeat` is > -1, ignore node boundaries of that type for
    // nesting, but make sure the end falls either at the start
    // (`maxSize`) or before such a node.
    let fork = cursor.fork()
    let size = 0, start = 0, skip = 0, minStart = fork.end - maxBufferLength
    let result = {size: 0, start: 0, skip: 0}
    scan: for (let minPos = fork.pos - maxSize; fork.pos > minPos;) {
      // Pretend nested repeat nodes of the same type don't exist
      if (fork.id == inRepeat) {
        // Except that we store the current state as a valid return
        // value.
        result.size = size; result.start = start; result.skip = skip
        skip += 4; size += 4
        fork.next()
        continue
      }
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
    if (inRepeat < 0 || size == maxSize) {
      result.size = size; result.start = start; result.skip = skip
    }
    return result.size > 4 ? result : undefined
  }

  function copyToBuffer(bufferStart: number, buffer: Uint16Array, index: number, inRepeat: number): number {
    let {id, start, end, size} = cursor
    cursor.next()
    if (id == inRepeat) return index
    let startIndex = index
    if (size > 4) {
      let endPos = cursor.pos - (size - 4)
      while (cursor.pos > endPos)
        index = copyToBuffer(bufferStart, buffer, index, inRepeat)
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
  while (cursor.pos > 0) takeNode(0, 0, children, positions, -1)
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
                                 maxBufferLength, positions[i - 1] + children[i - 1].length - groupStart)
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
