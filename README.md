# sqlite-graph-mcp

[![CI](https://github.com/developjik/sqlite-graph-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/sqlite-graph-mcp/actions/workflows/ci.yml)

**A code & spec graph your AI agent can actually cite** — no embeddings, no Docker, no Neo4j, no API key.
One SQLite file, five operators, `file:line` evidence for every answer.

```
npx -y @developjik/sqlite-graph-mcp index
npx -y @developjik/sqlite-graph-mcp plan 'find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file'
# → src/graph/walker.ts:1
```

Most "code graph" tools ask you to run an embedding pipeline, push your source to a vector
database, and then return semantically similar chunks you still have to verify. This one builds a
small, deterministic graph in a local SQLite file during `index`, and answers structural questions
with recursive CTEs. When the agent says "this file defines `walkGraph`, and `index.ts` imports
it", the claim comes with a path and a line number.

---

## Why a graph in SQLite

- **Deterministic.** The same workspace produces the same graph. Nothing depends on a model,
  a chunking strategy, or a similarity threshold.
- **Zero infrastructure.** `node:sqlite`-class storage via `better-sqlite3`, one file at
  `.sqlite-graph/index.db`, `.gitignore`-friendly. No daemon, no container, no account.
- **Fast enough to re-index on every commit.** A few thousand files index in well under a second.
- **Auditable.** Every node is a row, every edge is a row. You can open the database with
  `sqlite3` and check the agent's reasoning yourself.
- **Citations by construction.** Nodes carry `path` and `line`; edges carry the line of the
  import/definition/link that created them.

## What it indexes

| Node kind | Source | Example key |
| --- | --- | --- |
| `file` | `.ts .tsx .js .jsx .mts .cts .mjs .cjs .md .mdx .markdown package.json` | `file:src/index.ts` |
| `symbol` | top-level `function` / `class` / `const|let|var` / `interface` / `type` / `enum` | `symbol:src/graph/walker.ts#walkGraph` |
| `heading` | Markdown `#` headings, GitHub-style slugs | `heading:docs/spec.md#usage` |
| `package` | `package.json` name + dependencies, plus bare imports | `package:left-pad` |

| Edge type | Meaning |
| --- | --- |
| `imports` | file → file (static `import`, `export … from`, `require`, dynamic `import()`), including tsconfig `paths` aliases and workspace-local package entries |
| `exports` | file → symbol (declaration is exported) |
| `defines` | file → symbol, file → heading, `package.json` → its package |
| `links_to` | Markdown link/reference → file or heading, including `#anchors` |
| `depends_on` | file → package, package → dependency from the manifest |
| `references` | file → symbol: the file imports that symbol (named, default, namespace, `export … from`, destructured `require`) |

Files are tagged (`code`, `ts`, `doc`, `test`, `entry`, `manifest`, `exported`, …), and tags are
filterable — that is how `graph_orphans` can skip test and entry files without extra arguments.

## Install

The package is published as **`@developjik/sqlite-graph-mcp`** (the unscoped name on npm is an
unrelated project, so always use the scope). Requires Node.js **20+** (tested on 20 and 22);
`better-sqlite3` ships prebuilt binaries. After installing, the binary is `sqlite-graph-mcp`
(or the alias `sqlite-graph`).

```bash
# run without installing
npx -y @developjik/sqlite-graph-mcp --help

# or install globally
npm install -g @developjik/sqlite-graph-mcp

# or as a dependency
npm install @developjik/sqlite-graph-mcp
```

## MCP setup

The server speaks MCP over stdio. `--root` is the workspace to index; it defaults to the
process's current directory, which is usually what an MCP client gives you.

### Claude Code
```bash
claude mcp add sqlite-graph -- npx -y @developjik/sqlite-graph-mcp serve --root /absolute/path/to/repo
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "npx",
      "args": ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.sqlite-graph]
command = "npx"
args = ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "npx",
      "args": ["-y", "@developjik/sqlite-graph-mcp", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

From a local clone (no registry needed):

```json
{
  "mcpServers": {
    "sqlite-graph": {
      "command": "node",
      "args": ["/absolute/path/to/sqlite-graph-mcp/dist/bin/cli.js", "serve", "--root", "/absolute/path/to/repo"]
    }
  }
}
```

The first tool call indexes the workspace automatically if `.sqlite-graph/index.db` is missing.
Re-run `graph_index` after large refactors; it rebuilds the graph in one transaction.

## The five operators

| Operator | Tool | Question it answers |
| --- | --- | --- |
| `find` | `graph_find` | "Where is `walkGraph` defined?" |
| `walk` | `graph_walk` | "What does this file import, transitively?" |
| `filter` | `graph_filter` | "Of these nodes, which are docs under `docs/`?" |
| `minus` | `graph_orphans` (set difference) | "Which files are never imported or linked?" |
| `answer` | `graph_plan` | "Chain the above and give me citations." |

### `graph_find`

FTS5 prefix ranking plus a substring/glob fallback, so `index` still finds `GraphIndexer` and
`*.test.ts` works as a glob.

```jsonc
// graph_find { "query": "emoji", "kind": "symbol" }
{
  "count": 1,
  "nodes": [
    {
      "id": 12,
      "key": "symbol:src/greet.ts#greetEmoji",
      "kind": "symbol",
      "name": "greetEmoji",
      "citation": "src/greet.ts:5",
      "snippet": "export const greetEmoji = '👋';",
      "tags": ["symbol", "exported", "variable"]
    }
  ]
}
```

### `graph_walk`

Traversal is a recursive CTE over `edges`. Cycle protection is path-based: a branch stops when
the next id already appears in the path it travelled, so `a → b → a` terminates at depth 1 even
with `maxDepth=20`.

```sql
WITH RECURSIVE walk(id, depth, path) AS (
  SELECT id, 0, ',' || id || ',' FROM nodes WHERE id IN (?, ?)
  UNION ALL
  SELECT e.dst, w.depth + 1, w.path || e.dst || ','
  FROM walk w
  JOIN edges e ON e.src = w.id
  WHERE w.depth < :maxDepth
    AND instr(w.path, ',' || e.dst || ',') = 0
    AND e.type IN ('imports', 'links_to')
)
SELECT id, MIN(depth) AS depth FROM walk GROUP BY id ORDER BY depth, id;
```

```jsonc
// graph_walk { "start": ["file:src/index.ts"], "edgeType": "imports", "direction": "out" }
{
  "count": 5,
  "nodes": [
    { "key": "file:src/index.ts",              "depth": 0, "citation": "src/index.ts:1" },
    { "key": "file:src/greet.ts",              "depth": 1, "citation": "src/greet.ts:1" },
    { "key": "file:src/graph/walker.ts",       "depth": 1, "citation": "src/graph/walker.ts:1" },
    { "key": "file:src/graph/cycle-a.ts",      "depth": 2, "citation": "src/graph/cycle-a.ts:1" },
    { "key": "file:src/graph/cycle-b.ts",      "depth": 3, "citation": "src/graph/cycle-b.ts:1" }
  ]
}
```

Direction `in` finds dependents ("who breaks if I rename this?"), `both` finds the neighbourhood.
`references` edges make the rename question concrete — walk them inbound from a symbol to list
every file whose import uses it:

```jsonc
// graph_walk { "start": ["symbol:src/graph/walker.ts#walkGraph"], "edgeType": "references", "direction": "in" }
{
  "count": 3,
  "nodes": [
    { "key": "symbol:src/graph/walker.ts#walkGraph", "depth": 0, "citation": "src/graph/walker.ts:7" },
    { "key": "file:src/index.ts",                    "depth": 1, "citation": "src/index.ts:2" },
    { "key": "file:src/graph/walker.test.ts",        "depth": 1, "citation": "src/graph/walker.test.ts:3" }
  ]
}
```

### `graph_filter`

```jsonc
// graph_filter { "ids": [12, 20, 21], "kind": "symbol", "prefix": "src/graph/", "tag": "exported" }
{ "count": 2, "nodes": [ /* WalkOptions, walkGraph */ ] }
```

Predicates: `kind`, `notKind`, `path` (glob), `prefix`, `suffix`, `name`, `regex`, `tag`, `limit`.

### `graph_orphans`

Set difference in one query: files with no inbound `imports`/`links_to` edge, and symbols that
are never exported. Test and entry files are excluded unless you ask for them.

```jsonc
{
  "files":   [{ "path": "src/legacy.ts", "citation": "src/legacy.ts:1" }],
  "symbols": [{ "name": "unusedHelper", "citation": "src/index.ts:13" }],
  "counts":  { "files": 1, "symbols": 2 }
}
```

### `graph_plan` — chain them

A plan is a pipeline. Each step consumes the previous step's node set; `find` starts a new set.

```
find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file
```

The same plan as JSON (what an LLM or a script would send):

```json
{
  "steps": [
    { "op": "find", "query": "walker", "kind": "symbol" },
    { "op": "walk", "edgeType": "defines", "direction": "in", "maxDepth": 1 },
    { "op": "filter", "predicate": { "kind": "file" } }
  ],
  "limit": 50
}
```

Response (trimmed):

```jsonc
{
  "count": 1,
  "nodes": [{ "key": "file:src/graph/walker.ts", "citation": "src/graph/walker.ts:1", "depth": 1 }],
  "edges": [{ "src": 20, "dst": 22, "type": "defines", "citation": "src/graph/walker.ts:7" }],
  "citations": ["src/graph/walker.ts:1"],
  "steps": [
    { "index": 0, "op": "find",   "inputCount": 0, "outputCount": 1 },
    { "index": 1, "op": "walk",   "inputCount": 1, "outputCount": 2 },
    { "index": 2, "op": "filter", "inputCount": 2, "outputCount": 1 }
  ],
  "explain": [
    "find(\"walker\", kind=symbol) → 1 nodes",
    "walk(from 1, in, defines, depth=1) → 2 nodes",
    "filter({\"kind\":\"file\"}) 2 → 1 nodes"
  ],
  "truncated": false
}
```

Pipeline syntax:

| Step | Options |
| --- | --- |
| `find <query>` | `kind=file,symbol`, `limit=20`; `*` lists all, `*.ts` is a glob |
| `walk` | `type=imports,links_to,references`, `dir=out|in|both`, `depth=6`, `start=<id>,<key>`, `limit=` |
| `filter` | `kind=`, `notKind=`, `path=src/**`, `prefix=`, `suffix=`, `name=`, `regex=`, `tag=`, `limit=` |
| `minus find <query>` | subtract another find from the current set |

## CLI

The same engine is usable without an MCP client:

```bash
sqlite-graph-mcp index [dir]                 # build/rebuild the graph
sqlite-graph-mcp find "walkGraph" --kind symbol
sqlite-graph-mcp walk <id|key> --type imports --dir out --depth 3
sqlite-graph-mcp plan 'find "graph" | walk type=imports depth=2'
sqlite-graph-mcp orphans --include-tests
sqlite-graph-mcp serve --root . --db .sqlite-graph/index.db
```

Every command accepts `--json`; `find` exits `1` when nothing matches, which makes it usable in
shell conditions.

## What it does not do (yet)

Being honest about a heuristic indexer matters more than a longer feature list:

- **No AST.** Imports, exports and declarations are extracted with comment-masked regular
  expressions, not a TypeScript parser. Multi-line declarations are handled; exotic syntax and
  computed export names are not.
- **References come from import clauses, not call sites.** A `references` edge is created for
  every named, default, namespace or destructured-`require` import (so "who uses this symbol?"
  is really "whose import clause names it?"). Identifier-level usage inside a file — calls,
  reassignments, JSX — is not tracked, and a dynamic `import()` only links files.
- **Type resolution is partial.** tsconfig/jsconfig `paths` + `baseUrl` (local `extends` chains)
  and workspace-local packages (`main`/`module`/`index`) resolve to real files; the package.json
  `exports` field, bundler-config aliases (vite/webpack), `#`-prefixed package-internal imports
  and tsconfigs in nested workspaces do not.
- **Unchanged files are re-parsed.** Re-indexing is a full atomic rebuild (fast, but not
  incremental).
- **Local scope only.** `node_modules`, `dist`, `build`, `.git` and friends are skipped, as are
  files over 512 KiB and workspaces over 5,000 files (both configurable in `graph_index`).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit, tests included
npm test            # builds, then runs unit + stdio MCP integration tests
npm run build       # tsc → dist/
```

Layout:

```
bin/cli.ts        CLI entry (shebang, subcommands, JSON output)
src/db.ts         schema, FTS5 index, GraphStore (prepared statements)
src/indexer.ts    workspace scan, comment masking, symbol/import/heading extraction, tsconfig paths, workspace packages
src/query.ts      find / walk / filter / minus / orphans over SQLite
src/plan.ts       pipeline DSL parser + answer executor with citations
src/mcp.ts        MCP server and six tools
test/             fixtures, unit tests, stdio MCP protocol tests
```

The test suite covers indexer counts and idempotency, extension remapping (`.js` import →
`.ts` source), `references` edges (named/default/namespace imports, synthetic default exports),
tsconfig `paths` aliases and workspace-local packages (see `test/fixtures/mono`), schema-version
migration, cycle-safe traversal, every operator, the plan DSL, orphan detection, the CLI, and
the MCP handshake both through the official SDK client and as raw newline-delimited JSON-RPC.

## License

MIT © 2026 Inkwon Jung ([@developjik](https://github.com/developjik))
