# Graph Spec

The graph is a **local** index of files, symbols, headings and packages.

## Goals

- Zero embeddings.
- Recursive CTEs only.

## Design

Traversal lives in [walker](../src/graph/walker.ts), usage in the
[guide](./guide.md#usage). See also the [README](../README.md).

### Usage

Run `sqlite-graph-mcp index` first.

## Open Questions

Should cycles be reported? See [notes](./old-notes.md).
