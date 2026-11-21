import { decodeNode } from './db.js';
import type { GraphStore } from './db.js';
import type {
  EdgeView,
  FindOptions,
  GraphEdge,
  GraphNode,
  NodePredicate,
  NodeRef,
  NodeView,
  WalkOptions,
} from './types.js';
import {
  assertEdgeTypes,
  assertNodeKinds,
  asArray,
  clamp,
  ftsPrefixToken,
  globToLike,
  likeEscape,
  snippet,
  splitTerms,
  toPosix,
} from './util.js';

export interface FindResult {
  nodes: GraphNode[];
  scores: Map<number, number>;
}

const DEFAULT_FIND_LIMIT = 20;
const MAX_FIND_LIMIT = 200;

/** FTS5 prefix query from free text; null when nothing searchable is left. */
function ftsQuery(query: string): string | null {
  const tokens = query
    .split(/[\s]+/)
    .map((t) => ftsPrefixToken(t))
    .filter((t): t is string => Boolean(t));
  if (tokens.length === 0) return null;
  return tokens.join(' AND ');
}

function kindsParam(kind: FindOptions['kind']): string[] {
  const list = asArray(kind);
  if (list.length === 0) return [];
  return assertNodeKinds(list);
}

/**
 * Operator 1 — `find`: locate nodes by text.
 *
 * Runs an FTS5 prefix query for ranking and a LIKE scan for substring recall
 * (so `index` still finds `GraphIndexer`), then merges both by match quality.
 */
export function findNodes(store: GraphStore, query: string, options: FindOptions = {}): FindResult {
  const limit = clamp(options.limit ?? DEFAULT_FIND_LIMIT, 1, MAX_FIND_LIMIT);
  const kinds = kindsParam(options.kind);
  const trimmed = query.trim().replace(/^["']|["']$/g, '');

  const kindClause = kinds.length > 0 ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '';

  if (!trimmed || trimmed === '*') {
    const rows = store.db
      .prepare(`SELECT * FROM nodes WHERE 1=1${kindClause} ORDER BY kind, name LIMIT ?`)
      .all(...kinds, limit) as unknown as GraphNode[];
    const nodes = rows.map((row) => decodeNode(row as never));
    return { nodes, scores: new Map(nodes.map((n) => [n.id, 5])) };
  }

  // A query containing `*` or `?` is a glob over name and path (e.g. "*.test.ts").
  if (/[*?]/.test(trimmed)) {
    const pattern = globToLike(trimmed.toLowerCase());
    const rows = store.db
      .prepare(
        `SELECT * FROM nodes
         WHERE (lower(name) LIKE ? ESCAPE '\\' OR lower(path) LIKE ? ESCAPE '\\')${kindClause}
         ORDER BY kind, name LIMIT ?`,
      )
      .all(pattern, pattern, ...kinds, limit) as unknown as GraphNode[];
    const nodes = rows.map((row) => decodeNode(row as never));
    return { nodes, scores: new Map(nodes.map((n) => [n.id, 0])) };
  }

  const scores = new Map<number, number>();
  const ranked: number[] = [];

  const fts = ftsQuery(trimmed);
  if (fts) {
    try {
      const rows = store.db
        .prepare(
          `SELECT rowid AS id FROM nodes_fts WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(fts, limit * 5) as { id: number }[];
      rows.forEach((row, index) => {
        if (!scores.has(row.id)) scores.set(row.id, 10 + index / 1000);
        ranked.push(row.id);
      });
    } catch {
      // Malformed FTS expression: LIKE below still answers the query.
    }
  }

  const tokens = splitTerms(trimmed).length > 0 ? trimmed.split(/\s+/) : [trimmed];
  const likeWhere = tokens
    .map(() => `(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR terms LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`)
    .join(' AND ');
  const likeParams: string[] = [];
  for (const token of tokens) {
    const pattern = `%${likeEscape(token)}%`;
    likeParams.push(pattern, pattern, pattern, pattern);
  }
  const likeRows = store.db
    .prepare(`SELECT * FROM nodes WHERE ${likeWhere}${kindClause} LIMIT ?`)
    .all(...likeParams, ...kinds, limit * 5) as unknown as GraphNode[];

  const byId = new Map<number, GraphNode>();
  const queryLower = trimmed.toLowerCase();
  for (const row of likeRows) {
    const node = decodeNode(row as never);
    byId.set(node.id, node);
    const nameLower = node.name.toLowerCase();
    let score: number;
    if (nameLower === queryLower) score = 0;
    else if (nameLower.startsWith(queryLower)) score = 1;
    else if (nameLower.includes(queryLower)) score = 2;
    else if ((node.path ?? '').toLowerCase().includes(queryLower)) score = 3;
    else score = 4;
    const prior = scores.get(node.id);
    if (prior === undefined || score < prior) scores.set(node.id, score);
    if (!ranked.includes(node.id)) ranked.push(node.id);
  }

  const ftsNodes = store.nodesByIds(ranked);
  for (const node of ftsNodes) byId.set(node.id, node);

  let nodes = [...byId.values()];
  if (kinds.length > 0) nodes = nodes.filter((n) => kinds.includes(n.kind));
  nodes.sort((a, b) => {
    const sa = scores.get(a.id) ?? 99;
    const sb = scores.get(b.id) ?? 99;
    if (sa !== sb) return sa - sb;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.name.localeCompare(b.name);
  });

  return { nodes: nodes.slice(0, limit), scores };
}

export interface WalkResult {
  nodes: GraphNode[];
  depths: Map<number, number>;
}

/**
 * Operator 2 — `walk`: recursive-CTE traversal.
 *
 * Cycle protection is path-based: a branch stops when the next node id already
 * appears in the path it travelled, so `a -> b -> a` terminates at depth 1.
 */
export function walkNodes(
  store: GraphStore,
  startRefs: NodeRef[],
  options: WalkOptions = {},
): WalkResult {
  const startIds = store.resolveIds(startRefs);
  if (startIds.length === 0) return { nodes: [], depths: new Map() };

  const maxDepth = clamp(options.maxDepth ?? 6, 0, 20);
  const limit = clamp(options.limit ?? 2000, 1, 10000);
  const edgeTypes = asArray(options.edgeType);
  const types = edgeTypes.length > 0 ? assertEdgeTypes(edgeTypes) : null;
  const direction = options.direction ?? 'out';

  const depths = new Map<number, number>();
  const directions: ('out' | 'in')[] =
    direction === 'both' ? ['out', 'in'] : [direction === 'in' ? 'in' : 'out'];

  if (maxDepth === 0) {
    for (const id of startIds) depths.set(id, 0);
  } else {
    for (const dir of directions) {
      const rows = runWalk(store, startIds, { direction: dir, maxDepth, limit, types });
      for (const row of rows) {
        const prior = depths.get(row.id);
        if (prior === undefined || row.depth < prior) depths.set(row.id, row.depth);
      }
    }
  }

  const ids = [...depths.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([id]) => id);

  const nodes = store.nodesByIds(ids);
  return { nodes, depths };
}

function runWalk(
  store: GraphStore,
  startIds: number[],
  opts: { direction: 'out' | 'in'; maxDepth: number; limit: number; types: string[] | null },
): { id: number; depth: number }[] {
  const startPlaceholders = startIds.map(() => '?').join(',');
  const fromColumn = opts.direction === 'out' ? 'src' : 'dst';
  const toColumn = opts.direction === 'out' ? 'dst' : 'src';
  const typeClause =
    opts.types && opts.types.length > 0
      ? ` AND e.type IN (${opts.types.map(() => '?').join(',')})`
      : '';

  const sql = `
    WITH RECURSIVE walk(id, depth, path) AS (
      SELECT id, 0, ',' || id || ',' FROM nodes WHERE id IN (${startPlaceholders})
      UNION ALL
      SELECT e.${toColumn}, w.depth + 1, w.path || e.${toColumn} || ','
      FROM walk w
      JOIN edges e ON e.${fromColumn} = w.id
      WHERE w.depth < ?
        AND instr(w.path, ',' || e.${toColumn} || ',') = 0
        ${typeClause}
    )
    SELECT id, MIN(depth) AS depth
    FROM walk
    GROUP BY id
    ORDER BY depth ASC, id ASC
    LIMIT ?`;

  const params: (string | number)[] = [...startIds, opts.maxDepth, ...(opts.types ?? []), opts.limit];
  return store.db.prepare(sql).all(...params) as { id: number; depth: number }[];
}

/**
 * Operator 3 — `filter`: declarative predicate over a node set.
 */
export function filterNodes(
  store: GraphStore,
  ids: number[],
  predicate: NodePredicate,
): { nodes: GraphNode[]; ids: number[] } {
  if (ids.length === 0) return { nodes: [], ids: [] };
  const where: string[] = [];
  const params: (string | number)[] = []; // only used by SQL below

  const idPlaceholders = ids.map(() => '?').join(',');
  where.push(`id IN (${idPlaceholders})`);

  if (predicate.kind) {
    const kinds = assertNodeKinds(asArray(predicate.kind));
    if (kinds.length > 0) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
  }
  if (predicate.notKind) {
    const kinds = assertNodeKinds(asArray(predicate.notKind));
    if (kinds.length > 0) {
      where.push(`kind NOT IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
  }
  if (predicate.pathPrefix) {
    where.push(`path LIKE ? ESCAPE '\\'`);
    params.push(`${likeEscape(toPosix(predicate.pathPrefix))}%`);
  }
  if (predicate.pathSuffix) {
    where.push(`path LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(toPosix(predicate.pathSuffix))}`);
  }
  if (predicate.pathGlob) {
    where.push(`path LIKE ? ESCAPE '\\'`);
    params.push(globToLike(toPosix(predicate.pathGlob)));
  }
  if (predicate.nameContains) {
    where.push(`name LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(predicate.nameContains)}%`);
  }
  if (predicate.tag) {
    where.push(`tags LIKE ? ESCAPE '\\'`);
    params.push(`%${likeEscape(`"${predicate.tag}"`)}%`);
  }

  const sql = `SELECT * FROM nodes WHERE ${where.join(' AND ')} ORDER BY kind, name`;
  const fullParams = [...ids, ...params];
  const rows = store.db.prepare(sql).all(...fullParams) as unknown as GraphNode[];
  let nodes = rows.map((row) => decodeNode(row as never));

  if (predicate.nameMatches) {
    let re: RegExp;
    try {
      re = new RegExp(predicate.nameMatches, 'i');
    } catch (error) {
      throw new Error(`Invalid nameMatches regex: ${(error as Error).message}`);
    }
    nodes = nodes.filter((node) => re.test(node.name));
  }

  const limited = predicate.limit ? nodes.slice(0, clamp(predicate.limit, 1, 10000)) : nodes;
  return { nodes: limited, ids: limited.map((n) => n.id) };
}

/**
 * Operator 4 — `minus`: set difference `a \ b`.
 */
export function minusNodes(a: number[], b: number[]): number[] {
  const excluded = new Set(b);
  return a.filter((id) => !excluded.has(id));
}

export interface OrphanResult {
  files: NodeView[];
  symbols: NodeView[];
  counts: { files: number; symbols: number };
}

/**
 * Files with no inbound `imports`/`links_to` edge (dead entry points), and
 * symbols that are never exported (dead-code candidates).
 */
export function findOrphans(
  store: GraphStore,
  options: { includeEntries?: boolean; includeTests?: boolean; limit?: number } = {},
): OrphanResult {
  const limit = clamp(options.limit ?? 100, 1, 1000);
  const entryFilter = options.includeEntries ? '' : ` AND tags NOT LIKE '%"entry"%'`;
  const testFilter = options.includeTests ? '' : ` AND tags NOT LIKE '%"test"%'`;
  const fileRows = store.db
    .prepare(
      `SELECT * FROM nodes n
       WHERE n.kind = 'file'
         AND n.tags NOT LIKE '%"manifest"%'
         AND NOT EXISTS (
           SELECT 1 FROM edges e
           WHERE e.dst = n.id AND e.src <> n.id AND e.type IN ('imports','links_to')
         )${entryFilter}${testFilter}
       ORDER BY n.path
       LIMIT ?`,
    )
    .all(limit) as unknown as GraphNode[];

  const symbolRows = store.db
    .prepare(
      `SELECT * FROM nodes n
       WHERE n.kind = 'symbol'
         AND NOT EXISTS (
           SELECT 1 FROM edges e WHERE e.dst = n.id AND e.type = 'exports'
         )
       ORDER BY n.path, n.line
       LIMIT ?`,
    )
    .all(limit) as unknown as GraphNode[];

  const files = fileRows.map((row) => toNodeView(decodeNode(row as never)));
  const symbols = symbolRows.map((row) => toNodeView(decodeNode(row as never)));
  return { files, symbols, counts: { files: files.length, symbols: symbols.length } };
}

export function toNodeView(node: GraphNode, depth?: number): NodeView {
  const view: NodeView = {
    ...node,
    citation: node.path ? `${node.path}${node.line ? `:${node.line}` : ''}` : null,
    snippet: snippet(node.content),
  };
  if (depth !== undefined) view.depth = depth;
  return view;
}

export function toEdgeViews(
  store: GraphStore,
  edges: GraphEdge[],
): EdgeView[] {
  const ids = [...new Set(edges.flatMap((e) => [e.src, e.dst]))];
  const nodes = new Map(store.nodesByIds(ids).map((n) => [n.id, n]));
  return edges.map((edge) => {
    const dst = nodes.get(edge.dst);
    return {
      src: edge.src,
      dst: edge.dst,
      type: edge.type,
      line: edge.line,
      citation: dst?.path ? `${dst.path}${edge.line ? `:${edge.line}` : ''}` : null,
    };
  });
}
