import { afterEach, describe, expect, it } from 'vitest';

import { executePlan, parseDsl, parsePlan, tokenize } from '../src/plan.js';
import { findNodes } from '../src/query.js';
import { createFixtureGraph, idsOfKeys, type FixtureGraph } from './helpers.js';

let graph: FixtureGraph | null = null;
afterEach(() => {
  graph?.cleanup();
  graph = null;
});

function setup(): FixtureGraph {
  graph = createFixtureGraph();
  return graph;
}

describe('plan parsing', () => {
  it('parses a pipeline with options and a quoted query', () => {
    const plan = parseDsl('find "graph index" kind=symbol limit=5 | walk type=imports,defines dir=in depth=2');
    expect(plan.steps).toHaveLength(2);
    const find = plan.steps[0];
    expect(find.op).toBe('find');
    if (find.op === 'find') {
      expect(find.query).toBe('graph index');
      expect(find.kind).toEqual(['symbol']);
      expect(find.limit).toBe(5);
    }
    const walk = plan.steps[1];
    expect(walk.op).toBe('walk');
    if (walk.op === 'walk') {
      expect(walk.edgeType).toEqual(['imports', 'defines']);
      expect(walk.direction).toBe('in');
      expect(walk.maxDepth).toBe(2);
    }
  });

  it('parses filter options into a declarative predicate', () => {
    const plan = parseDsl('find "*" | filter kind=file path=src/** tag=code limit=7');
    const filter = plan.steps[1];
    expect(filter.op).toBe('filter');
    if (filter.op === 'filter') {
      expect(filter.predicate).toEqual({
        kind: ['file'],
        pathGlob: 'src/**',
        tag: 'code',
        limit: 7,
      });
    }
  });

  it('parses minus with a nested find', () => {
    const plan = parseDsl('find "*" kind=file | minus find "*.test.ts"');
    const minus = plan.steps[1];
    expect(minus.op).toBe('minus');
    if (minus.op === 'minus') {
      expect(minus.set).toHaveLength(1);
      expect(minus.set[0]?.op).toBe('find');
    }
  });

  it('accepts JSON plans and step arrays', () => {
    const fromObject = parsePlan({ steps: [{ op: 'find', query: 'walker', kind: 'symbol' }], limit: 3 });
    expect(fromObject.limit).toBe(3);
    const fromArray = parsePlan([{ op: 'find', query: 'emoji' }]);
    expect(fromArray.steps).toHaveLength(1);
  });

  it('rejects malformed plans with actionable messages', () => {
    expect(() => parseDsl('bogus foo')).toThrow(/Unknown plan op "bogus"/);
    expect(() => parseDsl('find "unterminated')).toThrow(/Unterminated quote/);
    expect(() => parseDsl('find a | walk dir=sideways')).toThrow(/walk dir must be out, in, or both/);
    expect(() => parseDsl('find a | filter limit=many')).toThrow(/must be a number/);
    expect(() => parsePlan({ steps: 'nope' })).toThrow(/steps/);
    expect(() => parseDsl('find a | minus')).toThrow(/minus needs a sub-plan/);
  });

  it('keeps quoted phrases together when tokenizing', () => {
    expect(tokenize('find "graph index" kind=file')).toEqual(['find', 'graph index', 'kind=file']);
  });
});

describe('answer (operator 5)', () => {
  it('runs find → walk → filter and returns citations', () => {
    const { store } = setup();
    const answer = executePlan(
      store,
      'find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file',
    );
    expect(answer.steps.map((s) => s.op)).toEqual(['find', 'walk', 'filter']);
    expect(answer.count).toBeGreaterThan(0);
    expect(answer.citations).toContain('src/graph/walker.ts:1');
    expect(answer.nodes.every((node) => node.kind === 'file')).toBe(true);
    expect(answer.explain).toHaveLength(3);
  });

  it('returns the edges it traversed as evidence', () => {
    const { store } = setup();
    const answer = executePlan(
      store,
      'find "index.ts" kind=file | walk type=imports dir=out depth=1',
    );
    const targets = answer.edges.map((edge) => edge.type);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((type) => type === 'imports')).toBe(true);
    expect(answer.edges.every((edge) => edge.citation !== null)).toBe(true);
  });

  it('supports minus to exclude tests from a file list', () => {
    const { store } = setup();
    const answer = executePlan(store, 'find "*" kind=file | minus find "*.test.ts"');
    const paths = answer.nodes.map((node) => node.path);
    expect(paths).not.toContain('src/graph/walker.test.ts');
    expect(paths).toContain('src/legacy.ts');
  });

  it('accepts a JSON step plan with an explicit walk start', () => {
    const { store } = setup();
    const start = idsOfKeys(store, ['file:src/graph/cycle-a.ts']);
    const answer = executePlan(store, {
      steps: [
        { op: 'walk', start, edgeType: 'imports', direction: 'out', maxDepth: 10 },
        { op: 'filter', predicate: { kind: 'file', nameContains: 'cycle' } },
      ],
    });
    expect(answer.nodes.map((node) => node.path).sort()).toEqual([
      'src/graph/cycle-a.ts',
      'src/graph/cycle-b.ts',
    ]);
    expect(answer.nodes[0]?.depth).toBeDefined();
  });

  it('truncates large answers and reports it', () => {
    const { store } = setup();
    const answer = executePlan(store, { steps: [{ op: 'find', query: '*' }], limit: 2 });
    expect(answer.nodes).toHaveLength(2);
    expect(answer.count).toBeGreaterThan(2);
    expect(answer.truncated).toBe(true);
  });

  it('explains why a walk cannot start from nothing', () => {
    const { store } = setup();
    expect(() => executePlan(store, 'walk type=imports')).toThrow(/walk needs a start set/);
  });

  it('produces the same nodes as the underlying operators', () => {
    const { store } = setup();
    const answer = executePlan(store, 'find "greet" kind=symbol');
    const direct = findNodes(store, 'greet', { kind: 'symbol' });
    expect(answer.nodes.map((n) => n.id)).toEqual(direct.nodes.map((n) => n.id));
    expect(answer.citations.every((c) => /^[\w./-]+:\d+$/.test(c))).toBe(true);
  });
});
