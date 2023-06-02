import {Tree, Range} from "./tree"

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
/// parsing](#common.Parser.startParse) to track parts of old trees
/// that can be reused in a new parse. An array of fragments is used
/// to track regions of an old tree whose nodes might be reused in new
/// parses. Use the static
/// [`applyChanges`](#common.TreeFragment^applyChanges) method to
/// update fragments for document changes.
export class TreeFragment {
  /// @internal
  open: Open

  /// Construct a tree fragment. You'll usually want to use
  /// [`addTree`](#common.TreeFragment^addTree) and
  /// [`applyChanges`](#common.TreeFragment^applyChanges) instead of
  /// calling this directly.
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
    openStart: boolean = false,
    openEnd: boolean = false
  ) {
    this.open = (openStart ? Open.Start : 0) | (openEnd ? Open.End : 0)
  }

  /// Whether the start of the fragment represents the start of a
  /// parse, or the end of a change. (In the second case, it may not
  /// be safe to reuse some nodes at the start, depending on the
  /// parsing algorithm.)
  get openStart() { return (this.open & Open.Start) > 0 }

  /// Whether the end of the fragment represents the end of a
  /// full-document parse, or the start of a change.
  get openEnd() { return (this.open & Open.End) > 0 }

  /// Create a set of fragments from a freshly parsed tree, or update
  /// an existing set of fragments by replacing the ones that overlap
  /// with a tree with content from the new tree. When `partial` is
  /// true, the parse is treated as incomplete, and the resulting
  /// fragment has [`openEnd`](#common.TreeFragment.openEnd) set to
  /// true.
  static addTree(tree: Tree, fragments: readonly TreeFragment[] = [], partial = false): readonly TreeFragment[] {
    let result = [new TreeFragment(0, tree.length, tree, 0, false, partial)]
    for (let f of fragments) if (f.to > tree.length) result.push(f)
    return result
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
          cut = fFrom >= fTo ? null : new TreeFragment(fFrom, fTo, cut.tree, cut.offset + off, cI > 0, !!nextC)
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
  /// contain nodes beyond the position. It is an error to call
  /// `stopAt` with a higher position than it's [current
  /// value](#common.PartialParse.stoppedAt).
  stopAt(pos: number): void

  /// Reports whether `stopAt` has been called on this parse.
  readonly stoppedAt: number | null
}

/// A superclass that parsers should extend.
export abstract class Parser {
  /// Start a parse for a single tree. This is the method concrete
  /// parser implementations must implement. Called by `startParse`,
  /// with the optional arguments resolved.
  abstract createParse(
    input: Input,
    fragments: readonly TreeFragment[],
    ranges: readonly {from: number, to: number}[]
  ): PartialParse

  /// Start a parse, returning a [partial parse](#common.PartialParse)
  /// object. [`fragments`](#common.TreeFragment) can be passed in to
  /// make the parse incremental.
  ///
  /// By default, the entire input is parsed. You can pass `ranges`,
  /// which should be a sorted array of non-empty, non-overlapping
  /// ranges, to parse only those ranges. The tree returned in that
  /// case will start at `ranges[0].from`.
  startParse(
    input: Input | string,
    fragments?: readonly TreeFragment[],
    ranges?: readonly {from: number, to: number}[]
  ): PartialParse {
    if (typeof input == "string") input = new StringInput(input)
    ranges = !ranges ? [new Range(0, input.length)] : ranges.length ? ranges.map(r => new Range(r.from, r.to)) : [new Range(0, 0)]
    return this.createParse(input, fragments || [], ranges)
  }

  /// Run a full parse, returning the resulting tree.
  parse(
    input: Input | string,
    fragments?: readonly TreeFragment[],
    ranges?: readonly {from: number, to: number}[]
  ) {
    let parse = this.startParse(input, fragments, ranges)
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
  readonly length: number
  /// Get the chunk after the given position. The returned string
  /// should start at `from` and, if that isn't the end of the
  /// document, may be of any length greater than zero.
  chunk(from: number): string
  /// Indicates whether the chunks already end at line breaks, so that
  /// client code that wants to work by-line can avoid re-scanning
  /// them for line breaks. When this is true, the result of `chunk()`
  /// should either be a single line break, or the content between
  /// `from` and the next line break.
  readonly lineChunks: boolean
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

/// Parse wrapper functions are supported by some parsers to inject
/// additional parsing logic.
export type ParseWrapper = (
  inner: PartialParse,
  input: Input,
  fragments: readonly TreeFragment[],
  ranges: readonly {from: number, to: number}[]
) => PartialParse
