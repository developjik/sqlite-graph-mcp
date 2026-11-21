import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphStore } from '../src/db.js';
import { indexWorkspace } from '../src/indexer.js';
import type { GraphNode, IndexStats } from '../src/types.js';

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const fixtureRoot = join(repoRoot, 'test', 'fixtures', 'ws');
export const monoRoot = join(repoRoot, 'test', 'fixtures', 'mono');
export const cliPath = join(repoRoot, 'dist', 'bin', 'cli.js');

export interface FixtureGraph {
  dir: string;
  dbPath: string;
  stats: IndexStats;
  store: GraphStore;
  cleanup: () => void;
}

export function tempDir(prefix = 'sqlite-graph'): string {
  const base = join(repoRoot, '.vitest');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

export async function createFixtureGraph(options: {
  dbPath?: string;
  root?: string;
  engine?: 'ast' | 'heuristic';
} = {}): Promise<FixtureGraph> {
  const dir = options.dbPath ? dirname(options.dbPath) : tempDir();
  const dbPath = options.dbPath ?? join(dir, 'index.db');
  const stats = await indexWorkspace({
    root: options.root ?? fixtureRoot,
    dbPath,
    engine: options.engine,
  });
  const store = new GraphStore(dbPath);
  return {
    dir,
    dbPath,
    stats,
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function idsOfKeys(store: GraphStore, keys: string[]): number[] {
  return keys.map((key) => {
    const node = store.nodeByKey(key);
    if (!node) throw new Error(`Missing node: ${key}`);
    return node.id;
  });
}

export function keySet(nodes: GraphNode[]): Set<string> {
  return new Set(nodes.map((node) => node.key));
}

export function citations(nodes: GraphNode[]): string[] {
  return nodes.map((node) => `${node.path}:${node.line}`);
}
