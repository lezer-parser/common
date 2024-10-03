import {Parser} from "./parse"

/// The default maximum length of a `TreeBuffer` node.
export const DefaultBufferLength = 1024

let nextPropID = 0

export class Range {
  constructor(readonly from: number, readonly to: number) {}
}

/// Each [node type](#common.NodeType) or [individual tree](#common.Tree)
/// can have metadata associated with it in props. Instances of this
/// class represent prop names.
export class NodeProp<T> {
  /// @internal
  id: number

  /// Indicates whether this prop is stored per [node
  /// type](#common.NodeType) or per [tree node](#common.Tree).
  perNode: boolean

  /// A method that deserializes a value of this prop from a string.
  /// Can be used to allow a prop to be directly written in a grammar
  /// file.
  deserialize: (str: string) => T

  /// Create a new node prop type.
  constructor(config: {
    /// The [deserialize](#common.NodeProp.deserialize) function to
    /// use for this prop, used for example when directly providing
    /// the prop from a grammar file. Defaults to a function that
    /// raises an error.
    deserialize?: (str: string) => T,
    /// By default, node props are stored in the [node
    /// type](#common.NodeType). It can sometimes be useful to directly
    /// store information (usually related to the parsing algorithm)
    /// in [nodes](#common.Tree) themselves. Set this to true to enable
    /// that for this prop.
    perNode?: boolean
  } = {}) {
    this.id = nextPropID++
    this.perNode = !!config.perNode
    this.deserialize = config.deserialize || (() => {
      throw new Error("This node type doesn't define a deserialize function")
    })
  }

  /// This is meant to be used with
  /// [`NodeSet.extend`](#common.NodeSet.extend) or
  /// [`LRParser.configure`](#lr.ParserConfig.props) to compute
  /// prop values for each node type in the set. Takes a [match
  /// object](#common.NodeType^match) or function that returns undefined
  /// if the node type doesn't get this prop, and the prop's value if
  /// it does.
  add(match: {[selector: string]: T} | ((type: NodeType) => T | undefined)): NodePropSource {
    if (this.perNode) throw new RangeError("Can't add per-node props to node types")
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

  /// The inverse of [`closedBy`](#common.NodeProp^closedBy). This is
  /// attached to closing delimiters, holding an array of node names
  /// of types of matching opening delimiters.
  static openedBy = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

  /// Used to assign node types to groups (for example, all node
  /// types that represent an expression could be tagged with an
  /// `"Expression"` group).
  static group = new NodeProp<readonly string[]>({deserialize: str => str.split(" ")})

  /// Attached to nodes to indicate these should be
  /// [displayed](https://codemirror.net/docs/ref/#language.syntaxTree)
  /// in a bidirectional text isolate, so that direction-neutral
  /// characters on their sides don't incorrectly get associated with
  /// surrounding text. You'll generally want to set this for nodes
  /// that contain arbitrary text, like strings and comments, and for
  /// nodes that appear _inside_ arbitrary text, like HTML tags. When
  /// not given a value, in a grammar declaration, defaults to
  /// `"auto"`.
  static isolate = new NodeProp<"rtl" | "ltr" | "auto">({deserialize: value => {
    if (value && value != "rtl" && value != "ltr" && value != "auto")
      throw new RangeError("Invalid value for isolate: " + value)
    return (value as any) || "auto"
  }})

  /// The hash of the [context](#lr.ContextTracker.constructor)
  /// that the node was parsed in, if any. Used to limit reuse of
  /// contextual nodes.
  static contextHash = new NodeProp<number>({perNode: true})

  /// The distance beyond the end of the node that the tokenizer
  /// looked ahead for any of the tokens inside the node. (The LR
  /// parser only stores this when it is larger than 25, for
  /// efficiency reasons.)
  static lookAhead = new NodeProp<number>({perNode: true})

  /// This per-node prop is used to replace a given node, or part of a
  /// node, with another tree. This is useful to include trees from
  /// different languages in mixed-language parsers.
  static mounted = new NodeProp<MountedTree>({perNode: true})
}

/// A mounted tree, which can be [stored](#common.NodeProp^mounted) on
/// a tree node to indicate that parts of its content are
/// represented by another tree.
export class MountedTree {
  constructor(
    /// The inner tree.
    readonly tree: Tree,
    /// If this is null, this tree replaces the entire node (it will
    /// be included in the regular iteration instead of its host
    /// node). If not, only the given ranges are considered to be
    /// covered by this tree. This is used for trees that are mixed in
    /// a way that isn't strictly hierarchical. Such mounted trees are
    /// only entered by [`resolveInner`](#common.Tree.resolveInner)
    /// and [`enter`](#common.SyntaxNode.enter).
    readonly overlay: readonly {from: number, to: number}[] | null,
    /// The parser used to create this subtree.
    readonly parser: Parser
  ) {}

  /// @internal
  static get(tree: Tree | null): MountedTree | null {
    return tree && tree.props && tree.props[NodeProp.mounted.id]
  }
}

/// Type returned by [`NodeProp.add`](#common.NodeProp.add). Describes
/// whether a prop should be added to a given node type in a node set,
/// and what value it should have.
export type NodePropSource = (type: NodeType) => null | [NodeProp<any>, any]

// Note: this is duplicated in lr/src/constants.ts
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

  /// Define a node type.
  static define(spec: {
    /// The ID of the node type. When this type is used in a
    /// [set](#common.NodeSet), the ID must correspond to its index in
    /// the type array.
    id: number, 
    /// The name of the node type. Leave empty to define an anonymous
    /// node.
    name?: string,
    /// [Node props](#common.NodeProp) to assign to the type. The value
    /// given for any given prop should correspond to the prop's type.
    props?: readonly ([NodeProp<any>, any] | NodePropSource)[],
    /// Whether this is a [top node](#common.NodeType.isTop).
    top?: boolean,
    /// Whether this node counts as an [error
    /// node](#common.NodeType.isError).
    error?: boolean,
    /// Whether this node is a [skipped](#common.NodeType.isSkipped)
    /// node.
    skipped?: boolean
  }) {
    let props = spec.props && spec.props.length ? Object.create(null) : noProps
    let flags = (spec.top ? NodeFlag.Top : 0) | (spec.skipped ? NodeFlag.Skipped : 0) |
      (spec.error ? NodeFlag.Error : 0) | (spec.name == null ? NodeFlag.Anonymous : 0)
    let type = new NodeType(spec.name || "", props, spec.id, flags)
    if (spec.props) for (let src of spec.props) {
      if (!Array.isArray(src)) src = src(type)!
      if (src) {
        if (src[0].perNode) throw new RangeError("Can't store a per-node prop on a node type")
        props[src[0].id] = src[1]
      }
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
  /// [groups](#common.NodeProp^group) matches the given string.
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
  /// [group](#common.NodeProp^group) names. Often useful with
  /// [`NodeProp.add`](#common.NodeProp.add). You can put multiple
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
/// full pointer to the type object, in a numeric array. Each parser
/// [has](#lr.LRParser.nodeSet) a node set, and [tree
/// buffers](#common.TreeBuffer) can only store collections of nodes
/// from the same set. A set can have a maximum of 2**16 (65536) node
/// types in it, so that the ids fit into 16-bit typed array slots.
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
  /// arguments to this method can be created with
  /// [`NodeProp.add`](#common.NodeProp.add).
  extend(...props: NodePropSource[]): NodeSet {
    let newTypes: NodeType[] = []
    for (let type of this.types) {
      let newProps: null | {[id: number]: any} = null
      for (let source of props) {
        let add = source(type)
        if (add) {
          if (!newProps) newProps = Object.assign({}, type.props)
          newProps[add[0].id] = add[1]
        }
      }
      newTypes.push(newProps ? new NodeType(type.name, newProps, type.id, type.flags) : type)
    }
    return new NodeSet(newTypes)
  }
}

const CachedNode = new WeakMap<Tree, SyntaxNode>(), CachedInnerNode = new WeakMap<Tree, SyntaxNode>()

/// Options that control iteration. Can be combined with the `|`
/// operator to enable multiple ones.
export enum IterMode {
  /// When enabled, iteration will only visit [`Tree`](#common.Tree)
  /// objects, not nodes packed into
  /// [`TreeBuffer`](#common.TreeBuffer)s.
  ExcludeBuffers = 1,
  /// Enable this to make iteration include anonymous nodes (such as
  /// the nodes that wrap repeated grammar constructs into a balanced
  /// tree).
  IncludeAnonymous = 2,
  /// By default, regular [mounted](#common.NodeProp^mounted) nodes
  /// replace their base node in iteration. Enable this to ignore them
  /// instead.
  IgnoreMounts = 4,
  /// This option only applies in
  /// [`enter`](#common.SyntaxNode.enter)-style methods. It tells the
  /// library to not enter mounted overlays if one covers the given
  /// position.
  IgnoreOverlays = 8,
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
/// use the [`TreeCursor`](#common.TreeCursor) or
/// [`SyntaxNode`](#common.SyntaxNode) interface instead, which provides
/// a view on some part of this data structure, and can be used to
/// move around to adjacent nodes.
export class Tree {
  /// @internal
  props: null | {[id: number]: any} = null

  /// Construct a new tree. See also [`Tree.build`](#common.Tree^build).
  constructor(
    /// The type of the top node.
    readonly type: NodeType,
    /// This node's child nodes.
    readonly children: readonly (Tree | TreeBuffer)[],
    /// The positions (offsets relative to the start of this tree) of
    /// the children.
    readonly positions: readonly number[],
    /// The total length of this tree
    readonly length: number,
    /// Per-node [node props](#common.NodeProp) to associate with this node.
    props?: readonly [NodeProp<any> | number, any][]
  ) {
    if (props && props.length) {
      this.props = Object.create(null)
      for (let [prop, value] of props) this.props![typeof prop == "number" ? prop : prop.id] = value
    }
  }

  /// @internal
  toString(): string {
    let mounted = MountedTree.get(this)
    if (mounted && !mounted.overlay) return mounted.tree.toString()
    let children = ""
    for (let ch of this.children) {
      let str = ch.toString()
      if (str) {
        if (children) children += ","
        children += str
      }
    }
    return !this.type.name ? children :
      (/\W/.test(this.type.name) && !this.type.isError ? JSON.stringify(this.type.name) : this.type.name) +
      (children.length ? "(" + children + ")" : "")
  }

  /// The empty tree
  static empty = new Tree(NodeType.none, [], [], 0)

  /// Get a [tree cursor](#common.TreeCursor) positioned at the top of
  /// the tree. Mode can be used to [control](#common.IterMode) which
  /// nodes the cursor visits.
  cursor(mode: IterMode = 0 as IterMode) {
    return new TreeCursor(this.topNode as TreeNode, mode)
  }

  /// Get a [tree cursor](#common.TreeCursor) pointing into this tree
  /// at the given position and side (see
  /// [`moveTo`](#common.TreeCursor.moveTo).
  cursorAt(pos: number, side: -1 | 0 | 1 = 0, mode: IterMode = 0 as IterMode): TreeCursor {
    let scope = CachedNode.get(this) || this.topNode
    let cursor = new TreeCursor(scope as TreeNode | BufferNode)
    cursor.moveTo(pos, side)
    CachedNode.set(this, cursor._tree)
    return cursor
  }

  /// Get a [syntax node](#common.SyntaxNode) object for the top of the
  /// tree.
  get topNode(): SyntaxNode {
    return new TreeNode(this, 0, 0, null)
  }

  /// Get the [syntax node](#common.SyntaxNode) at the given position.
  /// If `side` is -1, this will move into nodes that end at the
  /// position. If 1, it'll move into nodes that start at the
  /// position. With 0, it'll only enter nodes that cover the position
  /// from both sides.
  ///
  /// Note that this will not enter
  /// [overlays](#common.MountedTree.overlay), and you often want
  /// [`resolveInner`](#common.Tree.resolveInner) instead.
  resolve(pos: number, side: -1 | 0 | 1 = 0) {
    let node = resolveNode(CachedNode.get(this) || this.topNode, pos, side, false)
    CachedNode.set(this, node)
    return node
  }

  /// Like [`resolve`](#common.Tree.resolve), but will enter
  /// [overlaid](#common.MountedTree.overlay) nodes, producing a syntax node
  /// pointing into the innermost overlaid tree at the given position
  /// (with parent links going through all parent structure, including
  /// the host trees).
  resolveInner(pos: number, side: -1 | 0 | 1 = 0) {
    let node = resolveNode(CachedInnerNode.get(this) || this.topNode, pos, side, true)
    CachedInnerNode.set(this, node)
    return node
  }

  /// In some situations, it can be useful to iterate through all
  /// nodes around a position, including those in overlays that don't
  /// directly cover the position. This method gives you an iterator
  /// that will produce all nodes, from small to big, around the given
  /// position.
  resolveStack(pos: number, side: -1 | 0 | 1 = 0): NodeIterator {
    return stackIterator(this, pos, side)
  }

  /// Iterate over the tree and its children, calling `enter` for any
  /// node that touches the `from`/`to` region (if given) before
  /// running over such a node's children, and `leave` (if given) when
  /// leaving the node. When `enter` returns `false`, that node will
  /// not have its children iterated over (or `leave` called).
  iterate(spec: {
    enter(node: SyntaxNodeRef): boolean | void,
    leave?(node: SyntaxNodeRef): void,
    from?: number,
    to?: number,
    mode?: IterMode
  }) {
    let {enter, leave, from = 0, to = this.length} = spec
    let mode = spec.mode || 0, anon = (mode & IterMode.IncludeAnonymous) > 0
    for (let c = this.cursor(mode | IterMode.IncludeAnonymous);;) {
      let entered = false
      if (c.from <= to && c.to >= from && (!anon && c.type.isAnonymous || enter(c) !== false)) {
        if (c.firstChild()) continue
        entered = true
      }
      for (;;) {
        if (entered && leave && (anon || !c.type.isAnonymous)) leave(c)
        if (c.nextSibling()) break
        if (!c.parent()) return
        entered = true
      }
    }
  }

  /// Get the value of the given [node prop](#common.NodeProp) for this
  /// node. Works with both per-node and per-type props.
  prop<T>(prop: NodeProp<T>): T | undefined {
    return !prop.perNode ? this.type.prop(prop) : this.props ? this.props[prop.id] : undefined
  }

  /// Returns the node's [per-node props](#common.NodeProp.perNode) in a
  /// format that can be passed to the [`Tree`](#common.Tree)
  /// constructor.
  get propValues(): readonly [NodeProp<any> | number, any][] {
    let result: [NodeProp<any> | number, any][] = []
    if (this.props) for (let id in this.props) result.push([+id, this.props[id]])
    return result
  }

  /// Balance the direct children of this tree, producing a copy of
  /// which may have children grouped into subtrees with type
  /// [`NodeType.none`](#common.NodeType^none).
  balance(config: {
    /// Function to create the newly balanced subtrees.
    makeTree?: (children: readonly (Tree | TreeBuffer)[], positions: readonly number[], length: number) => Tree
  } = {}) {
    return this.children.length <= Balance.BranchFactor ? this :
      balanceRange(NodeType.none, this.children, this.positions, 0, this.children.length, 0, this.length,
                   (children, positions, length) => new Tree(this.type, children, positions, length, this.propValues),
                   config.makeTree || ((children, positions, length) => new Tree(NodeType.none, children, positions, length)))
  }

  /// Build a tree from a postfix-ordered buffer of node information,
  /// or a cursor over such a buffer.
  static build(data: BuildData) { return buildTree(data) }
}

/// Represents a sequence of nodes.
export type NodeIterator = {node: SyntaxNode, next: NodeIterator | null}

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
  /// The id of the top node type.
  topID: number,
  /// The position the tree should start at. Defaults to 0.
  start?: number,
  /// The position in the buffer where the function should stop
  /// reading. Defaults to 0.
  bufferStart?: number,
  /// The length of the wrapping node. The end offset of the last
  /// child is used when not provided.
  length?: number,
  /// The maximum buffer length to use. Defaults to
  /// [`DefaultBufferLength`](#common.DefaultBufferLength).
  maxBufferLength?: number,
  /// An optional array holding reused nodes that the buffer can refer
  /// to.
  reused?: readonly Tree[],
  /// The first node type that indicates repeat constructs in this
  /// grammar.
  minRepeatType?: number
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

/// Tree buffers contain (type, start, end, endIndex) quads for each
/// node. In such a buffer, nodes are stored in prefix order (parents
/// before children, with the endIndex of the parent indicating which
/// children belong to it).
export class TreeBuffer {
  /// Create a tree buffer.
  constructor(
    /// The buffer's content.
    readonly buffer: Uint16Array,
    /// The total length of the group of nodes in the buffer.
    readonly length: number,
    /// The node set used in this buffer.
    readonly set: NodeSet
  ) {}

  /// @internal
  get type() { return NodeType.none }

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
  findChild(startIndex: number, endIndex: number, dir: 1 | -1, pos: number, side: Side) {
    let {buffer} = this, pick = -1
    for (let i = startIndex; i != endIndex; i = buffer[i + 3]) {
      if (checkSide(side, pos, buffer[i + 1], buffer[i + 2])) {
        pick = i
        if (dir > 0) break
      }
    }
    return pick
  }

  /// @internal
  slice(startI: number, endI: number, from: number) {
    let b = this.buffer
    let copy = new Uint16Array(endI - startI), len = 0
    for (let i = startI, j = 0; i < endI;) {
      copy[j++] = b[i++]
      copy[j++] = b[i++] - from
      let to = copy[j++] = b[i++] - from
      copy[j++] = b[i++] - startI
      len = Math.max(len, to)
    }
    return new TreeBuffer(copy, len, this.set)
  }
}

/// The set of properties provided by both [`SyntaxNode`](#common.SyntaxNode)
/// and [`TreeCursor`](#common.TreeCursor). Note that, if you need
/// an object that is guaranteed to stay stable in the future, you
/// need to use the [`node`](#common.SyntaxNodeRef.node) accessor.
export interface SyntaxNodeRef {
  /// The start position of the node.
  readonly from: number
  /// The end position of the node.
  readonly to: number
  /// The type of the node.
  readonly type: NodeType
  /// The name of the node (`.type.name`).
  readonly name: string
  /// Get the [tree](#common.Tree) that represents the current node,
  /// if any. Will return null when the node is in a [tree
  /// buffer](#common.TreeBuffer).
  readonly tree: Tree | null
  /// Retrieve a stable [syntax node](#common.SyntaxNode) at this
  /// position.
  readonly node: SyntaxNode
  /// Test whether the node matches a given context—a sequence of
  /// direct parent nodes. Empty strings in the context array act as
  /// wildcards, other strings must match the ancestor node's name.
  matchContext(context: readonly string[]): boolean
}

/// A syntax node provides an immutable pointer to a given node in a
/// tree. When iterating over large amounts of nodes, you may want to
/// use a mutable [cursor](#common.TreeCursor) instead, which is more
/// efficient.
export interface SyntaxNode extends SyntaxNodeRef {
  /// The node's parent node, if any.
  parent: SyntaxNode | null
  /// The first child, if the node has children.
  firstChild: SyntaxNode | null
  /// The node's last child, if available.
  lastChild: SyntaxNode | null
  /// The first child that ends after `pos`.
  childAfter(pos: number): SyntaxNode | null
  /// The last child that starts before `pos`.
  childBefore(pos: number): SyntaxNode | null
  /// Enter the child at the given position. If side is -1 the child
  /// may end at that position, when 1 it may start there.
  ///
  /// This will by default enter
  /// [overlaid](#common.MountedTree.overlay)
  /// [mounted](#common.NodeProp^mounted) trees. You can set
  /// `overlays` to false to disable that.
  ///
  /// Similarly, when `buffers` is false this will not enter
  /// [buffers](#common.TreeBuffer), only [nodes](#common.Tree) (which
  /// is mostly useful when looking for props, which cannot exist on
  /// buffer-allocated nodes).
  enter(pos: number, side: -1 | 0 | 1, mode?: IterMode): SyntaxNode | null
  /// This node's next sibling, if any.
  nextSibling: SyntaxNode | null
  /// This node's previous sibling.
  prevSibling: SyntaxNode | null
  /// A [tree cursor](#common.TreeCursor) starting at this node.
  cursor(mode?: IterMode): TreeCursor
  /// Find the node around, before (if `side` is -1), or after (`side`
  /// is 1) the given position. Will look in parent nodes if the
  /// position is outside this node.
  resolve(pos: number, side?: -1 | 0 | 1): SyntaxNode
  /// Similar to `resolve`, but enter
  /// [overlaid](#common.MountedTree.overlay) nodes.
  resolveInner(pos: number, side?: -1 | 0 | 1): SyntaxNode
  /// Move the position to the innermost node before `pos` that looks
  /// like it is unfinished (meaning it ends in an error node or has a
  /// child ending in an error node right at its end).
  enterUnfinishedNodesBefore(pos: number): SyntaxNode
  /// Get a [tree](#common.Tree) for this node. Will allocate one if it
  /// points into a buffer.
  toTree(): Tree

  /// Get the first child of the given type (which may be a [node
  /// name](#common.NodeType.name) or a [group
  /// name](#common.NodeProp^group)). If `before` is non-null, only
  /// return children that occur somewhere after a node with that name
  /// or group. If `after` is non-null, only return children that
  /// occur somewhere before a node with that name or group.
  getChild(type: string | number, before?: string | number | null, after?: string | number | null): SyntaxNode | null

  /// Like [`getChild`](#common.SyntaxNode.getChild), but return all
  /// matching children, not just the first.
  getChildren(type: string | number, before?: string | number | null, after?: string | number | null): SyntaxNode[]
}

const enum Side {
  Before = -2,
  AtOrBefore = -1,
  Around = 0,
  AtOrAfter = 1,
  After = 2,
  DontCare = 4
}

function checkSide(side: Side, pos: number, from: number, to: number) {
  switch (side) {
    case Side.Before: return from < pos
    case Side.AtOrBefore: return to >= pos && from < pos
    case Side.Around: return from < pos && to > pos
    case Side.AtOrAfter: return from <= pos && to > pos
    case Side.After: return to > pos
    case Side.DontCare: return true
  }
}

function resolveNode(node: SyntaxNode, pos: number, side: -1 | 0 | 1, overlays: boolean): SyntaxNode {
  // Move up to a node that actually holds the position, if possible
  while (node.from == node.to ||
         (side < 1 ? node.from >= pos : node.from > pos) ||
         (side > -1 ? node.to <= pos : node.to < pos)) {
    let parent = !overlays && node instanceof TreeNode && node.index < 0 ? null : node.parent
    if (!parent) return node
    node = parent
  }
  let mode = overlays ? 0 : IterMode.IgnoreOverlays
  // Must go up out of overlays when those do not overlap with pos
  if (overlays) for (let scan: SyntaxNode | null = node, parent = scan.parent; parent; scan = parent, parent = scan.parent) {
    if (scan instanceof TreeNode && scan.index < 0 && parent.enter(pos, side, mode)?.from != scan.from)
      node = parent
  }
  for (;;) {
    let inner = node.enter(pos, side, mode)
    if (!inner) return node
    node = inner
  }
}

abstract class BaseNode implements SyntaxNode {
  abstract from: number
  abstract to: number
  abstract type: NodeType
  abstract name: string
  abstract tree: Tree | null
  abstract parent: SyntaxNode | null
  abstract firstChild: SyntaxNode | null
  abstract lastChild: SyntaxNode | null
  abstract childAfter(pos: number): SyntaxNode | null
  abstract childBefore(pos: number): SyntaxNode | null
  abstract enter(pos: number, side: -1 | 0 | 1, mode?: IterMode): SyntaxNode | null
  abstract nextSibling: SyntaxNode | null
  abstract prevSibling: SyntaxNode | null
  abstract toTree(): Tree

  cursor(mode: IterMode = 0 as IterMode) { return new TreeCursor(this as any, mode) }

  getChild(type: string | number, before: string | number | null = null, after: string | number | null = null) {
    let r = getChildren(this, type, before, after)
    return r.length ? r[0] : null
  }

  getChildren(type: string | number, before: string | number | null = null, after: string | number | null = null): SyntaxNode[] {
    return getChildren(this, type, before, after)
  }

  resolve(pos: number, side: -1 | 0 | 1 = 0): SyntaxNode {
    return resolveNode(this, pos, side, false)
  }

  resolveInner(pos: number, side: -1 | 0 | 1 = 0): SyntaxNode {
    return resolveNode(this, pos, side, true)
  }

  matchContext(context: readonly string[]): boolean {
    return matchNodeContext(this.parent, context)
  }

  enterUnfinishedNodesBefore(pos: number) {
    let scan = this.childBefore(pos), node: SyntaxNode = this
    while (scan) {
      let last = scan.lastChild
      if (!last || last.to != scan.to) break
      if (last.type.isError && last.from == last.to) {
        node = scan
        scan = last.prevSibling
      } else {
        scan = last
      }
    }
    return node
  }

  get node() { return this }

  get next() { return this.parent }
}

export class TreeNode extends BaseNode implements SyntaxNode {
  constructor(readonly _tree: Tree,
              readonly from: number,
              // Index in parent node, set to -1 if the node is not a direct child of _parent.node (overlay)
              readonly index: number,
              readonly _parent: TreeNode | null) { super() }

  get type() { return this._tree.type }

  get name() { return this._tree.type.name }

  get to() { return this.from + this._tree.length }

  nextChild(i: number, dir: 1 | -1, pos: number, side: Side, mode: IterMode = 0 as IterMode): TreeNode | BufferNode | null {
    for (let parent: TreeNode = this;;) {
      for (let {children, positions} = parent._tree, e = dir > 0 ? children.length : -1; i != e; i += dir) {
        let next = children[i], start = positions[i] + parent.from
        if (!checkSide(side, pos, start, start + next.length)) continue
        if (next instanceof TreeBuffer) {
          if (mode & IterMode.ExcludeBuffers) continue
          let index = next.findChild(0, next.buffer.length, dir, pos - start, side)
          if (index > -1) return new BufferNode(new BufferContext(parent, next, i, start), null, index)
        } else if ((mode & IterMode.IncludeAnonymous) || (!next.type.isAnonymous || hasChild(next))) {
          let mounted
          if (!(mode & IterMode.IgnoreMounts) && (mounted = MountedTree.get(next)) && !mounted.overlay)
            return new TreeNode(mounted.tree, start, i, parent)
          let inner = new TreeNode(next, start, i, parent)
          return (mode & IterMode.IncludeAnonymous) || !inner.type.isAnonymous ? inner
            : inner.nextChild(dir < 0 ? next.children.length - 1 : 0, dir, pos, side)
        }
      }
      if ((mode & IterMode.IncludeAnonymous) || !parent.type.isAnonymous) return null
      if (parent.index >= 0) i = parent.index + dir
      else i = dir < 0 ? -1 : parent._parent!._tree.children.length
      parent = parent._parent!
      if (!parent) return null
    }
  }

  get firstChild() { return this.nextChild(0, 1, 0, Side.DontCare) }
  get lastChild() { return this.nextChild(this._tree.children.length - 1, -1, 0, Side.DontCare) }

  childAfter(pos: number) { return this.nextChild(0, 1, pos, Side.After) }
  childBefore(pos: number) { return this.nextChild(this._tree.children.length - 1, -1, pos, Side.Before) }

  enter(pos: number, side: -1 | 0 | 1, mode = 0) {
    let mounted
    if (!(mode & IterMode.IgnoreOverlays) && (mounted = MountedTree.get(this._tree)) && mounted.overlay) {
      let rPos = pos - this.from
      for (let {from, to} of mounted.overlay) {
        if ((side > 0 ? from <= rPos : from < rPos) &&
            (side < 0 ? to >= rPos : to > rPos))
          return new TreeNode(mounted.tree, mounted.overlay[0].from + this.from, -1, this)
      }
    }
    return this.nextChild(0, 1, pos, side, mode)
  }

  nextSignificantParent() {
    let val: TreeNode = this
    while (val.type.isAnonymous && val._parent) val = val._parent
    return val
  }

  get parent(): TreeNode | null {
    return this._parent ? this._parent.nextSignificantParent() : null
  }

  get nextSibling(): SyntaxNode | null {
    return this._parent && this.index >= 0 ? this._parent.nextChild(this.index + 1, 1, 0, Side.DontCare) : null
  }
  get prevSibling(): SyntaxNode | null {
    return this._parent && this.index >= 0 ? this._parent.nextChild(this.index - 1, -1, 0, Side.DontCare) : null
  }

  get tree() { return this._tree }

  toTree() { return this._tree }

  /// @internal
  toString() { return this._tree.toString() }
}

function getChildren(node: SyntaxNode, type: string | number, before: string | number | null, after: string | number | null): SyntaxNode[] {
  let cur = node.cursor(), result: SyntaxNode[] = []
  if (!cur.firstChild()) return result
  if (before != null) for (let found = false; !found;) {
    found = cur.type.is(before)
    if (!cur.nextSibling()) return result
  }
  for (;;) {
    if (after != null && cur.type.is(after)) return result
    if (cur.type.is(type)) result.push(cur.node)
    if (!cur.nextSibling()) return after == null ? result : []
  }
}

function matchNodeContext(node: SyntaxNode | null, context: readonly string[], i = context.length - 1): boolean {
  for (let p = node; i >= 0; p = p.parent) {
    if (!p) return false
    if (!p.type.isAnonymous) {
      if (context[i] && context[i] != p.name) return false
      i--
    }
  }
  return true
}

class BufferContext {
  constructor(readonly parent: TreeNode,
              readonly buffer: TreeBuffer,
              readonly index: number,
              readonly start: number) {}
}

export class BufferNode extends BaseNode {
  type: NodeType

  get name() { return this.type.name }

  get from() { return this.context.start + this.context.buffer.buffer[this.index + 1] }

  get to() { return this.context.start + this.context.buffer.buffer[this.index + 2] }

  constructor(readonly context: BufferContext,
              readonly _parent: BufferNode | null,
              readonly index: number) {
    super()
    this.type = context.buffer.set.types[context.buffer.buffer[index]]
  }

  child(dir: 1 | -1, pos: number, side: Side): BufferNode | null {
    let {buffer} = this.context
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir, pos - this.context.start, side)
    return index < 0 ? null : new BufferNode(this.context, this, index)
  }

  get firstChild() { return this.child(1, 0, Side.DontCare) }
  get lastChild() { return this.child(-1, 0, Side.DontCare) }

  childAfter(pos: number) { return this.child(1, pos, Side.After) }
  childBefore(pos: number) { return this.child(-1, pos, Side.Before) }

  enter(pos: number, side: -1 | 0 | 1, mode: IterMode = 0 as IterMode) {
    if (mode & IterMode.ExcludeBuffers) return null
    let {buffer} = this.context
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], side > 0 ? 1 : -1, pos - this.context.start, side)
    return index < 0 ? null : new BufferNode(this.context, this, index)
  }

  get parent(): SyntaxNode | null {
    return this._parent || this.context.parent.nextSignificantParent()
  }

  externalSibling(dir: 1 | -1) {
    return this._parent ? null : this.context.parent.nextChild(this.context.index + dir, dir, 0, Side.DontCare)
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
    return new BufferNode(this.context, this._parent, buffer.findChild(parentStart, this.index, -1, 0, Side.DontCare))
  }

  get tree() { return null }

  toTree() {
    let children = [], positions = []
    let {buffer} = this.context
    let startI = this.index + 4, endI = buffer.buffer[this.index + 3]
    if (endI > startI) {
      let from = buffer.buffer[this.index + 1]
      children.push(buffer.slice(startI, endI, from))
      positions.push(0)
    }
    return new Tree(this.type, children, positions, this.to - this.from)
  }

  /// @internal
  toString() { return this.context.buffer.childString(this.index) }
}

function iterStack(heads: readonly SyntaxNode[]): NodeIterator | null {
  if (!heads.length) return null
  let pick = 0, picked = heads[0]
  for (let i = 1; i < heads.length; i++) {
    let node = heads[i]
    if (node.from > picked.from || node.to < picked.to) { picked = node; pick = i }
  }
  let next = picked instanceof TreeNode && picked.index < 0 ? null : picked.parent
  let newHeads = heads.slice()
  if (next) newHeads[pick] = next
  else newHeads.splice(pick, 1)
  return new StackIterator(newHeads, picked)
}

class StackIterator implements NodeIterator {
  constructor(readonly heads: readonly SyntaxNode[],
              readonly node: SyntaxNode) {}
  get next() { return iterStack(this.heads) }
}

function stackIterator(tree: Tree, pos: number, side: -1 | 0 | 1): NodeIterator {
  let inner = tree.resolveInner(pos, side), layers: SyntaxNode[] | null = null
  for (let scan: TreeNode | null = inner instanceof TreeNode ? inner : (inner as BufferNode).context.parent;
       scan; scan = scan.parent) {
    if (scan.index < 0) { // This is an overlay root
      let parent: TreeNode | null = scan.parent!
      ;(layers || (layers = [inner])).push(parent.resolve(pos, side))
      scan = parent
    } else {
      let mount = MountedTree.get(scan.tree)
      // Relevant overlay branching off
      if (mount && mount.overlay && mount.overlay[0].from <= pos && mount.overlay[mount.overlay.length - 1].to >= pos) {
        let root = new TreeNode(mount.tree, mount.overlay[0].from + scan.from, -1, scan)
        ;(layers || (layers = [inner])).push(resolveNode(root, pos, side, false))
      }
    }
  }
  return layers ? iterStack(layers) : inner as any
}

/// A tree cursor object focuses on a given node in a syntax tree, and
/// allows you to move to adjacent nodes.
export class TreeCursor implements SyntaxNodeRef {
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
  /// @internal
  buffer: BufferContext | null = null
  private stack: number[] = []
  /// @internal
  index: number = 0
  private bufferNode: BufferNode | null = null

  /// @internal
  constructor(
    node: TreeNode | BufferNode,
    /// @internal
    readonly mode = 0
  ) {
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

  /// @internal
  yield(node: TreeNode | BufferNode | null) {
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
  enterChild(dir: 1 | -1, pos: number, side: Side) {
    if (!this.buffer)
      return this.yield(this._tree.nextChild(dir < 0 ? this._tree._tree.children.length - 1 : 0, dir, pos, side, this.mode))

    let {buffer} = this.buffer
    let index = buffer.findChild(this.index + 4, buffer.buffer[this.index + 3], dir, pos - this.buffer.start, side)
    if (index < 0) return false
    this.stack.push(this.index)
    return this.yieldBuf(index)
  }

  /// Move the cursor to this node's first child. When this returns
  /// false, the node has no child, and the cursor has not been moved.
  firstChild() { return this.enterChild(1, 0, Side.DontCare) }

  /// Move the cursor to this node's last child.
  lastChild() { return this.enterChild(-1, 0, Side.DontCare) }

  /// Move the cursor to the first child that ends after `pos`.
  childAfter(pos: number) { return this.enterChild(1, pos, Side.After) }

  /// Move to the last child that starts before `pos`.
  childBefore(pos: number) { return this.enterChild(-1, pos, Side.Before) }

  /// Move the cursor to the child around `pos`. If side is -1 the
  /// child may end at that position, when 1 it may start there. This
  /// will also enter [overlaid](#common.MountedTree.overlay)
  /// [mounted](#common.NodeProp^mounted) trees unless `overlays` is
  /// set to false.
  enter(pos: number, side: -1 | 0 | 1, mode: IterMode = this.mode) {
    if (!this.buffer)
      return this.yield(this._tree.enter(pos, side, mode))
    return mode & IterMode.ExcludeBuffers ? false : this.enterChild(1, pos, side)
  }

  /// Move to the node's parent node, if this isn't the top node.
  parent() {
    if (!this.buffer) return this.yieldNode((this.mode & IterMode.IncludeAnonymous) ? this._tree._parent : this._tree.parent)
    if (this.stack.length) return this.yieldBuf(this.stack.pop()!)
    let parent = (this.mode & IterMode.IncludeAnonymous) ? this.buffer.parent : this.buffer.parent.nextSignificantParent()
    this.buffer = null
    return this.yieldNode(parent)
  }

  /// @internal
  sibling(dir: 1 | -1) {
    if (!this.buffer)
      return !this._tree._parent ? false
        : this.yield(this._tree.index < 0 ? null
        : this._tree._parent.nextChild(this._tree.index + dir, dir, 0, Side.DontCare, this.mode))

    let {buffer} = this.buffer, d = this.stack.length - 1
    if (dir < 0) {
      let parentStart = d < 0 ? 0 : this.stack[d] + 4
      if (this.index != parentStart)
        return this.yieldBuf(buffer.findChild(parentStart, this.index, -1, 0, Side.DontCare))
    } else {
      let after = buffer.buffer[this.index + 3]
      if (after < (d < 0 ? buffer.buffer.length : buffer.buffer[this.stack[d] + 3]))
        return this.yieldBuf(after)
    }
    return d < 0 ? this.yield(this.buffer.parent.nextChild(this.buffer.index + dir, dir, 0, Side.DontCare, this.mode)) : false
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
      if (index > -1) for (let i = index + dir, e = dir < 0 ? -1 : parent._tree.children.length; i != e; i += dir) {
        let child = parent._tree.children[i]
        if ((this.mode & IterMode.IncludeAnonymous) ||
            child instanceof TreeBuffer ||
            !child.type.isAnonymous ||
            hasChild(child)) return false
      }
    }
    return true
  }

  private move(dir: 1 | -1, enter: boolean) {
    if (enter && this.enterChild(dir, 0, Side.DontCare)) return true
    for (;;) {
      if (this.sibling(dir)) return true
      if (this.atLastNode(dir) || !this.parent()) return false
    }
  }

  /// Move to the next node in a
  /// [pre-order](https://en.wikipedia.org/wiki/Tree_traversal#Pre-order,_NLR)
  /// traversal, going from a node to its first child or, if the
  /// current node is empty or `enter` is false, its next sibling or
  /// the next sibling of the first parent node that has one.
  next(enter = true) { return this.move(1, enter) }

  /// Move to the next node in a last-to-first pre-order traversal. A
  /// node is followed by its last child or, if it has none, its
  /// previous sibling or the previous sibling of the first parent
  /// node that has one.
  prev(enter = true) { return this.move(-1, enter) }

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
    while (this.enterChild(1, pos, side)) {}
    return this
  }

  /// Get a [syntax node](#common.SyntaxNode) at the cursor's current
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

  /// Get the [tree](#common.Tree) that represents the current node, if
  /// any. Will return null when the node is in a [tree
  /// buffer](#common.TreeBuffer).
  get tree(): Tree | null {
    return this.buffer ? null : this._tree._tree
  }

  /// Iterate over the current node and all its descendants, calling
  /// `enter` when entering a node and `leave`, if given, when leaving
  /// one. When `enter` returns `false`, any children of that node are
  /// skipped, and `leave` isn't called for it.
  iterate(enter: (node: SyntaxNodeRef) => boolean | void,
          leave?: (node: SyntaxNodeRef) => void) {
    for (let depth = 0;;) {
      let mustLeave = false
      if (this.type.isAnonymous || enter(this) !== false) {
        if (this.firstChild()) { depth++; continue }
        if (!this.type.isAnonymous) mustLeave = true
      }
      for (;;) {
        if (mustLeave && leave) leave(this)
        mustLeave = this.type.isAnonymous
        if (!depth) return
        if (this.nextSibling()) break
        this.parent()
        depth--
        mustLeave = true
      }
    }
  }

  /// Test whether the current node matches a given context—a sequence
  /// of direct parent node names. Empty strings in the context array
  /// are treated as wildcards.
  matchContext(context: readonly string[]): boolean {
    if (!this.buffer) return matchNodeContext(this.node.parent, context)
    let {buffer} = this.buffer, {types} = buffer.set
    for (let i = context.length - 1, d = this.stack.length - 1; i >= 0; d--) {
      if (d < 0) return matchNodeContext(this._tree, context, i)
      let type = types[buffer.buffer[this.stack[d]]]
      if (!type.isAnonymous) {
        if (context[i] && context[i] != type.name) return false
        i--
      }
    }
    return true
  }
}

function hasChild(tree: Tree): boolean {
  return tree.children.some(ch => ch instanceof TreeBuffer || !ch.type.isAnonymous || hasChild(ch))
}

const enum Balance { BranchFactor = 8 }
const enum CutOff { Depth = 2500 }

const enum SpecialRecord {
  Reuse = -1,
  ContextChange = -3,
  LookAhead = -4
}

function buildTree(data: BuildData) {
  let {buffer, nodeSet,
       maxBufferLength = DefaultBufferLength,
       reused = [],
       minRepeatType = nodeSet.types.length} = data
  let cursor = Array.isArray(buffer) ? new FlatBufferCursor(buffer, buffer.length) : buffer as BufferCursor
  let types = nodeSet.types

  let contextHash = 0, lookAhead = 0

  function takeNode(parentStart: number, minPos: number,
                    children: (Tree | TreeBuffer)[], positions: number[],
                    inRepeat: number, depth: number) {
    let {id, start, end, size} = cursor
    let lookAheadAtStart = lookAhead, contextAtStart = contextHash
    while (size < 0) {
      cursor.next()
      if (size == SpecialRecord.Reuse) {
        let node = reused[id]
        children.push(node)
        positions.push(start - parentStart)
        return
      } else if (size == SpecialRecord.ContextChange) { // Context change
        contextHash = id
        return
      } else if (size == SpecialRecord.LookAhead) {
        lookAhead = id
        return
      } else {
        throw new RangeError(`Unrecognized record size: ${size}`)
      }
      ;({id, start, end, size} = cursor)
    }

    let type = types[id], node, buffer: {size: number, start: number, skip: number} | undefined
    let startPos = start - parentStart
    if (end - start <= maxBufferLength && (buffer = findBufferSize(cursor.pos - minPos, inRepeat))) {
      // Small enough for a buffer, and no reused nodes inside
      let data = new Uint16Array(buffer.size - buffer.skip)
      let endPos = cursor.pos - buffer.size, index = data.length
      while (cursor.pos > endPos)
        index = copyToBuffer(buffer.start, data, index)
      node = new TreeBuffer(data, end - buffer.start, nodeSet)
      startPos = buffer.start - parentStart
    } else { // Make it a node
      let endPos = cursor.pos - size
      cursor.next()
      let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
      let localInRepeat = id >= minRepeatType ? id : -1
      let lastGroup = 0, lastEnd = end
      while (cursor.pos > endPos) {
        if (localInRepeat >= 0 && cursor.id == localInRepeat && cursor.size >= 0) {
          if (cursor.end <= lastEnd - maxBufferLength) {
            makeRepeatLeaf(localChildren, localPositions, start, lastGroup, cursor.end, lastEnd,
                           localInRepeat, lookAheadAtStart, contextAtStart)
            lastGroup = localChildren.length
            lastEnd = cursor.end
          }
          cursor.next()
        } else if (depth > CutOff.Depth) {
          takeFlatNode(start, endPos, localChildren, localPositions)
        } else {
          takeNode(start, endPos, localChildren, localPositions, localInRepeat, depth + 1)
        }
      }
      if (localInRepeat >= 0 && lastGroup > 0 && lastGroup < localChildren.length)
        makeRepeatLeaf(localChildren, localPositions, start, lastGroup, start, lastEnd, localInRepeat,
                       lookAheadAtStart, contextAtStart)
      localChildren.reverse(); localPositions.reverse()

      if (localInRepeat > -1 && lastGroup > 0) {
        let make = makeBalanced(type, contextAtStart)
        node = balanceRange(type, localChildren, localPositions, 0, localChildren.length, 0, end - start, make, make)
      } else {
        node = makeTree(type, localChildren, localPositions, end - start, lookAheadAtStart - end, contextAtStart)
      }
    }

    children.push(node)
    positions.push(startPos)
  }

  function takeFlatNode(parentStart: number, minPos: number,
                        children: (Tree | TreeBuffer)[], positions: number[]) {
    let nodes = [] // Temporary, inverted array of leaf nodes found, with absolute positions
    let nodeCount = 0, stopAt = -1
    while (cursor.pos > minPos) {
      let {id, start, end, size} = cursor
      if (size > 4) { // Not a leaf
        cursor.next()
      } else if (stopAt > -1 && start < stopAt) {
        break
      } else {
        if (stopAt < 0) stopAt = end - maxBufferLength
        nodes.push(id, start, end)
        nodeCount++
        cursor.next()
      }
    }
    if (nodeCount) {
      let buffer = new Uint16Array(nodeCount * 4)
      let start = nodes[nodes.length - 2]
      for (let i = nodes.length - 3, j = 0; i >= 0; i -= 3) {
        buffer[j++] = nodes[i]
        buffer[j++] = nodes[i + 1] - start
        buffer[j++] = nodes[i + 2] - start
        buffer[j++] = j
      }
      children.push(new TreeBuffer(buffer, nodes[2] - start, nodeSet))
      positions.push(start - parentStart)
    }
  }

  function makeBalanced(type: NodeType, contextHash: number) {
    return (children: readonly (Tree | TreeBuffer)[], positions: readonly number[], length: number) => {
      let lookAhead = 0, lastI = children.length - 1, last, lookAheadProp
      if (lastI >= 0 && (last = children[lastI]) instanceof Tree) {
        if (!lastI && last.type == type && last.length == length) return last
        if (lookAheadProp = last.prop(NodeProp.lookAhead))
          lookAhead = positions[lastI] + last.length + lookAheadProp
      }
      return makeTree(type, children, positions, length, lookAhead, contextHash)
    }
  }

  function makeRepeatLeaf(children: (Tree | TreeBuffer)[], positions: number[], base: number, i: number,
                          from: number, to: number, type: number, lookAhead: number, contextHash: number) {
    let localChildren = [], localPositions = []
    while (children.length > i) { localChildren.push(children.pop()!); localPositions.push(positions.pop()! + base - from) }
    children.push(makeTree(nodeSet.types[type], localChildren, localPositions, to - from, lookAhead - to, contextHash))
    positions.push(from - base)
  }

  function makeTree(type: NodeType,
                    children: readonly (Tree | TreeBuffer)[],
                    positions: readonly number[], length: number,
                    lookAhead: number,
                    contextHash: number,
                    props?: readonly [number | NodeProp<any>, any][]) {
    if (contextHash) {
      let pair: [number | NodeProp<any>, any] = [NodeProp.contextHash, contextHash]
      props = props ? [pair].concat(props) : [pair]
    }
    if (lookAhead > 25) {
      let pair: [number | NodeProp<any>, any] = [NodeProp.lookAhead, lookAhead]
      props = props ? [pair].concat(props) : [pair]
    }
    return new Tree(type, children, positions, length, props)
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
      let nodeSize = fork.size
      // Pretend nested repeat nodes of the same type don't exist
      if (fork.id == inRepeat && nodeSize >= 0) {
        // Except that we store the current state as a valid return
        // value.
        result.size = size; result.start = start; result.skip = skip
        skip += 4; size += 4
        fork.next()
        continue
      }
      let startPos = fork.pos - nodeSize
      if (nodeSize < 0 || startPos < minPos || fork.start < minStart) break
      let localSkipped = fork.id >= minRepeatType ? 4 : 0
      let nodeStart = fork.start
      fork.next()
      while (fork.pos > startPos) {
        if (fork.size < 0) {
          if (fork.size == SpecialRecord.ContextChange) localSkipped += 4
          else break scan
        } else if (fork.id >= minRepeatType) {
          localSkipped += 4
        }
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

  function copyToBuffer(bufferStart: number, buffer: Uint16Array, index: number): number {
    let {id, start, end, size} = cursor
    cursor.next()
    if (size >= 0 && id < minRepeatType) {
      let startIndex = index
      if (size > 4) {
        let endPos = cursor.pos - (size - 4)
        while (cursor.pos > endPos)
          index = copyToBuffer(bufferStart, buffer, index)
      }
      buffer[--index] = startIndex
      buffer[--index] = end - bufferStart
      buffer[--index] = start - bufferStart
      buffer[--index] = id
    } else if (size == SpecialRecord.ContextChange) {
      contextHash = id
    } else if (size == SpecialRecord.LookAhead) {
      lookAhead = id
    }
    return index
  }

  let children: (Tree | TreeBuffer)[] = [], positions: number[] = []
  while (cursor.pos > 0) takeNode(data.start || 0, data.bufferStart || 0, children, positions, -1, 0)
  let length = data.length ?? (children.length ? positions[0] + children[0].length : 0)
  return new Tree(types[data.topID], children.reverse(), positions.reverse(), length)
}

const nodeSizeCache: WeakMap<Tree, number> = new WeakMap
function nodeSize(balanceType: NodeType, node: Tree | TreeBuffer): number {
  if (!balanceType.isAnonymous || node instanceof TreeBuffer || node.type != balanceType) return 1
  let size = nodeSizeCache.get(node)
  if (size == null) {
    size = 1
    for (let child of node.children) {
      if (child.type != balanceType || !(child instanceof Tree)) {
        size = 1
        break
      }
      size += nodeSize(balanceType, child)
    }
    nodeSizeCache.set(node, size)
  }
  return size
}

function balanceRange(
  // The type the balanced tree's inner nodes.
  balanceType: NodeType,
  // The direct children and their positions
  children: readonly (Tree | TreeBuffer)[],
  positions: readonly number[],
  // The index range in children/positions to use
  from: number, to: number,
  // The start position of the nodes, relative to their parent.
  start: number,
  // Length of the outer node
  length: number,
  // Function to build the top node of the balanced tree
  mkTop: ((children: readonly (Tree | TreeBuffer)[], positions: readonly number[], length: number) => Tree) | null,
  // Function to build internal nodes for the balanced tree
  mkTree: (children: readonly (Tree | TreeBuffer)[], positions: readonly number[], length: number) => Tree
): Tree {
  let total = 0
  for (let i = from; i < to; i++) total += nodeSize(balanceType, children[i])

  let maxChild = Math.ceil((total * 1.5) / Balance.BranchFactor)
  let localChildren: (Tree | TreeBuffer)[] = [], localPositions: number[] = []
  function divide(children: readonly (Tree | TreeBuffer)[], positions: readonly number[],
                  from: number, to: number, offset: number) {
    for (let i = from; i < to;) {
      let groupFrom = i, groupStart = positions[i], groupSize = nodeSize(balanceType, children[i])
      i++
      for (; i < to; i++) {
        let nextSize = nodeSize(balanceType, children[i])
        if (groupSize + nextSize >= maxChild) break
        groupSize += nextSize
      }
      if (i == groupFrom + 1) {
        if (groupSize > maxChild) {
          let only = children[groupFrom] as Tree // Only trees can have a size > 1
          divide(only.children, only.positions, 0, only.children.length, positions[groupFrom] + offset)
          continue
        }
        localChildren.push(children[groupFrom])
      } else {
        let length = positions[i - 1] + children[i - 1].length - groupStart
        localChildren.push(balanceRange(balanceType, children, positions, groupFrom, i, groupStart, length, null, mkTree))
      }
      localPositions.push(groupStart + offset - start)
    }
  }
  divide(children, positions, from, to, 0)
  return (mkTop || mkTree)(localChildren, localPositions, length)
}

/// Provides a way to associate values with pieces of trees. As long
/// as that part of the tree is reused, the associated values can be
/// retrieved from an updated tree.
export class NodeWeakMap<T> {
  private map = new WeakMap<Tree | TreeBuffer, T | Map<number, T>>()

  private setBuffer(buffer: TreeBuffer, index: number, value: T) {
    let inner = this.map.get(buffer) as Map<number, T> | undefined
    if (!inner) this.map.set(buffer, inner = new Map)
    inner.set(index, value)
  }

  private getBuffer(buffer: TreeBuffer, index: number): T | undefined {
    let inner = this.map.get(buffer) as Map<number, T> | undefined
    return inner && inner.get(index)
  }

  /// Set the value for this syntax node.
  set(node: SyntaxNode, value: T) {
    if (node instanceof BufferNode) this.setBuffer(node.context.buffer, node.index, value)
    else if (node instanceof TreeNode) this.map.set(node.tree, value)
  }

  /// Retrieve value for this syntax node, if it exists in the map.
  get(node: SyntaxNode): T | undefined {
    return node instanceof BufferNode ? this.getBuffer(node.context.buffer, node.index)
      : node instanceof TreeNode ? this.map.get(node.tree) as T | undefined : undefined
  }

  /// Set the value for the node that a cursor currently points to.
  cursorSet(cursor: TreeCursor, value: T) {
    if (cursor.buffer) this.setBuffer(cursor.buffer.buffer, cursor.index, value)
    else this.map.set(cursor.tree!, value)
  }

  /// Retrieve the value for the node that a cursor currently points
  /// to.
  cursorGet(cursor: TreeCursor): T | undefined {
    return cursor.buffer ? this.getBuffer(cursor.buffer.buffer, cursor.index) : this.map.get(cursor.tree!) as T | undefined
  }
}
