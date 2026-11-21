import { afterEach, describe, expect, it } from 'vitest';

import { filterNodes, findNodes, findOrphans, minusNodes, walkNodes } from '../src/query.js';
import { createFixtureGraph, idsOfKeys, keySet, type FixtureGraph } from './helpers.js';

let graph: FixtureGraph | null = null;
afterEach(() => {
  graph?.cleanup();
  graph = null;
});

async function setup(): Promise<FixtureGraph> {
  graph = await createFixtureGraph();
  return graph;
}

describe('find (operator 1)', () => {
  it('finds camelCase terms split out of identifiers', async () => {
    const { store } = await setup();
    const found = findNodes(store, 'emoji', { kind: 'symbol' });
    expect(found.nodes.map((n) => n.name)).toEqual(['greetEmoji']);
  });

  it('ranks an exact name match first', async () => {
    const { store } = await setup();
    const found = findNodes(store, 'walkGraph', { kind: 'symbol', limit: 5 });
    expect(found.nodes[0]?.name).toBe('walkGraph');
    expect(found.nodes[0]?.path).toBe('src/graph/walker.ts');
  });

  it('falls back to substring matching for partial words', async () => {
    const { store } = await setup();
    const found = findNodes(store, 'Walk', { kind: 'symbol' });
    const names = found.nodes.map((n) => n.name);
    expect(names).toContain('walkGraph');
    expect(names).toContain('WalkOptions');
  });

  it('lists every node of a kind with "*"', async () => {
    const { store } = await setup();
    const found = findNodes(store, '*', { kind: 'package', limit: 10 });
    expect(new Set(found.nodes.map((n) => n.name))).toEqual(
      new Set(['fixture-app', 'left-pad', 'vitest']),
    );
  });

  it('restricts results to the requested kinds', async () => {
    const { store } = await setup();
    const found = findNodes(store, 'spec', { kind: 'heading' });
    expect(found.nodes.length).toBeGreaterThan(0);
    expect(found.nodes.every((n) => n.kind === 'heading')).toBe(true);
  });

  it('returns nothing for an unknown term instead of throwing', async () => {
    const { store } = await setup();
    expect(findNodes(store, 'zzz-not-a-symbol').nodes).toEqual([]);
  });
});

describe('walk (operator 2)', () => {
  it('follows imports outward with depth', async () => {
    const { store } = await setup();
    const start = idsOfKeys(store, ['file:src/index.ts']);
    const walked = walkNodes(store, start, { edgeType: 'imports', direction: 'out', maxDepth: 3 });
    const keys = keySet(walked.nodes);
    expect(keys.has('file:src/index.ts')).toBe(true);
    expect(keys.has('file:src/greet.ts')).toBe(true);
    expect(keys.has('file:src/graph/walker.ts')).toBe(true);
    expect(keys.has('file:src/graph/cycle-a.ts')).toBe(true);
    expect(keys.has('file:src/graph/cycle-b.ts')).toBe(true);
    expect(walked.depths.get(store.nodeByKey('file:src/index.ts')?.id as number)).toBe(0);
    expect(walked.depths.get(store.nodeByKey('file:src/graph/cycle-b.ts')?.id as number)).toBe(3);
  });

  it('stops on a cycle instead of looping forever', async () => {
    const { store } = await setup();
    const start = idsOfKeys(store, ['file:src/graph/cycle-a.ts']);
    const walked = walkNodes(store, start, { edgeType: 'imports', direction: 'out', maxDepth: 20 });
    expect(keySet(walked.nodes)).toEqual(new Set(['file:src/graph/cycle-a.ts', 'file:src/graph/cycle-b.ts']));
    expect(walked.nodes.length).toBe(2);
  });

  it('walks inbound edges to find dependents', async () => {
    const { store } = await setup();
    const start = idsOfKeys(store, ['file:src/greet.ts']);
    const walked = walkNodes(store, start, { edgeType: 'imports', direction: 'in' });
    expect(keySet(walked.nodes).has('file:src/index.ts')).toBe(true);
  });

  it('walks both directions and multiple edge types', async () => {
    const { store } = await setup();
    const start = idsOfKeys(store, ['file:src/graph/walker.ts']);
    const walked = walkNodes(store, start, { direction: 'both', maxDepth: 1 });
    const keys = keySet(walked.nodes);
    expect(keys.has('file:src/index.ts')).toBe(true); // importer
    expect(keys.has('file:src/graph/cycle-a.ts')).toBe(true); // imported
    expect(keys.has('file:docs/spec.md')).toBe(true); // markdown link
    expect(keys.has('symbol:src/graph/walker.ts#walkGraph')).toBe(true); // defined
  });

  it('respects maxDepth 0 and resolves keys as well as ids', async () => {
    const { store } = await setup();
    const walked = walkNodes(store, ['file:src/index.ts'], { maxDepth: 0 });
    expect(walked.nodes).toHaveLength(1);
    expect(walked.nodes[0]?.key).toBe('file:src/index.ts');
  });

  it('returns an empty result for unknown refs', async () => {
    const { store } = await setup();
    expect(walkNodes(store, ['file:does/not/exist.ts']).nodes).toEqual([]);
  });

  it('walks inbound references to list the files that use a symbol', async () => {
    const { store } = await setup();
    const walked = walkNodes(store, idsOfKeys(store, ['symbol:src/graph/walker.ts#walkGraph']), {
      edgeType: 'references',
      direction: 'in',
      maxDepth: 1,
    });
    const keys = keySet(walked.nodes);
    expect(keys.has('file:src/index.ts')).toBe(true);
    expect(keys.has('file:src/graph/walker.test.ts')).toBe(true);
    expect(walked.nodes.every((n) => n.kind === 'file' || n.kind === 'symbol')).toBe(true);
  });
});

describe('filter (operator 3)', () => {
  it('filters a set by kind, path prefix and tag', async () => {
    const { store } = await setup();
    const all = idsOfKeys(store, [
      'symbol:src/graph/walker.ts#walkGraph',
      'symbol:src/graph/walker.ts#WalkOptions',
      'symbol:src/greet.ts#internalGreeting',
      'file:src/graph/walker.ts',
    ]);
    const filtered = filterNodes(store, all, {
      kind: 'symbol',
      pathPrefix: 'src/graph/',
      tag: 'exported',
    });
    expect(filtered.nodes.map((n) => n.name).sort()).toEqual(['WalkOptions', 'walkGraph']);
  });

  it('supports globs, suffix matching and regexes', async () => {
    const { store } = await setup();
    const files = Object.values(
      findNodes(store, '*', { kind: 'file', limit: 100 }).nodes.reduce<Record<number, number>>(
        (acc, node) => {
          acc[node.id] = node.id;
          return acc;
        },
        {},
      ),
    );
    const tests = filterNodes(store, files, { pathGlob: '**/*.test.ts' });
    expect(tests.nodes.map((n) => n.path)).toEqual(['src/graph/walker.test.ts']);

    const markdown = filterNodes(store, files, { pathSuffix: '.md' });
    expect(markdown.nodes.length).toBe(4);

    const matched = filterNodes(store, files, { nameMatches: '^spec' });
    expect(matched.nodes.map((n) => n.name)).toEqual(['spec.md']);
  });

  it('returns an empty set for an empty input', async () => {
    const { store } = await setup();
    expect(filterNodes(store, [], { kind: 'file' }).nodes).toEqual([]);
  });

  it('rejects unknown kinds', async () => {
    const { store } = await setup();
    expect(() => filterNodes(store, [1], { kind: 'bogus' as never })).toThrow(/Unknown node kind/);
  });
});

describe('minus (operator 4)', () => {
  it('computes a set difference', async () => {
    const { store } = await setup();
    const allFiles = findNodes(store, '*', { kind: 'file', limit: 100 }).nodes;
    const tests = filterNodes(
      store,
      allFiles.map((n) => n.id),
      { pathGlob: '**/*.test.ts' },
    );
    const rest = minusNodes(
      allFiles.map((n) => n.id),
      tests.ids,
    );
    expect(rest.length).toBe(allFiles.length - tests.ids.length);
    expect(store.nodesByIds(rest).map((n) => n.path)).not.toContain('src/graph/walker.test.ts');
  });
});

describe('orphans', () => {
  it('lists files without inbound imports or links', async () => {
    const { store } = await setup();
    const result = findOrphans(store);
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('src/legacy.ts');
    expect(paths).not.toContain('src/graph/walker.test.ts'); // tests excluded by default
    expect(paths).not.toContain('src/index.ts'); // linked from README and imported
  });

  it('can include entry points and test files', async () => {
    const { store } = await setup();
    const result = findOrphans(store, { includeEntries: true, includeTests: true });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('src/graph/walker.test.ts');
  });

  it('lists symbols that are never exported', async () => {
    const { store } = await setup();
    const names = findOrphans(store).symbols.map((symbol) => symbol.name).sort();
    expect(names).toEqual(['internalGreeting', 'unusedHelper']);
  });
});
