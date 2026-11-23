import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { GraphStore, defaultDbPath } from './db.js';
import { diffWorkspaces } from './diff.js';
import { indexWorkspace } from './indexer.js';
import { executePlan, parsePlan } from './plan.js';
import { filterNodes, findNodes, findOrphans, toEdgeViews, toNodeView, walkNodes } from './query.js';
import { EDGE_TYPES, NODE_KINDS, type IndexStats } from './types.js';

export const SERVER_NAME = 'sqlite-graph-mcp';
export const SERVER_VERSION = '0.4.0';

export interface GraphServerOptions {
  /** Workspace root to index. Defaults to `process.cwd()`. */
  root?: string;
  /** SQLite file. Defaults to `<root>/.sqlite-graph/index.db`. */
  dbPath?: string;
  /** Index automatically on first tool call when the database is missing. */
  autoIndex?: boolean;
  /** Suppress stderr progress lines. */
  quiet?: boolean;
}

export interface GraphServerHandle {
  server: McpServer;
  store: GraphStore;
  root: string;
  dbPath: string;
  index: (options?: {
    force?: boolean;
    root?: string;
    ignore?: string[];
    maxFiles?: number;
    engine?: 'ast' | 'heuristic';
  }) => Promise<IndexStats>;
  close: () => void;
}

const nodeKindSchema = z.enum(NODE_KINDS);
const edgeTypeSchema = z.enum(EDGE_TYPES);

function jsonContent(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorContent(message: string): {
  isError: true;
  content: { type: 'text'; text: string }[];
} {
  return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

/**
 * Build the MCP server. The store is opened lazily and swapped after a
 * re-index, so a running server always reads the freshest database.
 */
export function createGraphServer(options: GraphServerOptions = {}): GraphServerHandle {
  const root = resolve(options.root ?? process.cwd());
  const dbPath = options.dbPath ? resolve(options.dbPath) : defaultDbPath(root);
  const autoIndex = options.autoIndex ?? true;
  const log = (message: string): void => {
    if (!options.quiet) process.stderr.write(`[${SERVER_NAME}] ${message}\n`);
  };

  let store: GraphStore | null = null;

  const openStore = (): GraphStore => {
    if (!store) store = new GraphStore(dbPath);
    return store;
  };

  const index = async (indexOptions?: {
    force?: boolean;
    root?: string;
    ignore?: string[];
    maxFiles?: number;
    engine?: 'ast' | 'heuristic';
  }): Promise<IndexStats> => {
    const targetRoot = indexOptions?.root ? resolve(indexOptions.root) : root;
    if (store) {
      store.close();
      store = null;
    }
    const stats = await indexWorkspace({
      root: targetRoot,
      dbPath,
      ignore: indexOptions?.ignore,
      maxFiles: indexOptions?.maxFiles,
      engine: indexOptions?.engine,
    });
    log(
      `indexed ${stats.files} files → ${stats.nodes.total} nodes, ${stats.edges.total} edges ` +
        `(${stats.engine} engine) in ${stats.durationMs}ms`,
    );
    return stats;
  };

  const ensureIndexed = async (): Promise<GraphStore> => {
    const handle = openStore();
    if (!autoIndex) return handle;
    if (!existsSync(dbPath) || handle.countNodes() === 0) {
      await index();
      return openStore();
    }
    return handle;
  };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Local code & spec graph over SQLite. Index a workspace once with graph_index, then answer ' +
        'structural questions with graph_find (text search), graph_walk (follow imports/defines/references/links), ' +
        'graph_plan (chain find → walk → filter → minus and get path:line citations), and graph_orphans ' +
        '(unreferenced files, unexported symbols). No embeddings: every result is backed by a file and line. ' +
        'tsconfig paths aliases and workspace-local packages resolve to real files.',
    },
  );

  server.registerTool(
    'graph_index',
    {
      title: 'Index workspace',
      description:
        'Scan the workspace for .ts/.tsx/.js/.jsx/.md files and package.json manifests, and build the ' +
        'SQLite graph at .sqlite-graph/index.db (nodes: file, symbol, heading, package; edges: imports, ' +
        'exports, defines, links_to, depends_on, references). tsconfig paths aliases and workspace-local ' +
        'packages resolve to real files. The default tree-sitter (WASM AST) engine grounds references ' +
        'in identifier usage; the regex heuristic engine is a fallback. Safe to re-run: it rebuilds atomically.',
      inputSchema: {
        root: z.string().optional().describe('Workspace directory to index (defaults to the server root).'),
        force: z.boolean().optional().describe('Accepted for symmetry; indexing always rebuilds.'),
        ignore: z.array(z.string()).optional().describe('Extra directory or file names to skip.'),
        engine: z.enum(['ast', 'heuristic']).optional().describe('Extraction engine. Default: ast (tree-sitter WASM).'),
        maxFiles: z.number().int().min(1).max(50000).optional(),
      },
    },
    async (args) => {
      try {
        const stats = await index({
          force: args.force,
          root: args.root,
          ignore: args.ignore,
          maxFiles: args.maxFiles,
          engine: args.engine,
        });
        return jsonContent({ ok: true, ...stats, hint: 'Use graph_find or graph_plan next.' });
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.registerTool(
    'graph_find',
    {
      title: 'Find nodes',
      description:
        'Operator 1 (find): search files, symbols, markdown headings and packages by text. Uses SQLite ' +
        'FTS5 prefix ranking plus substring fallback, so "index" matches "GraphIndexer".',
      inputSchema: {
        query: z.string().describe('Search text, e.g. "walkNodes", "graph", "README". Use "*" to list all.'),
        kind: z
          .union([nodeKindSchema, z.array(nodeKindSchema)])
          .optional()
          .describe('Restrict to node kinds.'),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20.'),
      },
    },
    async (args) => {
      try {
        const graph = await ensureIndexed();
        const found = findNodes(graph, args.query, { kind: args.kind, limit: args.limit });
        return jsonContent({
          count: found.nodes.length,
          nodes: found.nodes.map((node) => toNodeView(node)),
        });
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.registerTool(
    'graph_walk',
    {
      title: 'Walk the graph',
      description:
        'Operator 2 (walk): traverse edges from a set of nodes with a recursive CTE (cycle-safe, depth ' +
        'capped). Direction out = dependencies/definitions, in = dependents/references — e.g. walk ' +
        'type=references dir=in from a symbol lists the files that import it. Each node returns its ' +
        'traversal depth and a path:line citation.',
      inputSchema: {
        start: z
          .array(z.union([z.number(), z.string()]))
          .min(1)
          .describe('Node ids or keys, as returned by graph_find.'),
        edgeType: z
          .union([edgeTypeSchema, z.array(edgeTypeSchema)])
          .optional()
          .describe('Edge types to follow. Defaults to all.'),
        direction: z.enum(['out', 'in', 'both']).optional().describe('Default "out".'),
        maxDepth: z.number().int().min(0).max(20).optional().describe('Default 6.'),
        limit: z.number().int().min(1).max(5000).optional(),
      },
    },
    async (args) => {
      try {
        const graph = await ensureIndexed();
        const walked = walkNodes(graph, args.start, {
          edgeType: args.edgeType,
          direction: args.direction,
          maxDepth: args.maxDepth,
          limit: args.limit,
        });
        return jsonContent({
          count: walked.nodes.length,
          nodes: walked.nodes.map((node) => toNodeView(node, walked.depths.get(node.id))),
        });
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.registerTool(
    'graph_plan',
    {
      title: 'Run a 5-operator plan',
      description:
        'Operator 5 (answer): chain find → walk → filter → minus in one call and get structured evidence ' +
        '(nodes, touched edges, path:line citations, per-step trace). Accepts a pipeline string such as ' +
        '`find "graph" kind=symbol | walk type=imports depth=2 | filter path=src/**` or a JSON {steps:[...]} plan.',
      inputSchema: {
        plan: z
          .union([
            z.string(),
            z.object({ steps: z.array(z.record(z.string(), z.unknown())), limit: z.number().optional() }),
            z.array(z.record(z.string(), z.unknown())),
          ])
          .describe('Pipeline string, step array, or {steps:[...]} object.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max nodes in the answer (default 50).'),
      },
    },
    async (args) => {
      try {
        const graph = await ensureIndexed();
        const plan = parsePlan(args.plan);
        if (args.limit !== undefined) plan.limit = args.limit;
        const answer = executePlan(graph, plan);
        return jsonContent(answer);
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.registerTool(
    'graph_orphans',
    {
      title: 'Find orphans',
      description:
        'Operator 4 (minus) applied: files with no inbound imports/links (dead code, stale docs) and ' +
        'symbols that are never exported (dead-code candidates). Test and entry files are excluded unless ' +
        'asked for.',
      inputSchema: {
        includeEntries: z.boolean().optional().describe('Include index/main/cli entry files.'),
        includeTests: z.boolean().optional().describe('Include *.test.ts / *.spec.ts files.'),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) => {
      try {
        const graph = await ensureIndexed();
        const result = findOrphans(graph, {
          includeEntries: args.includeEntries,
          includeTests: args.includeTests,
          limit: args.limit,
        });
        return jsonContent(result);
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.registerTool(
    'graph_filter',
    {
      title: 'Filter a node set',
      description:
        'Operator 3 (filter): narrow an explicit node set by kind, path glob/prefix/suffix, name, or tag ' +
        '(tags include code, doc, test, entry, manifest, exported). Combine with graph_find output ids.',
      inputSchema: {
        ids: z.array(z.number()).min(1).describe('Node ids to filter.'),
        kind: z.union([nodeKindSchema, z.array(nodeKindSchema)]).optional(),
        notKind: z.union([nodeKindSchema, z.array(nodeKindSchema)]).optional(),
        path: z.string().optional().describe('Glob, e.g. src/**/*.ts'),
        prefix: z.string().optional(),
        suffix: z.string().optional(),
        name: z.string().optional().describe('Case-insensitive substring of the node name.'),
        regex: z.string().optional().describe('JavaScript regex over the node name.'),
        tag: z.string().optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      },
    },
    async (args) => {
      try {
        const graph = await ensureIndexed();
        const result = filterNodes(graph, args.ids, {
          kind: args.kind,
          notKind: args.notKind,
          pathGlob: args.path,
          pathPrefix: args.prefix,
          pathSuffix: args.suffix,
          nameContains: args.name,
          nameMatches: args.regex,
          tag: args.tag,
          limit: args.limit,
        });
        return jsonContent({
          count: result.nodes.length,
          nodes: result.nodes.map((node) => toNodeView(node)),
        });
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );


  server.registerTool(
    'graph_diff',
    {
      title: 'Diff two revisions',
      description:
        'Index two workspace states and answer "what breaks if we ship head?": symbols that are ' +
        'removed or no longer exported while other files still referenced them (with importer ' +
        'citations), files that lost their last inbound edge, and node/edge counts. Each side is ' +
        'a git revision (branch, tag, SHA — verified, no shell) or a directory path.',
      inputSchema: {
        base: z.string().describe('Base side: git rev (e.g. "main") or a directory path.'),
        head: z.string().describe('Head side: git rev (e.g. "HEAD" or a PR SHA) or a directory path.'),
        engine: z.enum(['ast', 'heuristic']).optional().describe('Extraction engine. Default: ast.'),
        limit: z.number().int().min(1).max(500).optional().describe('Cap per list (default 50; counts stay exact).'),
      },
    },
    async (args) => {
      try {
        const diff = await diffWorkspaces(root, args.base, args.head, {
          engine: args.engine,
          limit: args.limit,
        });
        return jsonContent(diff);
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );
  return {
    server,
    get store() {
      return openStore();
    },
    root,
    dbPath,
    index,
    close: () => {
      if (store) {
        store.close();
        store = null;
      }
    },
  };
}

/** Start the stdio MCP server and keep the process alive until the client closes it. */
export async function runStdioServer(options: GraphServerOptions = {}): Promise<void> {
  const handle = createGraphServer(options);
  const transport = new StdioServerTransport();
  process.stderr.write(
    `[${SERVER_NAME}] v${SERVER_VERSION} ready — root=${handle.root} db=${handle.dbPath}\n`,
  );
  await handle.server.connect(transport);
  handle.server.server.onclose = () => {
    handle.close();
  };
}

export { toEdgeViews };
