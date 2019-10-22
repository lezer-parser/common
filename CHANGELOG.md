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
