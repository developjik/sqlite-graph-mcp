import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';


import { GraphStore, decodeNode } from './db.js';
import { indexWorkspace } from './indexer.js';
import { toNodeView } from './query.js';
import type { EdgeType, GraphNode, IndexStats, NodeView } from './types.js';

/**
 * Graph diff: index two workspace states and answer "what breaks if we ship
 * head?" — removed or un-exported symbols that other files still referenced,
 * and files that lost their last inbound edge. Both sides accept a directory
 * or (inside a git repository) any revision, materialized via `git archive`.
 */

export interface DiffEdge {
  src: string;
  dst: string;
  type: EdgeType;
  line: number | null;
}

export interface BreakingChange {
  /** The symbol as it existed on the base side, with its citation. */
  symbol: NodeView;
  /** Files whose code used it (inbound `references` on the base side). */
  importers: { key: string; citation: string | null }[];
  /** false: the symbol is gone entirely; true: still present but no longer exported. */
  unexportedOnly: boolean;
}

export interface GraphDiff {
  base: { root: string; rev: string | null; stats: IndexStats };
  head: { root: string; rev: string | null; stats: IndexStats };
  counts: {
    addedNodes: number;
    removedNodes: number;
    addedEdges: number;
    removedEdges: number;
    breaking: number;
    newOrphans: number;
  };
  addedNodes: NodeView[];
  removedNodes: NodeView[];
  addedEdges: DiffEdge[];
  removedEdges: DiffEdge[];
  breaking: BreakingChange[];
  newOrphans: NodeView[];
  truncated: boolean;
}

export interface DiffOptions {
  engine?: 'ast' | 'heuristic';
  /** Cap on each list in the result (counts stay exact). Default 50. */
  limit?: number;
}

interface DiffScratch {
  cleanup: () => void;
}

function nodeRows(store: GraphStore): Map<string, GraphNode> {
  const rows = store.db.prepare('SELECT * FROM nodes').all() as unknown as Parameters<
    typeof decodeNode
  >[0][];
  const out = new Map<string, GraphNode>();
  for (const row of rows) {
    const node = decodeNode(row);
    out.set(node.key, node);
  }
  return out;
}

interface EdgeRow {
  sk: string;
  dk: string;
  type: EdgeType;
  line: number | null;
}

function edgeRows(
  store: GraphStore,
  direction: 'out' | 'in',
  key: string,
): { k: string; type: EdgeType; line: number | null }[] {
  const column = direction === 'out' ? 's.key' : 'd.key';
  const other = direction === 'out' ? 'd.key' : 's.key';
  return store.db
    .prepare(
      `SELECT ${other} AS k, e.type AS type, e.line AS line FROM edges e
       JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
       WHERE ${column} = ? AND e.type IN ('references', 'imports', 'links_to', 'exports')`,
    )
    .all(key) as unknown as { k: string; type: EdgeType; line: number | null }[];
}

function edgeKey(edge: EdgeRow): string {
  return `${edge.sk}\u0000${edge.dk}\u0000${edge.type}`;
}

/** Compare two indexed graphs. Exported for tests; use `diffWorkspaces` instead. */
export function graphDiff(
  base: GraphStore,
  head: GraphStore,
  baseInfo: GraphDiff['base'],
  headInfo: GraphDiff['head'],
  options: DiffOptions = {},
): GraphDiff {
  const limit = options.limit ?? 50;

  const baseNodes = nodeRows(base);
  const headNodes = nodeRows(head);
  const addedNodes: GraphNode[] = [];
  const removedNodes: GraphNode[] = [];
  for (const key of headNodes.keys()) if (!baseNodes.has(key)) addedNodes.push(headNodes.get(key)!);
  for (const key of baseNodes.keys()) if (!headNodes.has(key)) removedNodes.push(baseNodes.get(key)!);

  const baseEdges = new Map<string, EdgeRow>();
  const headEdges = new Map<string, EdgeRow>();
  const collect = (store: GraphStore, into: Map<string, EdgeRow>): void => {
    const rows = store.db
      .prepare(
        `SELECT s.key AS sk, d.key AS dk, e.type AS type, e.line AS line FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst`,
      )
      .all() as unknown as EdgeRow[];
    for (const row of rows) into.set(edgeKey(row), row);
  };
  collect(base, baseEdges);
  collect(head, headEdges);
  const addedEdges: EdgeRow[] = [];
  const removedEdges: EdgeRow[] = [];
  for (const [key, row] of headEdges) if (!baseEdges.has(key)) addedEdges.push(row);
  for (const [key, row] of baseEdges) if (!headEdges.has(key)) removedEdges.push(row);

  // Breaking: a symbol the head no longer exports (or no longer has) while
  // base-side files were still using it.
  const breaking: BreakingChange[] = [];
  const candidates = new Set(removedNodes.filter((n) => n.kind === 'symbol').map((n) => n.key));
  for (const node of headNodes.values()) {
    if (node.kind !== 'symbol') continue;
    const exportedInHead = edgeRows(head, 'in', node.key).some((r) => r.type === 'exports');
    const exportedInBase = edgeRows(base, 'in', node.key).some((r) => r.type === 'exports');
    if (exportedInBase && !exportedInHead) candidates.add(node.key);
  }
  for (const key of candidates) {
    const symbol = headNodes.get(key) ?? baseNodes.get(key);
    if (!symbol) continue;
    const refs = edgeRows(base, 'in', key).filter((r) => r.type === 'references');
    if (refs.length === 0) continue;
    const importers = refs.map((r) => {
      const file = baseNodes.get(r.k);
      return {
        key: r.k,
        citation: file?.path ? `${file.path}:${r.line ?? 1}` : null,
      };
    });
    breaking.push({
      symbol: toNodeView(symbol),
      importers,
      unexportedOnly: headNodes.has(key),
    });
  }
  breaking.sort((a, b) => b.importers.length - a.importers.length || a.symbol.key.localeCompare(b.symbol.key));

  // New orphans: files that kept existing but lost every inbound
  // imports/links_to edge (deleted files already show up as removedNodes).
  const newOrphans: GraphNode[] = [];
  for (const node of headNodes.values()) {
    if (node.kind !== 'file') continue;
    const inboundInHead = edgeRows(head, 'in', node.key).some(
      (r) => r.type === 'imports' || r.type === 'links_to',
    );
    if (inboundInHead) continue;
    const baseNode = baseNodes.get(node.key);
    if (!baseNode) continue; // brand-new file, not a lost edge
    const inboundInBase = edgeRows(base, 'in', node.key).some(
      (r) => r.type === 'imports' || r.type === 'links_to',
    );
    if (inboundInBase) newOrphans.push(node);
  }
  newOrphans.sort((a, b) => a.key.localeCompare(b.key));

  const sortNodes = (nodes: GraphNode[]): NodeView[] =>
    nodes
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key))
      .slice(0, limit)
      .map((n) => toNodeView(n));

  return {
    base: baseInfo,
    head: headInfo,
    counts: {
      addedNodes: addedNodes.length,
      removedNodes: removedNodes.length,
      addedEdges: addedEdges.length,
      removedEdges: removedEdges.length,
      breaking: breaking.length,
      newOrphans: newOrphans.length,
    },
    addedNodes: sortNodes(addedNodes),
    removedNodes: sortNodes(removedNodes),
    addedEdges: addedEdges
      .slice(0, limit)
      .map((e) => ({ src: e.sk, dst: e.dk, type: e.type, line: e.line })),
    removedEdges: removedEdges
      .slice(0, limit)
      .map((e) => ({ src: e.sk, dst: e.dk, type: e.type, line: e.line })),
    breaking: breaking.slice(0, limit),
    newOrphans: newOrphans.slice(0, limit).map((n) => toNodeView(n)),
    truncated:
      addedNodes.length > limit ||
      removedNodes.length > limit ||
      addedEdges.length > limit ||
      removedEdges.length > limit ||
      breaking.length > limit ||
      newOrphans.length > limit,
  };
}

/**
 * Resolve one diff side: an existing directory is indexed as-is; anything
 * else is treated as a git revision of `repoRoot` and materialized with
 * `git archive` into a scratch directory.
 */
function resolveSide(
  repoRoot: string,
  spec: string,
  scratch: string,
): { root: string; rev: string | null; cleanup: (() => void) | null } {
  const asPath = resolve(spec);
  if (existsSync(asPath)) return { root: asPath, rev: null, cleanup: null };
  // Verify the revision before touching the filesystem; no shell anywhere.
  execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', `${spec}^{commit}`], {
    stdio: 'pipe',
  });
  const dir = join(scratch, spec.replace(/[^\w.-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  const out = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', spec], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  writeFileSync(tar, out);
  execFileSync('tar', ['-x', '-f', tar, '-C', dir]);
  rmSync(tar, { force: true });
  return { root: dir, rev: spec, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Index both sides and diff them. `root` is the git repository for rev specs. */
export async function diffWorkspaces(
  root: string,
  baseSpec: string,
  headSpec: string,
  options: DiffOptions = {},
): Promise<GraphDiff> {
  const scratch = mkdtempSync(join(tmpdir(), 'sqlite-graph-diff-'));
  const cleanups: (() => void)[] = [];
  const side = (spec: string): { root: string; rev: string | null } => {
    const resolved = resolveSide(root, spec, scratch);
    if (resolved.cleanup) cleanups.push(resolved.cleanup);
    return resolved;
  };

  const baseSide = side(baseSpec);
  const headSide = side(headSpec);

  const indexSide = async (
    resolved: { root: string; rev: string | null },
    name: string,
  ): Promise<{ store: GraphStore; stats: IndexStats; info: GraphDiff['base'] }> => {
    const dbPath = join(scratch, `${name}.db`);
    const stats = await indexWorkspace({
      root: resolved.root,
      dbPath,
      engine: options.engine,
    });
    const store = new GraphStore(dbPath);
    return {
      store,
      stats,
      info: { root: resolved.root, rev: resolved.rev, stats },
    };
  };

  try {
    const base = await indexSide(baseSide, 'base');
    const head = await indexSide(headSide, 'head');
    const diff = graphDiff(base.store, head.store, base.info, head.info, options);
    base.store.close();
    head.store.close();
    return diff;
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    rmSync(scratch, { recursive: true, force: true });
  }
}
