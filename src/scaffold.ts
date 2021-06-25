import {Parser, ParseSpec, FullParseSpec, PartialParse, InputGap} from "./parse"
import {NodeProp, Tree, NodeType} from "./tree"

export class ScaffoldParser extends Parser {
  /// @internal
  readonly scaffoldProp = new NodeProp<Tree>({perNode: true})
  /// @internal
  readonly scaffold: Parser
  /// @internal
  readonly fill: Parser
  /// @internal
  readonly scaffoldNodes: readonly NodeType[]

  constructor(config: {
    scaffold: Parser,
    fill: Parser,
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
