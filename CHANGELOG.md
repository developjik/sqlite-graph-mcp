# Changelog


## 0.5.0 (2026-11-22)

- **References accuracy overhaul (#5).** The references index now tracks
  type-only positions, shorthand and computed-value forms, and resolves
  barrel / package-specifier imports — removing the alias-import false edges
  and `export *` phantom edges that inflated earlier counts. `--max-files`
  rejects invalid values instead of silently returning an empty graph.
  Reproduction on three real repositories holds precision at 100%.

## 0.4.0 (2026-11-22)

- **`graph_diff`: what breaks between two revisions.** Indexes two workspace
  states and compares the graphs — each side is a git revision (verified with
  `git rev-parse`, materialized with `git archive`, no shell) or a directory.
  **breaking** lists symbols the head no longer exports while base-side files
  still referenced them, with importer citations at the usage lines;
  **newOrphans** lists files that lost their last inbound edge. Available as
  the `graph_diff` MCP tool and `sqlite-graph-mcp diff <base> <head>`;
  `--check` exits 3 on breaking changes for review gates.

## 0.3.0 (2026-11-22)

- **tree-sitter (WASM) extraction engine, on by default.** Imports, symbols and
  exports now come from a real parse tree instead of regexes; the vendored
  grammars (`vendor/*.wasm`) load with no native build. `graph_index { engine:
  "heuristic" }` (or `--engine heuristic`) restores the old regex engine, and
  indexing falls back to it automatically if the WASM files fail to load.
  `stats.engine` reports which one ran.
- **`references` edges are now usage-based.** The AST engine tracks each
  imported binding (`import { a as b }`, default, namespace, destructured
  `require`) and cites the first line where the file actually uses it — not the
  import line. Unused imports produce no `references` edge; namespace imports
  reference exactly the members accessed (`NS.foo`); `export * from` references
  every export. No full scope analysis yet: a shadowed local with the same name
  can still count as a usage.
- **Official MCP Registry metadata.** `server.json` + `mcpName` in
  package.json; pushing a `v*` tag publishes to registry.modelcontextprotocol.io
  via GitHub OIDC (`.github/workflows/publish-mcp.yml`).
- `indexWorkspace` is now async (the WASM engine loads once per run).

## 0.2.0 (2026-11-22)

- Renamed the package to `@developjik/sqlite-graph-mcp` (the unscoped npm name
  belongs to an unrelated project).
- New `references` edge (file → symbol) built from import clauses: named
  (`a as b`, `import type`), default (synthetic `#default` symbol when the
  export is unnamed), namespace/`export *`, destructured `require`.
- tsconfig/jsconfig `paths` + `baseUrl` (local `extends` chains) and
  workspace-local packages (`main`/`module`/`index` entry, subpaths) resolve to
  real workspace files.
- Schema v2: `edges` CHECK gains `references`; `GraphStore` rebuilds from
  scratch when the stored `schema_version` is older.
- Korean README (`README.ko.md`), shipped in the npm tarball.

## 0.1.0 (2026-11-21)

- Initial release: zero-embedding code & spec graph over SQLite; nodes
  (file/symbol/heading/package), edges (imports/exports/defines/links_to/
  depends_on), five operators (find/walk/filter/minus/answer), FTS5 search,
  cycle-safe recursive-CTE traversal, orphan detection, MCP server + CLI.
