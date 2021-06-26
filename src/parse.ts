import {Tree} from "./tree"

/// The [`TreeFragment.applyChanges`](#common.TreeFragment^applyChanges)
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

const enum Open { Start = 1, End = 2 }

/// Tree fragments are used during [incremental
/// parsing](#common.ParseSpec.fragments) to track parts of old
/// trees that can be reused in a new parse. An array of fragments is
/// used to track regions of an old tree whose nodes might be reused
/// in new parses. Use the static
/// [`applyChanges`](#common.TreeFragment^applyChanges) method to update
/// fragments for document changes.
export class TreeFragment {
  /// @internal
  constructor(
    /// The start of the unchanged range pointed to by this fragment.
    /// This refers to an offset in the _updated_ document (as opposed
    /// to the original tree).
    readonly from: number,
    /// The end of the unchanged range.
    readonly to: number,
    /// The tree that this fragment is based on.
    readonly tree: Tree,
    /// The offset between the fragment's tree and the document that
    /// this fragment can be used against. Add this when going from
    /// document to tree positions, subtract it to go from tree to
    /// document positions.
    readonly offset: number,
    /// @internal
    readonly open: number
  ) {}

  /// Whether the start of the fragment represents the start of a
  /// parse, or the end of a change. (In the second case, it may not
  /// be safe to reuse some nodes at the start, depending on the
  /// parsing algorithm.)
  get openStart() { return (this.open & Open.Start) > 0 }

  /// Whether the end of the fragment represents the end of a
  /// full-document parse, or the start of a change.
  get openEnd() { return (this.open & Open.End) > 0 }

  /// Create a copy of this fragment holding a different tree.
  setTree(tree: Tree) {
    return new TreeFragment(this.from, this.to, tree, this.offset, this.open)
  }

  /// Apply a set of edits to an array of fragments, removing or
  /// splitting fragments as necessary to remove edited ranges, and
  /// adjusting offsets for fragments that moved.
  static applyChanges(fragments: readonly TreeFragment[], changes: readonly ChangedRange[], minGap = 128) {
    if (!changes.length) return fragments
    let result: TreeFragment[] = []
    let fI = 1, nextF = fragments.length ? fragments[0] : null
    for (let cI = 0, pos = 0, off = 0;; cI++) {
      let nextC = cI < changes.length ? changes[cI] : null
      let nextPos = nextC ? nextC.fromA : 1e9
      if (nextPos - pos >= minGap) while (nextF && nextF.from < nextPos) {
        let cut: TreeFragment | null = nextF
        if (pos >= cut.from || nextPos <= cut.to || off) {
          let fFrom = Math.max(cut.from, pos) - off, fTo = Math.min(cut.to, nextPos) - off
          cut = fFrom >= fTo ? null :
            new TreeFragment(fFrom, fTo, cut.tree, cut.offset + off,
                             (cI > 0 ? Open.Start : 0) | (nextC ? Open.End : 0))
        }
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
  /// true, the parse is treated as incomplete, and the resulting
  /// fragment has [`openEnd`](#common.TreeFragment.openEnd) set to
  /// true.
  static addTree(tree: Tree, fragments: readonly TreeFragment[] = [], partial = false) {
    let result = [new TreeFragment(0, tree.length, tree, 0, partial ? Open.End : 0)]
    for (let f of fragments) if (f.to > tree.length) result.push(f)
    return result
  }
}

/// Parsers may support [gaps](#common.ParseSpec.gaps), which are
/// regions in the input that the parser skips entirely, as if they
/// aren't there.
export class InputGap {
  /// Create an input gap.
  constructor(
    /// The start of the gap.
    readonly from: number,
    /// The end of the gap.
    readonly to: number,
    /// When given, instructs the parser to
    /// [mount](#common.NodeProp^mountedTree) a given tree at the
    /// position of the gap.
    readonly mount?: Tree
  ) {}

  /// Process a set of input gaps to pass them to an inner parser.
  /// Removes gaps outside of the given range, and optionally adds
  /// additional gaps, making sure the resulting collection is sorted.
  static inner(
    from: number, to: number, outer: readonly InputGap[] | undefined, add?: readonly InputGap[]
  ): readonly InputGap[] | undefined {
    if (!outer) return add
    let rest = outer.filter(g => g.from >= from && g.to <= to && (!add || !add.some(e => e.from <= g.from && e.to >= g.to)))
    return !rest.length ? add : add ? rest.concat(add).sort((a, b) => a.from - b.from) : rest
  }
}

/// Interface used to represent an in-progress parse, which can be
/// moved forward piece-by-piece.
export interface PartialParse {
  /// Advance the parse state by some amount. Will return the finished
  /// syntax tree when the parse completes.
  advance(): Tree | null
  /// The position up to which the document has been parsed. Note
  /// that, in multi-pass parsers, this will stay back until the last
  /// pass has moved past a given position.
  readonly parsedPos: number
  /// Tell the parse to not advance beyond the given position.
  /// `advance` will return a tree when the parse has reached the
  /// position. Note that, depending on the parser algorithm and the
  /// state of the parse when `stopAt` was called, that tree may
  /// contain nodes beyond the position. It is not allowed to call
  /// `stopAt` a second time with a higher position.
  stopAt(pos: number): void
  /// Reports whether `stopAt` has been called on this parse.
  readonly stoppedAt: number | null
}

/// A helper class that _resolves_ a [parse spec](#common.ParseSpec)
/// into a fully populated data structure.
export class FullParseSpec {
  /// The input object.
  input: Input
  /// The start of the parsed range.
  from: number
  /// The end of the parsed range.
  to: number
  /// The reusable tree fragments available.
  fragments: readonly TreeFragment[]
  /// Any gaps passed to the parser.
  gaps: readonly InputGap[] | undefined

  /// Resolve the given partial spec.
  constructor(spec: ParseSpec) {
    this.input = typeof spec.input == "string" ? new StringInput(spec.input) : spec.input
    this.from = spec.from || 0
    this.to = spec.to ?? this.input.length
    this.fragments = spec.fragments || []
    this.gaps = spec.gaps && spec.gaps.length ? spec.gaps : undefined
  }
}

/// The set of parameters given when starting a new parse.
export interface ParseSpec {
  /// The document to parse, either as a string or as an object
  /// conforming to the [`Input`](#common.Input) interface.
  input: string | Input
  /// The start position of the parsed range. Defaults to 0.
  from?: number
  /// The end position of the parsed range. Defaults to `input.length`.
  to?: number
  /// An optional collection of [gaps](#common.InputGap) that the parser
  /// should ignore. When given, these should be sorted by position
  /// (and may not overlap).
  gaps?: readonly InputGap[]
  /// A set of fragments from a previous parse to be used for
  /// incremental parsing. These should be aligned with the current
  /// document (through
  /// [`TreeFragment.applyChanges`](#common.TreeFragment^applyChanges))
  /// if any changes were made since they were produced. The parser
  /// will try to reuse nodes from the fragments in the new parse,
  /// greatly speeding up the parse when it can do so for most of the
  /// document.
  fragments?: readonly TreeFragment[]
}

/// A superclass that parsers should extend.
export abstract class Parser {
  /// Start a parse.
  abstract startParse(spec: ParseSpec): PartialParse

  /// Run a full parse, returning the resulting tree.
  parse(spec: ParseSpec) {
    let parse = this.startParse(spec)
    for (;;) {
      let done = parse.advance()
      if (done) return done
    }
  }
}

/// This is the interface parsers use to access the document. To run
/// Lezer directly on your own document data structure, you have to
/// write an implementation of it.
export interface Input {
  /// The length of the document.
  length: number
  /// Get the chunk after the given position. The returned string
  /// should start at `from` and, if that isn't the end of the
  /// document, may be of any length greater than zero.
  chunk(from: number): string
  /// Indicates whether the chunks already end at line breaks, so that
  /// client code that wants to work by-line can avoid re-scanning
  /// them for line breaks. When this is true, the result of `chunk()`
  /// should either be a single line break, or the content between
  /// `from` and the next line break.
  lineChunks: boolean
  /// Read the part of the document between the given positions.
  read(from: number, to: number): string
}

class StringInput implements Input {
  constructor(readonly string: string) {}

  get length() { return this.string.length }

  chunk(from: number) { return this.string.slice(from) }

  get lineChunks() { return false }

  read(from: number, to: number) { return this.string.slice(from, to) }
}
