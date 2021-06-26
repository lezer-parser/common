import {Parser, ParseSpec, FullParseSpec, PartialParse, InputGap} from "./parse"
import {NodeProp, Tree, NodeType} from "./tree"

/// A scaffold parser combines two parsers so that the resulting
/// parser...
///
/// - Parses the document using the `scaffold` parser.
///
/// - Locates all the nodes in the resulting tree that represent the
///   scaffolding.
///
/// - Parses the document using the `fill` parser, passing in the
///   scaffolding nodes as gaps.
///
/// - Returns the tree produced by the `fill` parser with the
///   scaffolding nodes inserted into it.
///
/// This is useful for things like templating languages, where the
/// scaffold parser would manage the templating directives, and the
/// fill parser the base language.
///
/// To get efficient incremental parsing, it is recommended to make
/// sure your scaffold parser efficiently re-parses the empty space
/// between the scaffolding, for example by making it an LR parser
/// that doesn't treat gaps as single tokens (but uses one token per
/// line or something similar).
export class ScaffoldParser extends Parser {
  /// @internal
  readonly scaffoldProp = new NodeProp<Tree>({perNode: true})
  /// @internal
  readonly scaffold: Parser
  /// @internal
  readonly fill: Parser
  /// @internal
  readonly scaffoldNodes: readonly NodeType[]

  /// Create a scaffold parser.
  constructor(config: {
    /// The parser that determines the structure of the content.
    scaffold: Parser,
    /// The parser that fills in the spaces left in the scaffold.
    fill: Parser,
    /// The node types (in the scaffold parser) that should create
    /// gaps in the fill parser.
    scaffoldNodes: readonly NodeType[]
  }) {
    super()
    this.scaffold = config.scaffold
    this.fill = config.fill
    this.scaffoldNodes = config.scaffoldNodes
  }

  startParse(spec: ParseSpec) {
    return new ScaffoldParse(this, new FullParseSpec(spec))
  }
}

class ScaffoldParse implements PartialParse {
  outerTree: Tree | null = null
  outer: PartialParse
  inner: PartialParse | null = null
  stoppedAt: null | number = null

  constructor(
    readonly parser: ScaffoldParser,
    readonly spec: FullParseSpec
  ) {
    this.outer = parser.scaffold.startParse({
      ...spec,
      fragments: spec.fragments.map(f => f.setTree(f.tree.prop(parser.scaffoldProp) || f.tree))
    })
  }

  get parsedPos() {
    return this.inner ? this.inner.parsedPos : 0
  }

  advance() {
    if (this.inner) {
      let done = this.inner.advance()
      return done ? this.finishParse(done) : null
    } else {
      let done = this.outer.advance()
      if (done) this.startInner(done)
      return null
    }
  }

  stopAt(pos: number) {
    this.outer.stopAt(pos)
    if (this.inner) this.inner.stopAt(pos)
  }

  private startInner(outerTree: Tree) {
    this.outerTree = outerTree
    let gaps = [], {spec} = this
    scan: for (let c = outerTree.cursor();;) {
      if (this.parser.scaffoldNodes.includes(c.type)) {
        gaps.push(new InputGap(c.from, c.to, c.node.toTree()))
      } else if (c.firstChild()) {
        continue
      }
      for (;;) {
        if (c.nextSibling()) break
        if (!c.parent()) break scan
      }
    }
    this.inner = this.parser.fill.startParse({
      ...spec,
      gaps: spec.gaps ? InputGap.inner(spec.from, spec.to, spec.gaps, gaps) : gaps
    })
    if (this.stoppedAt != null) this.inner.stopAt(this.stoppedAt)
  }

  private finishParse(innerTree: Tree) {
    return new Tree(innerTree.type, innerTree.children, innerTree.positions, innerTree.length,
                    innerTree.propValues.concat([[this.parser.scaffoldProp, this.outerTree]]))
  }
}
