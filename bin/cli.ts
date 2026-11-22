#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   sqlite-graph-mcp                 start the MCP stdio server (default)
 *   sqlite-graph-mcp index [dir]     build/rebuild the SQLite graph
 *   sqlite-graph-mcp find <query>    text search
 *   sqlite-graph-mcp walk <ref...>   recursive-CTE traversal
 *   sqlite-graph-mcp plan <plan>     chained find|walk|filter|minus answer
 *   sqlite-graph-mcp orphans         unreferenced files / unexported symbols
 */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphStore, defaultDbPath } from '../src/db.js';
import { indexWorkspace } from '../src/indexer.js';
import { runStdioServer, SERVER_NAME, SERVER_VERSION } from '../src/mcp.js';
import { executePlan, parsePlan } from '../src/plan.js';
import { diffWorkspaces } from '../src/diff.js';
import { findNodes, findOrphans, toNodeView, walkNodes } from '../src/query.js';
import type { NodeKind, NodeRef, WalkDirection } from '../src/types.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const VALUE_FLAGS = new Set([
  'root',
  'engine',
  'db',
  'kind',
  'limit',
  'type',
  'dir',
  'depth',
  'start',
  'path',
  'tag',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  // `--help` / `--version` are commands, not flags: without this they would be
  // swallowed and the CLI would start the stdio server instead.
  const first = argv[0];
  if (first === '--help' || first === '-h' || first === '--version' || first === '-v') {
    return { command: first, positional: argv.slice(1), flags: {} };
  }

  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const [rawKey, inline] = arg.slice(2).split('=');
      const key = rawKey ?? '';
      if (inline !== undefined) {
        flags[key] = inline;
      } else if (VALUE_FLAGS.has(key) && i + 1 < argv.length && !argv[i + 1]?.startsWith('--')) {
        i += 1;
        flags[key] = argv[i] as string;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }
  const command = positional.shift() ?? 'serve';
  return { command, positional, flags };
}

function dbPathFor(root: string, flags: Record<string, string | boolean>): string {
  const db = typeof flags.db === 'string' ? flags.db : undefined;
  return db ? resolve(db) : defaultDbPath(root);
}

async function openStore(root: string, flags: Record<string, string | boolean>): Promise<GraphStore> {
  const dbPath = dbPathFor(root, flags);
  if (!existsSync(dbPath)) {
    process.stderr.write(`[${SERVER_NAME}] no graph at ${dbPath}; indexing ${root} first…\n`);
    await indexWorkspace({
      root,
      dbPath,
      engine: flags.engine === 'heuristic' ? 'heuristic' : undefined,
    });
  }
  return new GraphStore(dbPath);
}

function printNodes(
  nodes: ReturnType<typeof toNodeView>[],
  json: boolean,
  label: string,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ count: nodes.length, nodes }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${label}: ${nodes.length}\n`);
  for (const node of nodes) {
    const where = node.citation ?? node.key;
    const depth = node.depth === undefined ? '' : ` d=${node.depth}`;
    process.stdout.write(`  ${where}${depth}  [${node.kind}] ${node.name}\n`);
    if (node.snippet && node.snippet !== node.name) {
      process.stdout.write(`      ${node.snippet}\n`);
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);
  const root = resolve(typeof flags.root === 'string' ? flags.root : process.cwd());
  const json = flags.json === true;

  switch (command) {
    case 'help':
    case '--help':
    case '-h': {
      process.stdout.write(
        [
          `${SERVER_NAME} v${SERVER_VERSION} — zero-embedding code & spec graph over SQLite`,
          '',
          'Usage: sqlite-graph-mcp [command] [options]',
          '',
          'Commands:',
          '  serve                 Start the MCP stdio server (default)',
          '  index [dir]           Build or rebuild .sqlite-graph/index.db',
          '  find <query>          Operator 1: text search (FTS5 + substring)',
          '  walk <ref...>         Operator 2: recursive-CTE traversal',
          '  plan <plan>           Operator 5: chained find|walk|filter|minus answer',
          '  diff <base> <head>     Graph diff between two git revs or directories',
          '  orphans               Files with no inbound imports/links, unexported symbols',
          '',
          'Options:',
          '  --root <dir>          Workspace root (default: current directory)',
          '  --db <path>           Database file (default: <root>/.sqlite-graph/index.db)',
          '  --kind <kind>         file|symbol|heading|package (comma separated)',
          '  --limit <n>           Result cap',
          '  --type <edge>         imports|exports|defines|links_to|depends_on|references',
          '  --dir out|in|both     Walk direction (default: out)',
          '  --depth <n>           Walk depth (default: 6)',
          '  --check               diff: exit 3 when a breaking change is found',
          '  --json                Machine-readable output',
          '',
          'Examples:',
          '  npx @developjik/sqlite-graph-mcp index',
          '  npx @developjik/sqlite-graph-mcp find "walkNodes" --kind symbol',
          '  npx @developjik/sqlite-graph-mcp walk 42 --type imports --depth 3',
          '  npx @developjik/sqlite-graph-mcp plan \'find "graph" kind=symbol | walk type=references dir=in\'',
          '',
        ].join('\n'),
      );
      return 0;
    }
    case 'version':
    case '--version':
    case '-v': {
      process.stdout.write(`${SERVER_VERSION}\n`);
      return 0;
    }
    case 'serve':
    case 'mcp':
    case 'server': {
      await runStdioServer({
        root,
        dbPath: typeof flags.db === 'string' ? resolve(flags.db) : undefined,
        autoIndex: flags['no-index'] !== true,
        quiet: flags.quiet === true,
      });
      return 0;
    }
    case 'index': {
      const target = positional[0] ? resolve(positional[0]) : root;
      const stats = await indexWorkspace({
        root: target,
        dbPath: dbPathFor(target, flags),
        ignore: typeof flags.ignore === 'string' ? flags.ignore.split(',') : undefined,
        engine: flags.engine === 'heuristic' ? 'heuristic' : undefined,
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      } else {
        const { nodes, edges } = stats;
        process.stdout.write(
          `Indexed ${stats.files} files in ${stats.durationMs}ms (${stats.engine} engine) → ${stats.dbPath}\n` +
            `  nodes: ${nodes.total} (file ${nodes.file}, symbol ${nodes.symbol}, heading ${nodes.heading}, package ${nodes.package})\n` +
            `  edges: ${edges.total} (imports ${edges.imports}, exports ${edges.exports}, defines ${edges.defines}, links_to ${edges.links_to}, depends_on ${edges.depends_on}, references ${edges.references})\n`,
        );
      }
      return 0;
    }
    case 'find': {
      const query = positional.join(' ');
      if (!query) throw new Error('find needs a query: sqlite-graph-mcp find "walkNodes"');
      const store = await openStore(root, flags);
      try {
        const kind =
          typeof flags.kind === 'string'
            ? (flags.kind.split(',').map((k) => k.trim()) as NodeKind[])
            : undefined;
        const found = findNodes(store, query, {
          kind,
          limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        });
        printNodes(found.nodes.map((n) => toNodeView(n)), json, 'Found');
        return found.nodes.length > 0 ? 0 : 1;
      } finally {
        store.close();
      }
    }
    case 'walk': {
      if (positional.length === 0) throw new Error('walk needs at least one node id or key');
      const store = await openStore(root, flags);
      try {
        const refs: NodeRef[] = positional.flatMap((ref) =>
          ref.includes(',') ? ref.split(',') : [ref],
        );
        const walked = walkNodes(store, refs, {
          edgeType:
            typeof flags.type === 'string'
              ? (flags.type.split(',').map((t) => t.trim()) as never)
              : undefined,
          direction: (flags.dir as WalkDirection | undefined) ?? 'out',
          maxDepth: typeof flags.depth === 'string' ? Number(flags.depth) : undefined,
          limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        });
        printNodes(
          walked.nodes.map((n) => toNodeView(n, walked.depths.get(n.id))),
          json,
          'Walked',
        );
        return 0;
      } finally {
        store.close();
      }
    }
    case 'plan': {
      const raw = positional.join(' ').trim();
      if (!raw) throw new Error('plan needs a pipeline string or JSON plan');
      const store = await openStore(root, flags);
      try {
        const input = raw.startsWith('{') || raw.startsWith('[') ? JSON.parse(raw) : parsePlan(raw);
        const answer = executePlan(store, input);
        if (json) {
          process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
        } else {
          process.stdout.write(`Plan: ${raw}\n`);
          for (const line of answer.explain) process.stdout.write(`  - ${line}\n`);
          process.stdout.write(`Answer: ${answer.count} nodes${answer.truncated ? ' (truncated)' : ''}\n`);
          for (const node of answer.nodes) {
            process.stdout.write(`  ${node.citation ?? node.key}  [${node.kind}] ${node.name}\n`);
          }
          if (answer.citations.length > 0) {
            process.stdout.write(`Citations: ${answer.citations.join(', ')}\n`);
          }
        }
        return 0;
      } finally {
        store.close();
      }
    }
    case 'diff': {
      if (positional.length < 2) {
        throw new Error('diff needs two sides: sqlite-graph-mcp diff <base> <head> (git revs or directories)');
      }
      const [baseSpec, headSpec] = positional;
      const diff = await diffWorkspaces(root, baseSpec as string, headSpec as string, {
        engine: flags.engine === 'heuristic' ? 'heuristic' : undefined,
        limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
      });
      if (json) {
        process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
      } else {
        const sideOf = (s: { rev: string | null; root: string }): string => s.rev ?? s.root;
        process.stdout.write(`Diff ${sideOf(diff.base)} → ${sideOf(diff.head)}\n`);
        process.stdout.write(
          `  nodes: +${diff.counts.addedNodes} -${diff.counts.removedNodes}` +
            `  edges: +${diff.counts.addedEdges} -${diff.counts.removedEdges}\n`,
        );
        for (const change of diff.breaking) {
          const where = change.unexportedOnly ? 'no longer exported' : 'removed';
          process.stdout.write(
            `  BREAKING ${change.symbol.citation ?? change.symbol.key} (${change.symbol.name}) is ${where}; used by:\n`,
          );
          for (const importer of change.importers) {
            process.stdout.write(`    - ${importer.citation ?? importer.key}\n`);
          }
        }
        for (const orphan of diff.newOrphans) {
          process.stdout.write(`  ORPHANED ${orphan.citation ?? orphan.key} (lost its last inbound edge)\n`);
        }
        if (diff.truncated) process.stdout.write('  (lists truncated — counts are exact)\n');
      }
      return flags.check === true && diff.counts.breaking > 0 ? 3 : 0;
    }
    case 'orphans': {
      const store = await openStore(root, flags);
      try {
        const result = findOrphans(store, {
          includeEntries: flags['include-entries'] === true,
          includeTests: flags['include-tests'] === true,
          limit: typeof flags.limit === 'string' ? Number(flags.limit) : undefined,
        });
        if (json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`Orphan files (no inbound imports/links): ${result.counts.files}\n`);
          for (const file of result.files) process.stdout.write(`  ${file.citation ?? file.key}\n`);
          process.stdout.write(`Unexported symbols (dead-code candidates): ${result.counts.symbols}\n`);
          for (const symbol of result.symbols) {
            process.stdout.write(`  ${symbol.citation ?? symbol.key}  ${symbol.name}\n`);
          }
        }
        return 0;
      } finally {
        store.close();
      }
    }
    default:
      process.stderr.write(`Unknown command "${command}". Run \`${SERVER_NAME} help\`.\n`);
      return 2;
  }
}

// Stay quiet when the reader goes away (e.g. `sqlite-graph-mcp orphans | head`).
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

/**
 * True when this file is the process entry point.
 *
 * `realpathSync` matters: npx and global installs run the package through a
 * `.bin` symlink named `sqlite-graph-mcp`, so argv[1] is that symlink and never
 * ends in `cli.js`.
 */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return /(?:^|[\\/])cli\.(?:js|ts)$/.test(arg);
  }
}

const invokedDirectly = isEntryPoint();

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${SERVER_NAME}: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}

export { main };
