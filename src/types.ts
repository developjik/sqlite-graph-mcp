/**
 * Public types for sqlite-graph-mcp.
 *
 * The graph is intentionally small: four node kinds and five edge types.
 * Everything the query engine does is a set operation over node ids.
 */

export const NODE_KINDS = ['file', 'symbol', 'heading', 'package'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = ['imports', 'exports', 'defines', 'links_to', 'depends_on'] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export type WalkDirection = 'out' | 'in' | 'both';

/** A row of `nodes`, decoded. */
export interface GraphNode {
  id: number;
  /** Stable identity across re-indexing, e.g. `symbol:src/greet.ts#greet`. */
  key: string;
  kind: NodeKind;
  name: string;
  /** Workspace-relative POSIX path, when the node belongs to a file. */
  path: string | null;
  /** 1-based line of the declaration/heading, for citations. */
  line: number | null;
  /** Declaration line or heading text, kept short for snippets. */
  content: string | null;
  meta: Record<string, unknown>;
  tags: string[];
}

/** A row of `edges`. */
export interface GraphEdge {
  id: number;
  src: number;
  dst: number;
  type: EdgeType;
  line: number | null;
}

/** A node as returned to a caller, with its evidence citation attached. */
export interface NodeView extends GraphNode {
  /** `path:line` when the node has a location. */
  citation: string | null;
  /** Trimmed source line, capped for transport safety. */
  snippet: string | null;
  /** Traversal distance when the node came out of a `walk`. */
  depth?: number;
}

export interface EdgeView {
  src: number;
  dst: number;
  type: EdgeType;
  line: number | null;
  /** `path:line` of the edge's destination, when resolvable. */
  citation: string | null;
}

export interface FindOptions {
  kind?: NodeKind | NodeKind[];
  limit?: number;
}

export interface WalkOptions {
  /** Edge types to follow. Defaults to every type. */
  edgeType?: EdgeType | EdgeType[];
  direction?: WalkDirection;
  /** Defaults to 6, clamped to 20. */
  maxDepth?: number;
  limit?: number;
}

/** Declarative predicate used by the `filter` operator (JSON-safe). */
export interface NodePredicate {
  kind?: NodeKind | NodeKind[];
  /** Keep nodes whose kind is not one of these. */
  notKind?: NodeKind | NodeKind[];
  /** Path starts with this string (POSIX separators). */
  pathPrefix?: string;
  /** Path ends with this string. */
  pathSuffix?: string;
  /** Glob over the path: `**` any chars, `*` within a segment, `?` one char. */
  pathGlob?: string;
  /** Case-insensitive substring of the node name. */
  nameContains?: string;
  /** Case-insensitive JavaScript regex over the node name. */
  nameMatches?: string;
  /** Node must carry this tag (see indexer tags). */
  tag?: string;
  /** Traversal depth ceiling, only meaningful right after a walk. */
  maxDepth?: number;
  limit?: number;
}

export type PlanStep =
  | ({ op: 'find'; query: string } & FindOptions)
  | ({ op: 'walk'; start?: NodeRef[] } & WalkOptions)
  | { op: 'filter'; predicate: NodePredicate }
  | { op: 'minus'; set: PlanStep[] };

export interface Plan {
  steps: PlanStep[];
  limit?: number;
}

/** A node reference is either its numeric id or its stable key. */
export type NodeRef = number | string;

export interface IndexOptions {
  /** Workspace directory to index. */
  root: string;
  /** SQLite file path. Defaults to `<root>/.sqlite-graph/index.db`. */
  dbPath?: string;
  /** Extra directory/file names to skip, on top of the built-in list. */
  ignore?: string[];
  /** Hard cap on indexed files. Defaults to 5000. */
  maxFiles?: number;
  /** Skip files larger than this many bytes. Defaults to 512 KiB. */
  maxFileBytes?: number;
}

export interface IndexStats {
  root: string;
  dbPath: string;
  files: number;
  skippedFiles: number;
  nodes: Record<NodeKind, number> & { total: number };
  edges: Record<EdgeType, number> & { total: number };
  durationMs: number;
  indexedAt: string;
}

export interface StepSummary {
  index: number;
  op: PlanStep['op'];
  params: Record<string, unknown>;
  inputCount: number;
  outputCount: number;
}

export interface AnswerResult {
  count: number;
  nodes: NodeView[];
  edges: EdgeView[];
  citations: string[];
  steps: StepSummary[];
  explain: string[];
  truncated: boolean;
}
