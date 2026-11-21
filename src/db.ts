import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EdgeType, GraphEdge, GraphNode, NodeKind } from './types.js';
import { buildTerms } from './util.js';

export interface NodeInput {
  key: string;
  kind: NodeKind;
  name: string;
  path?: string | null;
  line?: number | null;
  content?: string | null;
  terms?: string | null;
  meta?: Record<string, unknown>;
  tags?: string[];
}

export interface NodeRow {
  id: number;
  key: string;
  kind: string;
  name: string;
  path: string | null;
  line: number | null;
  content: string | null;
  terms: string | null;
  meta: string;
  tags: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS graph_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  key     TEXT NOT NULL UNIQUE,
  kind    TEXT NOT NULL CHECK (kind IN ('file','symbol','heading','package')),
  name    TEXT NOT NULL,
  path    TEXT,
  line    INTEGER,
  content TEXT,
  terms   TEXT NOT NULL DEFAULT '',
  meta    TEXT NOT NULL DEFAULT '{}',
  tags    TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS nodes_kind_idx ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_path_idx ON nodes(path);

CREATE TABLE IF NOT EXISTS edges (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  src  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  dst  INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('imports','exports','defines','links_to','depends_on','references')),
  line INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  UNIQUE (src, dst, type)
);

CREATE INDEX IF NOT EXISTS edges_src_idx ON edges(src, type);
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges(dst, type);
CREATE INDEX IF NOT EXISTS edges_type_idx ON edges(type);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  name,
  path,
  terms,
  content,
  content='nodes',
  content_rowid='id',
  tokenize="unicode61 tokenchars '_.$#@-'"
);

CREATE TRIGGER IF NOT EXISTS nodes_fts_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, name, path, terms, content)
  VALUES (new.id, new.name, new.path, new.terms, new.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, path, terms, content)
  VALUES ('delete', old.id, old.name, old.path, old.terms, old.content);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, name, path, terms, content)
  VALUES ('delete', old.id, old.name, old.path, old.terms, old.content);
  INSERT INTO nodes_fts(rowid, name, path, terms, content)
  VALUES (new.id, new.name, new.path, new.terms, new.content);
END;
`;

export const SCHEMA_VERSION = '2';

export class GraphStore {
  readonly db: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    const existingVersion = this.getMeta('schema_version');
    if (existingVersion !== null && existingVersion !== SCHEMA_VERSION) {
      // Incompatible schema (e.g. an edge CHECK without `references`): rebuild
      // from scratch. The graph is derived data; the next index run refills it.
      this.db.exec(
        'DROP TABLE IF EXISTS nodes_fts; DROP TABLE IF EXISTS edges; ' +
          'DROP TABLE IF EXISTS nodes; DROP TABLE IF EXISTS graph_meta;',
      );
      this.db.exec(SCHEMA);
    }
    this.setMetaIfEmpty('schema_version', SCHEMA_VERSION);
  }

  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // checkpoint is best-effort (fails on :memory: or read-only handles)
    }
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Remove every node; edges and the FTS index cascade. */
  clear(): void {
    this.db.prepare('DELETE FROM nodes').run();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM graph_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO graph_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private setMetaIfEmpty(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO graph_meta(key, value) VALUES (?, ?)').run(key, value);
  }

  insertNode(node: NodeInput): number {
    const terms = node.terms ?? buildTerms(node.name, node.path ?? null);
    const info = this.db
      .prepare(
        `INSERT INTO nodes(key, kind, name, path, line, content, terms, meta, tags)
         VALUES (@key, @kind, @name, @path, @line, @content, @terms, @meta, @tags)
         ON CONFLICT(key) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           path = excluded.path,
           line = excluded.line,
           content = excluded.content,
           terms = excluded.terms,
           meta = excluded.meta,
           tags = excluded.tags`,
      )
      .run({
        key: node.key,
        kind: node.kind,
        name: node.name,
        path: node.path ?? null,
        line: node.line ?? null,
        content: node.content ?? null,
        terms,
        meta: JSON.stringify(node.meta ?? {}),
        tags: JSON.stringify(node.tags ?? []),
      });
    void info;
    const existing = this.db.prepare('SELECT id FROM nodes WHERE key = ?').get(node.key) as
      | { id: number }
      | undefined;
    if (!existing) throw new Error(`Failed to insert node ${node.key}`);
    return existing.id;
  }

  addEdge(src: number, dst: number, type: EdgeType, line: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO edges(src, dst, type, line) VALUES (?, ?, ?, ?)
         ON CONFLICT(src, dst, type) DO UPDATE SET line = COALESCE(excluded.line, edges.line)`,
      )
      .run(src, dst, type, line);
  }

  nodeById(id: number): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as NodeRow | undefined;
    return row ? decodeNode(row) : null;
  }

  nodeByKey(key: string): GraphNode | null {
    const row = this.db.prepare('SELECT * FROM nodes WHERE key = ?').get(key) as NodeRow | undefined;
    return row ? decodeNode(row) : null;
  }

  /** Resolve numeric ids or stable keys to node ids, preserving input order. */
  resolveIds(refs: (number | string)[]): number[] {
    const out: number[] = [];
    const byId = this.db.prepare('SELECT id FROM nodes WHERE id = ?');
    const byKey = this.db.prepare('SELECT id FROM nodes WHERE key = ?');
    for (const ref of refs) {
      let id: number | undefined;
      if (typeof ref === 'number') {
        id = (byId.get(ref) as { id: number } | undefined)?.id;
      } else if (/^\d+$/.test(ref)) {
        id = (byId.get(Number(ref)) as { id: number } | undefined)?.id;
      }
      if (id === undefined) {
        id = (byKey.get(String(ref)) as { id: number } | undefined)?.id;
      }
      if (id !== undefined) out.push(id);
    }
    return [...new Set(out)];
  }

  nodesByIds(ids: number[]): GraphNode[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids) as NodeRow[];
    const byId = new Map(rows.map((row) => [row.id, decodeNode(row)]));
    return ids.map((id) => byId.get(id)).filter((n): n is GraphNode => Boolean(n));
  }

  edgesFor(ids: number[], direction: 'out' | 'in' | 'both' = 'both'): GraphEdge[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const clauses: string[] = [];
    if (direction === 'out' || direction === 'both') clauses.push(`src IN (${placeholders})`);
    if (direction === 'in' || direction === 'both') clauses.push(`dst IN (${placeholders})`);
    const params = direction === 'both' ? [...ids, ...ids] : ids;
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE ${clauses.join(' OR ')} ORDER BY id`)
      .all(...params) as GraphEdge[];
    return rows.map((r) => ({ id: r.id, src: r.src, dst: r.dst, type: r.type, line: r.line }));
  }

  countNodes(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
  }

  counts(): Record<string, number> {
    const nodes = this.db
      .prepare('SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind')
      .all() as { kind: string; c: number }[];
    const edges = this.db
      .prepare('SELECT type, COUNT(*) AS c FROM edges GROUP BY type')
      .all() as { type: string; c: number }[];
    const out: Record<string, number> = {};
    const nodeTotal = nodes.reduce((acc, n) => acc + n.c, 0);
    const edgeTotal = edges.reduce((acc, e) => acc + e.c, 0);
    for (const n of nodes) out[`node:${n.kind}`] = n.c;
    out['node:total'] = nodeTotal;
    for (const e of edges) out[`edge:${e.type}`] = e.c;
    out['edge:total'] = edgeTotal;
    return out;
  }

  /**
   * Cheap health check: the first user query works even for a database that was
   * built by an older version, and a missing FTS table is rebuilt.
   */
  rebuildFts(): void {
    this.db.prepare("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')").run();
  }
}

export function decodeNode(row: NodeRow): GraphNode {
  let meta: Record<string, unknown> = {};
  let tags: string[] = [];
  try {
    meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  try {
    tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    key: row.key,
    kind: row.kind as NodeKind,
    name: row.name,
    path: row.path,
    line: row.line,
    content: row.content,
    meta,
    tags,
  };
}

/** Default graph database location for a workspace root. */
export function defaultDbPath(root: string): string {
  return `${root.replace(/[\\/]+$/, '')}/.sqlite-graph/index.db`;
}
