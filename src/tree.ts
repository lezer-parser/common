/// The default maximum length of a `TreeBuffer` node.
export const DefaultBufferLength = 1024

let nextPropID = 0

const CachedNode = new WeakMap<Tree, TreeNode>()

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
  /// [`NodeSet.extend`](#tree.NodeSet.extend) or
  /// [`Parser.withProps`](#lezer.Parser.withProps) to compute prop
  /// values for each node type in the set. Takes a [match
  /// object](#tree.NodeType^match) or function that returns undefined
  /// if the node type doesn't get this prop, and the prop's value if
  /// it does.
  add(match: {[selector: string]: T} | ((type: NodeType) => T | undefined)): NodePropSource {
    if (typeof match != "function") match = NodeType.match(match)
    return (type) => {
      let result = (match as (type: NodeType) => T | undefined)(type)
      return result === undefined ? null : [this, result]
    }
  }

  /// Prop that is used to describe matching delimiters. For opening
  /// delimiters, this holds an array of node names (written as a
  /// space-separated string when declaring this prop in a grammar)
  /// for the node types of closing delimiters that match it.
  static closedBy = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

  /// The inverse of [`openedBy`](#tree.NodeProp^closedBy). This is
  /// attached to closing delimiters, holding an array of node names
  /// of types of matching opening delimiters.
  static openedBy = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

  /// Used to assign node types to groups (for example, all node
  /// types that represent an expression could be tagged with an
  /// `"Expression"` group).
  static group = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})
}

/// Type returned by [`NodeProp.add`](#tree.NodeProp.add). Describes
/// the way a prop should be added to each node type in a node set.
export type NodePropSource = (type: NodeType) => null | [NodeProp<any>, any]

// Note: this is duplicated in lezer/src/constants.ts
const enum NodeFlag {
  Top = 1,
  Skipped = 2,
  Error = 4,
  Anonymous = 8
}

const noProps: {[propID: number]: any} = Object.create(null)

/// Each node in a syntax tree has a node type associated with it.
export class NodeType {
  /// @internal
  constructor(
    /// The name of the node type. Not necessarily unique, but if the
    /// grammar was written properly, different node types with the
    /// same name within a node set should play the same semantic
    /// role.
    readonly name: string,
    /// @internal
    readonly props: {readonly [prop: number]: any},
    /// The id of this node in its set. Corresponds to the term ids
    /// used in the parser.
    readonly id: number,
    /// @internal
    readonly flags: number = 0) {}

  static define(spec: {
    /// The ID of the node type. When this type is used in a
    /// [set](#tree.NodeSet), the ID must correspond to its index in
    /// the type array.
    id: number, 
    /// The name of the node type. Leave empty to define an anonymous
    /// node.
    name?: string,
    /// [Node props](#tree.NodeProp) to assign to the type. The value
    /// given for any given prop should correspond to the prop's type.
    props?: readonly ([NodeProp<any>, any] | NodePropSource)[],
    /// Whether is is a [top node](#tree.NodeType.isTop).
    top?: boolean,
    /// Whether this node counts as an [error
    /// node](#tree.NodeType.isError).
    error?: boolean,
    /// Whether this node is a [skipped](#tree.NodeType.isSkipped)
    /// node.
    skipped?: boolean
  }) {
    let props = spec.props && spec.props.length ? Object.create(null) : noProps
    let flags = (spec.top ? NodeFlag.Top : 0) | (spec.skipped ? NodeFlag.Skipped : 0) |
      (spec.error ? NodeFlag.Error : 0) | (spec.name == null ? NodeFlag.Anonymous : 0)
    let type = new NodeType(spec.name || "", props, spec.id, flags)
    if (spec.props) for (let src of spec.props) {
      if (!Array.isArray(src)) src = src(type)!
      if (src) src[0].set(props, src[1])
    }
    return type
  }

  /// Retrieves a node prop for this type. Will return `undefined` if
  /// the prop isn't present on this node.
  prop<T>(prop: NodeProp<T>): T | undefined { return this.props[prop.id] }

  /// True when this is the top node of a grammar.
  get isTop() { return (this.flags & NodeFlag.Top) > 0 }

  /// True when this node is produced by a skip rule.
  get isSkipped() { return (this.flags & NodeFlag.Skipped) > 0 }

  /// Indicates whether this is an error node.
  get isError() { return (this.flags & NodeFlag.Error) > 0 }

  /// When true, this node type doesn't correspond to a user-declared
  /// named node, for example because it is used to cache repetition.
  get isAnonymous() { return (this.flags & NodeFlag.Anonymous) > 0 }

  /// Returns true when this node's name or one of its
  /// [groups](#tree.NodeProp^group) matches the given string.
  is(name: string | number) {
    if (typeof name == 'string') {
      if (this.name == name) return true
      let group = this.prop(NodeProp.group)
      return group ? group.indexOf(name) > -1 : false
    }
    return this.id == name
  }

  /// An empty dummy node type to use when no actual type is available.
  static none: NodeType = new NodeType("", Object.create(null), 0, NodeFlag.Anonymous)

  /// Create a function from node types to arbitrary values by
  /// specifying an object whose property names are node or
  /// [group](#tree.NodeProp^group) names. Often useful with
  /// [`NodeProp.add`](#tree.NodeProp.add). You can put multiple
  /// names, separated by spaces, in a single property name to map
  /// multiple node names to a single value.
  static match<T>(map: {[selector: string]: T}): (node: NodeType) => T | undefined {
    let direct = Object.create(null)
    for (let prop in map)
      for (let name of prop.split(" ")) direct[name] = map[prop]
    return (node: NodeType) => {
      for (let groups = node.prop(NodeProp.group), i = -1; i < (groups ? groups.length : 0); i++) {
        let found = direct[i < 0 ? node.name : groups![i]]
        if (found) return found
      }
    }
  }
}

/// A node set holds a collection of node types. It is used to
/// compactly represent trees by storing their type ids, rather than a
/// full pointer to the type object, in a number array. Each parser
/// [has](#lezer.Parser.nodeSet) a node set, and [tree
/// buffers](#tree.TreeBuffer) can only store collections of nodes
/// from the same set. A set can have a maximum of 2**16 (65536)
/// node types in it, so that the ids fit into 16-bit typed array
/// slots.
export class NodeSet {
  /// Create a set with the given types. The `id` property of each
  /// type should correspond to its position within the array.
  constructor(
    /// The node types in this set, by id.
    readonly types: readonly NodeType[]
  ) {
    for (let i = 0; i < types.length; i++) if (types[i].id != i)
      throw new RangeError("Node type ids should correspond to array positions when creating a node set")
  }

  /// Create a copy of this set with some node properties added. The
  /// arguments to this method should be created with
  /// [`NodeProp.add`](#tree.NodeProp.add).
  extend(...props: NodePropSource[]): NodeSet {
    let newTypes: NodeType[] = []
    for (let type of this.types) {
      let newProps = null
      for (let source of props) {
        let add = source(type)
        if (add) {
          if (!newProps) newProps = Object.assign({}, type.props)
          add[0].set(newProps, add[1])
        }
      }
      newTypes.push(newProps ? new NodeType(type.name, newProps, type.id, type.flags) : type)
    }
    return new NodeSet(newTypes)
  }
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
    /// `TreeBuffer will be represented as such, other children can be
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
      (/\W/.test(this.type.name) && !this.type.isError ? JSON.stringify(this.type.name) : this.type.name) +
      (children.length ? "(" + children + ")" : "")
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

  /// Get a [tree cursor](#tree.TreeCursor) rooted at this tree. When
  /// `pos` is given, the cursor is [moved](#tree.TreeCursor.moveTo)
  /// to the given position and side.
  cursor(pos?: number, side: -1 | 0 | 1 = 0): TreeCursor {
    let scope = (pos != null && CachedNode.get(this)) || (this.topNode as TreeNode)
    let cursor = new TreeCursor(scope)
    if (pos != null) {
      cursor.moveTo(pos, side)
      CachedNode.set(this, cursor._tree)
    }
    return cursor
  }

  /// Get a [tree cursor](#tree.TreeCursor) that, unlike regular
  /// cursors, doesn't skip [anonymous](#tree.NodeType.isAnonymous)
  /// nodes.
  fullCursor(): TreeCursor {
    return new TreeCursor(this.topNode as TreeNode, true)
  }

  /// Get a [syntax node](#tree.SyntaxNode) object for the top of the
  /// tree.
  get topNode(): SyntaxNode {
    return new TreeNode(this, 0, 0, null)
  }

  /// Get the [syntax node](#tree.SyntaxNode) at the given position.
  /// If `side` is -1, this will move into nodes that end at the
  /// position. If 1, it'll move into nodes that start at the
  /// position. With 0, it'll only enter nodes that cover the position
  /// from both sides.
  resolve(pos: number, side: -1 | 0 | 1 = 0) {
    return this.cursor(pos, side).node
  }

  /// Iterate over the tree and its children, calling `enter` for any
  /// node that touches the `from`/`to` region (if given) before
  /// running over such a node's children, and `leave` (if given) when
  /// leaving the node. When `enter` returns `false`, the given node
  /// will not have its children iterated over (or `leave` called).
  iterate(spec: {
    enter(type: NodeType, from: number, to: number): false | void,
    leave?(type: NodeType, from: number, to: number): void,
    from?: number,
    to?: number
  }) {
    let {enter, leave, from = 0, to = this.length} = spec
    for (let c = this.cursor();;) {
      let mustLeave = false
      if (c.from <= to && c.to >= from && (c.type.isAnonymous || enter(c.type, c.from, c.to) !== false)) {
        if (c.firstChild()) continue
        if (!c.type.isAnonymous) mustLeave = true
      }
      for (;;) {
        if (mustLeave && leave) leave(c.type, c.from, c.to)
        mustLeave = c.type.isAnonymous
        if (c.nextSibling()) break
        if (!c.parent()) return
        mustLeave = true
      }
    }
  }

  /// Append another tree to this tree. `other` must have empty space
  /// big enough to fit this tree at its start.
  append(other: Tree) {
    if (!other.children.length) return this
    if (other.positions[0] < this.length) throw new Error("Can't append overlapping trees")
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
  ///    the given `NodeSet`.
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
  nodeSet: NodeSet,
  /// The id of the top node type, if any.
  topID?: number,
  /// The length of the wrapping node. The end offset of the last
  /// child is used when not provided.
  length?: number,
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
    readonly set: NodeSet,
    readonly type = NodeType.none
  ) {}

  /// @internal
  toString() {
    let result: string[] = []
    for (let index = 0; index < this.buffer.length;) {
      result.push(this.childString(index))
      index = this.buffer[index + 3]
    }
    return result.join(",")
  }

  /// @internal
  childString(index: number): string {
    let id = this.buffer[index], endIndex = this.buffer[index + 3]
    let type = this.set.types[id], result = type.name
    if (/\W/.test(result) && !type.isError) result = JSON.stringify(result)
    index += 4
    if (endIndex == index) return result
    let children: string[] = []
    while (index < endIndex) {
      children.push(this.childString(index))
      index = this.buffer[index + 3]
    }
    return result + "(" + children.join(",") + ")"
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
    return new TreeBuffer(newBuffer, Math.min(at, this.length), this.set)
  }

  /// @internal
  findChild(startIndex: number, endIndex: number, dir: 1 | -1, after: number) {
    let {buffer} = this, pick = -1
    for (let i = startIndex; i != endIndex; i = buffer[i + 3]) {
      if (after != After.None) {
        let start = buffer[i + 1], end = buffer[i + 2]
        if (dir > 0) {
          if (end > after) pick = i
          if (end > after) break
        } else {
          if (start < after) pick = i
          if (end >= after) break
        }
      } else {
        pick = i
        if (dir > 0) break
      }
    }
    return pick
  }
}

const enum After { None = -1e8 }

/// A syntax node provides an immutable pointer at a give node in a
/// tree. When iterating over large amounts of nodes, you may want to
/// use a mutable [cursor](#tree.TreeCursor) instead, which is more
/// efficient.
export interface SyntaxNode {
  /// The type of the node.
  type: NodeType
  /// The name of the node (`.type.name`).
  name: string
  /// The start position of the node.
  from: number
  /// The end position of the node.
  to: number

  /// The node's parent node, if any.
  parent: SyntaxNode | null
  /// The first child, if the node has children.
  firstChild: SyntaxNode | null
  /// The node's last child, if available.
  lastChild: SyntaxNode | null
  /// The first child that starts at or after `pos`.
  childAfter(pos: number): SyntaxNode | null
  /// The last child that ends at or before `pos`.
  childBefore(pos: number): SyntaxNode | null
  /// This node's next sibling, if any.
  nextSibling: SyntaxNode | null
  /// This node's previous sibling.
  prevSibling: SyntaxNode | null
  /// A [tree cursor](#tree.TreeCursor) starting at this node.
  cursor: TreeCursor
  /// Find the node around, before (if `side` is -1), or after (`side`
  /// is 1) the given position. Will look in parent nodes if the
  /// position is outside this node.
  resolve(pos: number, side?: -1 | 0 | 1): SyntaxNode

  /// Get the first child of the given type (which may be a [node
  /// name](#tree.NodeProp.name) or a [group
  /// name](#tree.NodeProp^group)). If `before` is non-null, only
  /// return children that occur somewhere after a node with that name
  /// or group. If `after` is non-null, only return children that
  /// occur somewhere before a node with that name or group.
  getChild(type: string | number, before?: string | number | null, after?: string | number | null): SyntaxNode | null

  /// Like [`getChild`](#tree.SyntaxNode.getChild), but return all
  /// matching children, not just the first.
  getChildren(type: string | number, before?: string | number | null, after?: string | number | null): SyntaxNode[]
}

class TreeNode implements SyntaxNode {
  constructor(readonly node: Tree,
              readonly from: number,
              readonly index: number,
              readonly _parent: TreeNode | null) {}

  get type() { return this.node.type }

  get name() { return this.node.type.name }

  get to() { return this.from + this.node.length }

  nextChild(i: number, dir: 1 | -1, after: number, full = false): TreeNode | BufferNode | null {
    for (let parent: TreeNode = this;;) {
      for (let {children, positions} = parent.node, e = dir > 0 ? children.length : -1; i != e; i += dir) {
        let next = children[i], start = positions[i] + parent.from
        if (after != After.None && (dir < 0 ? start >= after : start + next.length <= after))
          continue
        if (next instanceof TreeBuffer) {
          let index = next.findChild(0, next.buffer.length, dir, after == After.None ? After.None : after - start)
          if (index > -1) return new BufferNode(new BufferContext(parent, next, i, start), null, index)
        } else if (full || (!next.type.isAnonymous || hasChild(next))) {
          let inner = new TreeNode(next, start, i, parent)
          return full || !inner.type.isAnonymous ? inner : inner.nextChild(dir < 0 ? next.children.length - 1 : 0, dir, after)
        }
      }
      if (full || !parent.type.isAnonymous) return null
      i = parent.index + dir
      parent = parent._parent!
      if (!parent) return null
    }
  }

  get firstChild() { return this.nextChild(0, 1, After.None) }
  get lastChild() { return this.nextChild(this.node.children.length - 1, -1, After.None) }

  childAfter(pos: number) { return this.nextChild(0, 1, pos) }
  childBefore(pos: number) { return this.nextChild(this.node.children.length - 1, -1, pos) }

  nextSignificantParent() {
    let val: TreeNode = this
    while (val.type.isAnonymous && val._parent) val = val._parent
    return val
  }

  get parent() {
    return this._parent ? this._parent.nextSignificantParent() : null
  }

  get nextSibling() {
    return this._parent ? this._parent.nextChild(this.index + 1, 1, -1) : null
  }
  get prevSibling() {
    return this._parent ? this._parent.nextChild(this.index - 1, -1, -1) : null
  }

  get cursor() { return new TreeCursor(this) }

  resolve(pos: number, side: -1 | 0 | 1 = 0) {
    return this.cursor.moveTo(pos, side).node
  }

  getChild(type: string | number, before: string | number | null = null, after: string | number | null = null) {
    let r = getChildren(this, type, before, after)
    return r.length ? r[0] : null
  }

  getChildren(type: string | number, before: string | number | null = null, after: string | number | null = null) {
    return getChildren(this, type, before, after)
  }

  /// @internal
  toString() { return this.node.toString() }
}

function getChildren(node: SyntaxNode, type: string | number, before: string | number | null, after: string | number | null): SyntaxNode[] {
  let cur = node.cursor, result: SyntaxNode[] = []
  if (!cur.firstChild()) return result
  if (before != null) while (!cur.type.is(before)) if (!cur.nextSibling()) return result
  for (;;) {
    if (after != null && cur.type.is(after)) return result
    if (cur.type.is(type)) result.push(cur.node)
    if (!cur.nextSibling()) return after == null ? result : []
  }
}

class BufferContext {
  constructor(readonly parent: TreeNode,
              readonly buffer: TreeBuffer,
              readonly index: number,
              readonly start: number) {}
}

class BufferNode implements SyntaxNode {
  type: NodeType

  get name() { return this.type.name }

  get from() { return this.context.start + this.context.buffer.buffer[this.index + 1] }

  get to() { return this.context.start + this.context.buffer.buffer[this.index + 2] }

  constructor(readonly context: BufferContext,
              readonly _parent: BufferNode | null,
              readonly index: number) {
    this.type = context.buffer.set.types[context.buffer.buffer[index]]
  }

  child(dir: 1 | -1, after: number): BufferNode | null {
    let {buffer} = this.context
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir,
                                 after == After.None ? After.None : after - this.context.start)
    return index < 0 ? null : new BufferNode(this.context, this, index)
  }

  get firstChild() { return this.child(1, After.None) }
  get lastChild() { return this.child(-1, After.None) }

  childAfter(pos: number) { return this.child(1, pos) }
  childBefore(pos: number) { return this.child(-1, pos) }

  get parent() {
    return this._parent || this.context.parent.nextSignificantParent()
  }

  externalSibling(dir: 1 | -1) {
    return this._parent ? null : this.context.parent.nextChild(this.context.index + dir, dir, -1)
  }

  get nextSibling(): SyntaxNode | null {
    let {buffer} = this.context
    let after = buffer.buffer[this.index + 3]
    if (after < (this._parent ? buffer.buffer[this._parent.index + 3] : buffer.buffer.length))
      return new BufferNode(this.context, this._parent, after)
    return this.externalSibling(1)
  }

  get prevSibling(): SyntaxNode | null {
    let {buffer} = this.context
    let parentStart = this._parent ? this._parent.index + 4 : 0
    if (this.index == parentStart) return this.externalSibling(-1)
    return new BufferNode(this.context, this._parent, buffer.findChild(parentStart, this.index, -1, After.None))
  }

  get cursor() { return new TreeCursor(this) }

  resolve(pos: number, side: -1 | 0 | 1 = 0) {
    return this.cursor.moveTo(pos, side).node
  }

  /// @internal
  toString() { return this.context.buffer.childString(this.index) }

  getChild(type: string | number, before: string | number | null = null, after: string | number | null = null) {
    let r = getChildren(this, type, before, after)
    return r.length ? r[0] : null
  }

  getChildren(type: string | number, before: string | number | null = null, after: string | number | null = null) {
    return getChildren(this, type, before, after)
  }
}

/// A tree cursor object focuses on a given node in a syntax tree, and
/// allows you to move to adjacent nodes.
export class TreeCursor {
  /// The node's type.
  type!: NodeType

  /// Shorthand for `.type.name`.
  get name() { return this.type.name }

  /// The start source offset of this node.
  from!: number

  /// The end source offset.
  to!: number

  /// @internal
  _tree!: TreeNode
  private buffer: BufferContext | null = null
  private stack: number[] = []
  private index: number = 0
  private bufferNode: BufferNode | null = null

  /// @internal
  constructor(node: TreeNode | BufferNode, readonly full = false) {
    if (node instanceof TreeNode) {
      this.yieldNode(node)
    } else {
      this._tree = node.context.parent
      this.buffer = node.context
      for (let n: BufferNode | null = node._parent; n; n = n._parent) this.stack.unshift(n.index)
      this.bufferNode = node
      this.yieldBuf(node.index)
    }
  }

  private yieldNode(node: TreeNode | null) {
    if (!node) return false
    this._tree = node
    this.type = node.type
    this.from = node.from
    this.to = node.to
    return true
  }

  private yieldBuf(index: number, type?: NodeType) {
    this.index = index
    let {start, buffer} = this.buffer!
    this.type = type || buffer.set.types[buffer.buffer[index]]
    this.from = start + buffer.buffer[index + 1]
    this.to = start + buffer.buffer[index + 2]
    return true
  }

  private yield(node: TreeNode | BufferNode | null) {
    if (!node) return false
    if (node instanceof TreeNode) {
      this.buffer = null
      return this.yieldNode(node)
    }
    this.buffer = node.context
    return this.yieldBuf(node.index, node.type)
  }

  /// @internal
  toString() {
    return this.buffer ? this.buffer.buffer.childString(this.index) : this._tree.toString()
  }

  /// @internal
  enter(dir: 1 | -1, after: number) {
    if (!this.buffer)
      return this.yield(this._tree.nextChild(dir < 0 ? this._tree.node.children.length - 1 : 0, dir, after, this.full))

    let {buffer} = this.buffer
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir,
                                 after == After.None ? After.None : after - this.buffer.start)
    if (index < 0) return false
    this.stack.push(this.index)
    return this.yieldBuf(index)
  }

  /// Move the cursor to this node's first child. When this returns
  /// false, the node has no child, and the cursor has not been moved.
  firstChild() { return this.enter(1, After.None) }

  /// Move the cursor to this node's last child.
  lastChild() { return this.enter(-1, After.None) }

  /// Move the cursor to the first child that starts at or after `pos`.
  childAfter(pos: number) { return this.enter(1, pos) }

  /// Move to the last child that ends at or before `pos`.
  childBefore(pos: number) { return this.enter(-1, pos) }

  /// Move the node's parent node, if this isn't the top node.
  parent() {
    if (!this.buffer) return this.yieldNode(this.full ? this._tree._parent : this._tree.parent)
    if (this.stack.length) return this.yieldBuf(this.stack.pop()!)
    let parent = this.full ? this.buffer.parent : this.buffer.parent.nextSignificantParent()
    this.buffer = null
    return this.yieldNode(parent)
  }

  /// @internal
  sibling(dir: 1 | -1) {
    if (!this.buffer)
      return !this._tree._parent ? false
        : this.yield(this._tree._parent.nextChild(this._tree.index + dir, dir, After.None, this.full))

    let {buffer} = this.buffer, d = this.stack.length - 1
    if (dir < 0) {
      let parentStart = d < 0 ? 0 : this.stack[d] + 4
      if (this.index != parentStart)
        return this.yieldBuf(buffer.findChild(parentStart, this.index, -1, After.None))
    } else {
      let after = buffer.buffer[this.index + 3]
      if (after < (d < 0 ? buffer.buffer.length : buffer.buffer[this.stack[d] + 3]))
        return this.yieldBuf(after)
    }
    return d < 0 ? this.yield(this.buffer.parent.nextChild(this.buffer.index + dir, dir, After.None, this.full)) : false
  }

  /// Move to this node's next sibling, if any.
  nextSibling() { return this.sibling(1) }

  /// Move to this node's previous sibling, if any.
  prevSibling() { return this.sibling(-1) }

  private atLastNode(dir: 1 | -1) {
    let index, parent: TreeNode | null, {buffer} = this
    if (buffer) {
      if (dir > 0) {
        if (this.index < buffer.buffer.buffer.length) return false
      } else {
        for (let i = 0; i < this.index; i++) if (buffer.buffer.buffer[i + 3] < this.index) return false
      }
      ;({index, parent} = buffer)
    } else {
      ({index, _parent: parent} = this._tree)
    }
    for (; parent; {index, _parent: parent} = parent) {
      for (let i = index + dir, e = dir < 0 ? -1 : parent.node.children.length; i != e; i += dir) {
        let child = parent.node.children[i]
        if (this.full || !child.type.isAnonymous || child instanceof TreeBuffer || hasChild(child)) return false
      }
    }
    return true
  }

  private move(dir: 1 | -1) {
    if (this.enter(dir, After.None)) return true
    for (;;) {
      if (this.sibling(dir)) return true
      if (this.atLastNode(dir) || !this.parent()) return false
    }
  }

  /// Move to the next node in a
  /// [pre-order](https://en.wikipedia.org/wiki/Tree_traversal#Pre-order_(NLR))
  /// traversal, going from a node to its first child or, if the
  /// current node is empty, its next sibling or the next sibling of
  /// the first parent node that has one.
  next() { return this.move(1) }

  /// Move to the next node in a last-to-first pre-order traveral. A
  /// node is followed by ist last child or, if it has none, its
  /// previous sibling or the previous sibling of the first parent
  /// node that has one.
  prev() { return this.move(-1) }

  /// Move the cursor to the innermost node that covers `pos`. If
  /// `side` is -1, it will enter nodes that end at `pos`. If it is 1,
  /// it will enter nodes that start at `pos`.
  moveTo(pos: number, side: -1 | 0 | 1 = 0) {
    // Move up to a node that actually holds the position, if possible
    while (this.from == this.to ||
           (side < 1 ? this.from >= pos : this.from > pos) ||
           (side > -1 ? this.to <= pos : this.to < pos))
      if (!this.parent()) break

    // Then scan down into child nodes as far as possible
    for (;;) {
      if (side < 0 ? !this.childBefore(pos) : !this.childAfter(pos)) break
      if (this.from == this.to ||
          (side < 1 ? this.from >= pos : this.from > pos) ||
          (side > -1 ? this.to <= pos : this.to < pos)) {
        this.parent()
        break
      }
    }
    return this
  }

  /// Get a [syntax node](#tree.SyntaxNode) at the cursor's current
  /// position.
  get node(): SyntaxNode {
    if (!this.buffer) return this._tree
    
    let cache = this.bufferNode, result: BufferNode | null = null, depth = 0
    if (cache && cache.context == this.buffer) {
      scan: for (let index = this.index, d = this.stack.length; d >= 0;) {
        for (let c: BufferNode | null = cache; c; c = c._parent) if (c.index == index) {
          if (index == this.index) return c
          result = c
          depth = d + 1
          break scan
        }
        index = this.stack[--d]
      }
    }
    for (let i = depth; i < this.stack.length; i++) result = new BufferNode(this.buffer, result, this.stack[i])
    return this.bufferNode = new BufferNode(this.buffer, result, this.index)
  }

  /// Get the [tree](#tree.Tree) that represents the current node, if
  /// any. Will return null when the node is in a [tree
  /// buffer](#tree.TreeBuffer).
  get tree(): Tree | null {
    return this.buffer ? null : this._tree.node
  }
}

function hasChild(tree: Tree): boolean {
  return tree.children.some(ch => !ch.type.isAnonymous || ch instanceof TreeBuffer || hasChild(ch))
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
  let {buffer, nodeSet, topID = 0,
       maxBufferLength = DefaultBufferLength,
       reused = [],
       minRepeatType = nodeSet.types.length} = data as BuildData
  let cursor = Array.isArray(buffer) ? new FlatBufferCursor(buffer, buffer.length) : buffer as BufferCursor
  let types = nodeSet.types
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
      node = new TreeBuffer(data, end - buffer.start, nodeSet, inRepeat < 0 ? NodeType.none : types[inRepeat])
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
  let length = data.length ?? (children.length ? positions[0] + children[0].length : 0)
  return new Tree(types[topID], children.reverse(), positions.reverse(), length)
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

/// The [`TreeFragment.applyChanges`](#tree.TreeFragment^applyChanges)
/// method expects changed ranges in this format.
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

/// Tree fragments are used during [incremental
/// parsing](#lezer.ParseOptions.fragments) to track parts of old
/// trees that can be reused in a new parse. An array of fragments is
/// used to track regions of an old tree whose nodes might be reused
/// in new parses. Use the static
/// [`applyChanges`](#tree.TreeFragment^applyChanges) method to update
/// fragments for document changes.
export class TreeFragment {
  constructor(
    /// The start of the unchanged range pointed to by this fragment.
    /// This refers to an offset in the _updated_ document (as opposed
    /// to the original tree).
    readonly from: number,
    /// The end of the unchanged range.
    readonly to: number,
    /// The position from which it is safe to use this fragment's
    /// content in an LR parse. Will be equal to `from` when this is
    /// the start of a parse, or point one position beyond the first
    /// non-error leaf node otherwise.
    readonly safeFrom: number,
    /// The position up to which it is safe to use this fragment's
    /// content in an LR parse.
    readonly safeTo: number,
    /// The tree that this fragment is based on.
    readonly tree: Tree,
    /// The offset between the fragment's tree and the document that
    /// this fragment can be used against. Add this when going from
    /// document to tree positions, subtract it to go from tree to
    /// document positions.
    readonly offset: number
  ) {}

  // From/to are the _document_ positions to cut between. `offset` is
  // the additional offset this change adds to the given region.
  private cut(from: number, to: number, offset: number, openStart: boolean, openEnd: boolean) {
    if (from < this.from && to > this.to && !offset) return this
    let safeFrom = this.from <= from || openStart ? cutAt(this.tree, from + this.offset, 1) : this.safeFrom
    let safeTo = this.to >= to || openEnd ? cutAt(this.tree, to + this.offset, -1) : this.safeTo
    return safeFrom >= safeTo ? null
      : new TreeFragment(Math.max(this.from, from) - offset, Math.min(this.to, to) - offset,
                         safeFrom - offset, safeTo - offset, this.tree, this.offset + offset)
  }

  /// Apply a set of edits to an array of fragments, removing or
  /// splitting fragments as necessary to remove edited ranges, and
  /// adjusting offsets for fragments that moved.
  static applyChanges(fragments: readonly TreeFragment[], changes: readonly ChangedRange[], minGap = 128) {
    if (!changes.length) return fragments
    let result: TreeFragment[] = []
    let fI = 1, nextF = fragments.length ? fragments[0] : null
    let cI = 0, pos = 0, off = 0
    for (;;) {
      let nextC = cI < changes.length ? changes[cI++] : null
      let nextPos = nextC ? nextC.fromA : 1e9
      if (nextPos - pos >= minGap) while (nextF && nextF.from < nextPos) {
        let cut = nextF.cut(pos, nextPos, off, cI > 0, !!nextC)
        if (cut) result.push(cut)
        if (nextF.to > nextPos) break
        nextF = fI < fragments.length ? fragments[fI++] : null
      }
      if (!nextC) break
      pos = nextC.toA
      off = nextC.toA - nextC.toB
    }
    return result
  }

  /// Create a set of fragments from a freshly parsed tree, or update
  /// an existing set of fragments by replacing the ones that overlap
  /// with a tree with content from the new tree. When `partial` is
  /// true, the parse is treated as incomplete, and the token at its
  /// end is not included in [`safeTo`](#tree.TreeFragment.safeTo).
  static addTree(tree: Tree, fragments: readonly TreeFragment[] = [], partial = false) {
    let result = [new TreeFragment(0, tree.length, 0, partial ? cutAt(tree, tree.length, -1) : tree.length, tree, 0)]
    for (let f of fragments) if (f.to > tree.length) result.push(f)
    return result
  }
}

function cutAt(tree: Tree, pos: number, side: 1 | -1) {
  let cursor: TreeCursor = tree.cursor(pos)
  for (;;) {
    if (!cursor.enter(side, pos)) for (;;) {
      if ((side < 0 ? cursor.to <= pos : cursor.from >= pos) && !cursor.type.isError)
        return side < 0 ? cursor.to - 1 : cursor.from + 1
      if (cursor.sibling(side)) break
      if (!cursor.parent()) return side < 0 ? 0 : tree.length
    }
  }
}
