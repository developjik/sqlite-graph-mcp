import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { diffWorkspaces, graphDiff } from '../src/diff.js';
import { indexWorkspace } from '../src/indexer.js';
import { fixtureRoot, repoRoot, tempDir } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function mutatedFixture(mutate: (dir: string) => void): string {
  const dir = join(tempDir('diff-fixture'), 'ws');
  dirs.push(dirnameOf(dir));
  cpSync(fixtureRoot, dir, { recursive: true });
  mutate(dir);
  return dir;
}

function dirnameOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

describe('graph diff', () => {
  it('flags a removed export that other files still reference', async () => {
    const head = mutatedFixture((dir) => {
      // walkGraph is used by src/index.ts and walker.test.ts — drop the export.
      const file = join(dir, 'src/graph/walker.ts');
      writeFileSync(file, writeFileSync.length >= 0 ? read(file).replace('export function walkGraph', 'function walkGraph') : '');
    });
    const diff = await diffWorkspaces(repoRoot, fixtureRoot, head, { engine: 'heuristic' });
    expect(diff.counts.breaking).toBe(1);
    const change = diff.breaking[0]!;
    expect(change.symbol.name).toBe('walkGraph');
    expect(change.unexportedOnly).toBe(true);
    expect(change.importers.map((i) => i.key).sort()).toEqual([
      'file:src/graph/walker.test.ts',
      'file:src/index.ts',
    ]);
    // Every importer cites the usage line, not the export.
    expect(change.importers.every((i) => i.citation && /:\d+$/.test(i.citation))).toBe(true);
  });

  it('flags a deleted file whose exported symbols were referenced', async () => {
    const head = mutatedFixture((dir) => {
      rmSync(join(dir, 'src/greet.ts'));
    });
    const diff = await diffWorkspaces(repoRoot, fixtureRoot, head, { engine: 'heuristic' });
    const names = diff.breaking.map((c) => c.symbol.name);
    expect(names).toContain('greet'); // referenced by src/index.ts
    expect(diff.breaking.find((c) => c.symbol.name === 'greet')?.unexportedOnly).toBe(false);
    expect(names).not.toContain('internalGreeting'); // never referenced → not breaking
    expect(diff.counts.removedNodes).toBeGreaterThan(0);
  });

  it('reports files that lost their last inbound edge as new orphans', async () => {
    const head = mutatedFixture((dir) => {
      // src/index.ts is linked only from README.md — drop that link.
      const readme = join(dir, 'README.md');
      writeFileSync(readme, read(readme).replace('[src/index.ts](./src/index.ts)', 'src/index.ts'));
    });
    const diff = await diffWorkspaces(repoRoot, fixtureRoot, head, { engine: 'heuristic' });
    expect(diff.newOrphans.map((n) => n.key)).toContain('file:src/index.ts');
    expect(diff.counts.breaking).toBe(0);
  });

  it('returns an empty diff for identical sides', async () => {
    const diff = await diffWorkspaces(repoRoot, fixtureRoot, fixtureRoot, { engine: 'heuristic' });
    expect(diff.counts).toEqual({
      addedNodes: 0,
      removedNodes: 0,
      addedEdges: 0,
      removedEdges: 0,
      breaking: 0,
      newOrphans: 0,
    });
    expect(diff.truncated).toBe(false);
  });

  it('diffs git revisions inside a repository', async () => {
    // v0.2.0 → HEAD on this repository changed references semantics but kept
    // every export, so nothing is breaking — while the raw counts moved a lot.
    const diff = await diffWorkspaces(repoRoot, 'df96fe4', 'HEAD');
    expect(diff.base.rev).toBe('df96fe4');
    expect(diff.head.rev).toBe('HEAD');
    expect(diff.counts.addedNodes).toBeGreaterThan(0);
    expect(diff.counts.breaking).toBe(0);
  }, 30000);

  it('rejects an unknown git revision without touching anything', async () => {
    await expect(diffWorkspaces(repoRoot, 'no-such-rev', 'HEAD')).rejects.toThrow();
  });
});

function read(path: string): string {
  // Local read helper so the fixture mutation reads like the source edit it is.
  return require('node:fs').readFileSync(path, 'utf8') as string;
}

describe('graphDiff (store level)', () => {
  it('is symmetric when sides are swapped', async () => {
    const head = mutatedFixture((dir) => {
      writeFileSync(
        join(dir, 'src/new.ts'),
        "import { greet } from './greet.js';\nexport const TAG = greet('x');\n",
      );
    });
    const scratch = tempDir('diff-stores');
    dirs.push(scratch);
    const baseDb = join(scratch, 'base.db');
    const headDb = join(scratch, 'head.db');
    await indexWorkspace({ root: fixtureRoot, dbPath: baseDb, engine: 'heuristic' });
    await indexWorkspace({ root: head, dbPath: headDb, engine: 'heuristic' });

    const { GraphStore } = await import('../src/db.js');
    const a = new GraphStore(baseDb);
    const b = new GraphStore(headDb);
    const info = { root: 'a', rev: null, stats: null as never };
    const forward = graphDiff(a, b, info, info);
    const backward = graphDiff(b, a, info, info);
    expect(forward.counts.addedNodes).toBe(backward.counts.removedNodes);
    expect(forward.counts.addedEdges).toBe(backward.counts.removedEdges);
    expect(forward.counts.breaking).toBe(0);
    // greet is now referenced from the new file, so removing it would break.
    a.close();
    b.close();
  });
});
