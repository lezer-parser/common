## 0.15.12 (2022-03-18)

### Bug fixes

Work around a TypeScript issue that caused it to infer return type `any` for `resolve` and `resolveInner`.

Fix a bug in incremental mixed-language parsing where it could incorrectly add a parse range twice, causing a crash in the inner parser.

## 0.15.11 (2021-12-16)

### Bug fixes

Fix a bug where nested parsing would sometimes corrupt the length of parent nodes around the nesting point.

## 0.15.10 (2021-11-30)

### New features

`SyntaxNode` now has a `resolveInner` method (analogous to `Tree.resolveInner`).

## 0.15.9 (2021-11-24)

### Bug fixes

Full tree cursors no longer automatically enter mounted subtrees.

Fix a bug where a nested parser would not re-parse inner sections when given fragments produced by a parse that finished the outer tree but was stopped before the inner trees were done.

## 0.15.8 (2021-11-10)

### Bug fixes

Fix a bug that could cause incorrectly structured nodes to be created for repeat rules, breaking incremental parsing using the resulting tree.

## 0.15.7 (2021-10-05)

### Bug fixes

Fix an issue in `parseMixed` where parses nested two or more levels deep would use the wrong document offsets.

## 0.15.6 (2021-09-30)

### Bug fixes

Fix a null-dereference crash in mixed-language parsing.

## 0.15.5 (2021-09-09)

### New features

Syntax node objects now have a method `enterUnfinishedNodesBefore` to scan down the tree for nodes that were broken off directly in front of a given position (which can provide a more accurate context that just resolving the position).

## 0.15.4 (2021-08-31)

### Bug fixes

`parseMixed` will now scan children not covered by the ranges of an eagerly computed overlay for further nesting.

## 0.15.3 (2021-08-12)

### Bug fixes

Fix an issue where `parseMixed` could create overlay mounts with zero ranges, which were useless and confused CodeMirror's highlighter.

## 0.15.2 (2021-08-12)

### Bug fixes

Fix a bug that would cause `enter` to return incorrect results when called entering children in a buffer with .

## 0.15.1 (2021-08-12)

### Bug fixes

Fix a bug where `parseMixed` could crash by dereferencing null.

## 0.15.0 (2021-08-11)

### Breaking changes

The module name has changed from `lezer-tree` to `@lezer/common`.

`TreeBuffer`s no longer accept a node type.

`Tree.balance` no longer takes a buffer size as argument.

`NodeProp.string`, `NodeProp.number`, and `NodeProp.flag` have been removed (the thing they provided is trivial to write by hand).

A node's context hash is now stored in the `NodeProp.contextHash` prop.

Reused nodes passed to `Tree.build` must now be `Tree` instances (not tree buffers).

`Parser` is now an abstract class that all parser implementations must extend, implementing the `createParse` method.

The `PartialParse` interface changed to make multi-pass parsers possible.

`Parser.startParse` now takes different arguments `(input, fragments, ranges)` instead of `(input, startPos, context)`.

The `Input` interface has changed (to become chunk-based and more low-level). A single `Input` object is now shared between outer and inner parses.

`stringInput` is no longer exported (`Parser` methods will automatically wrap strings when appropriate).

### Bug fixes

Fix a bug in `TreeFragment.applyChanges` that prevented some valid reuse of syntax nodes.

Fix a bug where reused nodes could incorrectly be dropped by `Tree.build`.

### New features

Node props can now be per-node, in which case they are stored on `Tree` instances rather than `NodeType`s.

Tree nodes can now be replaced with other trees through `NodeProp.mountedTree`.

`Tree.resolveInner` can now be used to resolve into overlay trees.

`SyntaxNode` objects now have a `toTree` method to convert them to a stand-alone tree.

`Tree.balance` now accepts a helper function to create the inner nodes.

Tree cursors' `next`/`prev` methods now take an `enter` argument to control whether they enter the current node.

`SyntaxNode` and `TreeCursor` now have an `enter` method to directly enter the child at the given position (if any).

`Tree.iterate` callbacks now get an extra argument that allows them to create a `SyntaxNode` for the current node.

The parsing interface now supports parsing specific, non-contiguous ranges of the input in a single parse.

The module now exports a `parseMixed` helper function for creating mixed-language parsers.

## 0.13.2 (2021-02-17)

### New features

Add support for context tracking.

## 0.13.1 (2021-02-11)

### Bug fixes

Fix a bug where building a tree from a buffer would go wrong for repeat nodes whose children were all repeat nodes of the same type.

## 0.13.0 (2020-12-04)

### Breaking changes

`NodeType.isRepeated` is now called `isAnonymous`, which more accurately describes what it means.

`NodeGroup` has been renamed to `NodeSet` to avoid confusion with `NodeProp.group`.

The `applyChanges` method on trees is no longer supported (`TreeFragment` is now used to track reusable content).

Trees no longer have `cut` and `append` methods.

### New features

It is now possible to pass a node ID to `SyntaxNode.getChild`/`getChildren` and `NodeType.is`. Allow specifying a tree length in Tree.build

`Tree.build` now allows you to specify the length of the resulting tree.

`Tree.fullCursor()` can now be used to get a cursor that includes anonymous nodes, rather than skipping them.

Introduces `NodeType.define` to define node types.

The new `TreeFragment` type is used to manage reusable subtrees for incremental parsing.

`Tree.build` now accepts a `start` option indicating the start offset of the tree.

The `Input` type, which used to be `InputStream` in the lezer package, is now exported from this package.

This package now exports a `PartialParse` interface, which describes the interface used, for example, as return type from `Parser.startParse`.

## 0.12.3 (2020-11-02)

### New features

Make `NodePropSource` a function type.

## 0.12.2 (2020-10-28)

### Bug fixes

Fix a bug that made `SyntaxNode.prevSibling` fail in most cases when the node is part of a buffer.

## 0.12.1 (2020-10-26)

### Bug fixes

Fix issue where using `Tree.append` with an empty tree as argument would return a tree with a nonsensical `length` property.

## 0.12.0 (2020-10-23)

### Breaking changes

`Tree.iterate` no longer allows returning from inside the iteration (use cursors directly for that kind of use cases).

`Subtree` has been renamed to `SyntaxNode` and narrowed in scope a little.

The `top`, `skipped`, and `error` node props no longer exist.

### New features

The package now offers a `TreeCursor` abstraction, which can be used for both regular iteration and for custom traversal of a tree.

`SyntaxNode` instances have `nextSibling`/`prevSibling` getters that allow more direct navigation through the tree.

Node types now expose `isTop`, `isSkipped`, `isError`, and `isRepeated` properties that indicate special status.

Adds `NodeProp.group` to assign group names to node types.

Syntax nodes now have helper functions `getChild` and `getChildren` to retrieve direct child nodes by type or group.

`NodeType.match` (and thus `NodeProp.add`) now allows types to be targeted by group name.

Node types have a new `is` method for checking whether their name or one of their groups matches a given string.

## 0.11.1 (2020-09-26)

### Bug fixes

Fix lezer depencency versions

## 0.11.0 (2020-09-26)

### Breaking changes

Adjust to new output format of repeat rules.

## 0.10.0 (2020-08-07)

### Breaking changes

No longer list internal properties in the type definitions.

## 0.9.0 (2020-06-08)

### Breaking changes

Drop `NodeProp.delim` in favor of `NodeProp.openedBy`/`closedBy`.

## 0.8.4 (2020-04-01)

### Bug fixes

Make the package load as an ES module on node

## 0.8.3 (2020-02-28)

### New features

The package now provides an ES6 module.

## 0.8.2 (2020-02-26)

### Bug fixes

Fix a bug that caused `applyChanges` to include parts of the old tree that weren't safe to reuse.

## 0.8.1 (2020-02-14)

### Bug fixes

Fix bug that would cause tree balancing of deep trees to produce corrupt output.

## 0.8.0 (2020-02-03)

### New features

Bump version along with the rest of the lezer packages.

## 0.7.1 (2020-01-23)

### Bug fixes

In `applyChanges`, make sure the tree is collapsed all the way to the
nearest non-error node next to the change.

## 0.7.0 (2020-01-20)

### Bug fixes

Fix a bug that prevented balancing of repeat nodes when there were skipped nodes present between the repeated elements (which ruined the efficiency of incremental parses).

### New features

`TreeBuffer` objects now have an `iterate` function.

Buffers can optionally be tagged with an (unnamed) node type to allow reusing them in an incremental parse without wrapping them in a tree.

### Breaking changes

`Tree.build` now takes its arguments wrapped in an object. It also expects the buffer content to conform to from lezer 0.7.0's representation of repeated productions.

The `repeated` node prop was removed (the parser generator now encodes repetition in the type ids).

## 0.5.1 (2019-10-22)

### New features

`NodeProp.add` now also allows a selector object to be passed.

## 0.5.0 (2019-10-22)

### New features

Adds `NodeProp.top`, which flags a grammar's outer node type.

### Breaking changes

Drops the `NodeProp.lang` prop (superseded by `top`).

## 0.4.0 (2019-09-10)

### Bug fixes

Export `BufferCursor` again, which was accidentally removed from the exports in 0.3.0.

### Breaking changes

The `iterate` method now takes an object instead of separate parameters.

## 0.3.0 (2019-08-22)

### New features

Introduces node props.

Node types are now objects holding a name, id, and set of props.

### Breaking changes

Tags are gone again, nodes have plain string names.

## 0.2.0 (2019-08-02)

### Bug fixes

Fix incorrect node length calculation in `Tree.build`.

### New features

Tree nodes are now identified with tags.

New `Tag` data structure to represent node tags.

### Breaking changes

Drop support for grammar ids and node types.

## 0.1.1 (2019-07-09)

### Bug Fixes

Actually include the .d.ts file in the published package.

## 0.1.0 (2019-07-09)

### New Features

First documented release.
