import { rmSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import { GraphStore } from '../src/db.js';
import { tempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('GraphStore schema', () => {
  it('accepts references edges on a fresh database', () => {
    const dir = tempDir('db-fresh');
    dirs.push(dir);
    const store = new GraphStore(`${dir}/index.db`);
    const a = store.insertNode({
      key: 'file:src/a.ts',
      kind: 'file',
      name: 'a.ts',
      path: 'src/a.ts',
    });
    const b = store.insertNode({
      key: 'symbol:src/a.ts#fn',
      kind: 'symbol',
      name: 'fn',
      path: 'src/a.ts',
      line: 3,
    });
    expect(() => store.addEdge(a, b, 'references', 1)).not.toThrow();
    store.close();
  });

  it('rebuilds from scratch when the stored schema version is older', () => {
    const dir = tempDir('db-migrate');
    dirs.push(dir);
    const dbPath = `${dir}/index.db`;

    const first = new GraphStore(dbPath);
    first.insertNode({ key: 'file:old.ts', kind: 'file', name: 'old.ts', path: 'old.ts' });
    expect(first.countNodes()).toBe(1);
    first.db.prepare("UPDATE graph_meta SET value = '1' WHERE key = 'schema_version'").run();
    first.close();

    const second = new GraphStore(dbPath);
    // v1 layout is gone: the graph is derived data and rebuilds on the next
    // index run (the MCP server auto-indexes when it finds zero nodes).
    expect(second.countNodes()).toBe(0);
    expect(second.getMeta('schema_version')).toBe('2');
    const a = second.insertNode({
      key: 'file:src/a.ts',
      kind: 'file',
      name: 'a.ts',
      path: 'src/a.ts',
    });
    const b = second.insertNode({
      key: 'symbol:src/a.ts#fn',
      kind: 'symbol',
      name: 'fn',
      path: 'src/a.ts',
    });
    expect(() => second.addEdge(a, b, 'references', 1)).not.toThrow();
    second.close();
  });
});
