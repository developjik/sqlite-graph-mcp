import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectFiles, indexWorkspace, maskComments, resolveRelative, slugify } from '../src/indexer.js';
import { findNodes, walkNodes } from '../src/query.js';
import { createFixtureGraph, fixtureRoot, idsOfKeys, keySet, monoRoot, tempDir } from './helpers.js';

const graphs: { cleanup: () => void }[] = [];
afterEach(() => {
  while (graphs.length > 0) graphs.pop()?.cleanup();
});

describe('indexWorkspace', () => {
  it('builds the expected node and edge counts for the fixture workspace', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    expect(graph.stats.files).toBe(12);
    expect(graph.stats.nodes.file).toBe(12);
    expect(graph.stats.nodes.heading).toBe(9);
    expect(graph.stats.nodes.package).toBe(3);
    expect(graph.stats.nodes.symbol).toBe(12);
    expect(graph.stats.edges.references).toBe(6);
    expect(graph.stats.edges.links_to).toBeGreaterThanOrEqual(8);
    expect(graph.stats.skippedFiles).toBe(0);
  });

  it('records stable, self-describing node keys', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const symbol = graph.store.nodeByKey('symbol:src/graph/walker.ts#walkGraph');
    expect(symbol).toBeTruthy();
    expect(symbol?.kind).toBe('symbol');
    expect(symbol?.path).toBe('src/graph/walker.ts');
    expect(symbol?.line).toBe(7);
    expect(symbol?.tags).toContain('exported');
    expect(symbol?.meta.symbolKind).toBe('function');

    const heading = graph.store.nodeByKey('heading:docs/spec.md#goals');
    expect(heading?.kind).toBe('heading');
    expect(heading?.meta.level).toBe(2);

    const pkg = graph.store.nodeByKey('package:fixture-app');
    expect(pkg?.kind).toBe('package');
    expect(pkg?.meta.version).toBe('1.0.0');
  });

  it('resolves relative imports that use a .js extension to .ts sources', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const fromIndex = walkNodes(graph.store, idsOfKeys(graph.store, ['file:src/index.ts']), {
      edgeType: 'imports',
      direction: 'out',
    });
    const keys = keySet(fromIndex.nodes);
    expect(keys.has('file:src/greet.ts')).toBe(true);
    expect(keys.has('file:src/graph/walker.ts')).toBe(true);
    expect(fromIndex.depths.get(graph.store.nodeByKey('file:src/greet.ts')?.id as number)).toBe(1);
  });

  it('links bare imports to package nodes from package.json', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const deps = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'depends_on' ORDER BY s.key, d.key`,
      )
      .all() as { src: string; dst: string }[];
    const pairs = deps.map((row) => `${row.src}->${row.dst}`);
    expect(pairs).toContain('package:fixture-app->package:left-pad');
    expect(pairs).toContain('package:fixture-app->package:vitest');
    expect(pairs).toContain('file:src/index.ts->package:left-pad');
    expect(pairs).toContain('file:src/graph/walker.test.ts->package:vitest');
  });

  it('extracts markdown headings and resolves doc links, including anchors', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const links = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst, e.line FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'links_to'`,
      )
      .all() as { src: string; dst: string; line: number }[];
    const targets = links.map((row) => `${row.src}->${row.dst}`);
    expect(targets).toContain('file:docs/spec.md->file:src/graph/walker.ts');
    expect(targets).toContain('file:docs/spec.md->file:docs/guide.md');
    expect(targets).toContain('file:docs/spec.md->heading:docs/guide.md#usage');
    expect(targets).toContain('file:README.md->file:src/index.ts');
    expect(targets).toContain('file:docs/guide.md->heading:docs/spec.md#goals');
  });

  it('is idempotent: re-indexing keeps keys stable and does not duplicate rows', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);
    const before = {
      nodes: graph.store.countNodes(),
      edges: (graph.store.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c,
    };
    const reindexed = indexWorkspace({ root: fixtureRoot, dbPath: graph.dbPath });
    expect(reindexed.nodes.total).toBe(graph.stats.nodes.total);
    expect(reindexed.edges.total).toBe(graph.stats.edges.total);
    expect(graph.store.countNodes()).toBe(before.nodes);
    expect((graph.store.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c).toBe(
      before.edges,
    );
    expect(graph.store.nodeByKey('symbol:src/graph/walker.ts#walkGraph')?.line).toBe(7);
  });

  it('skips node_modules, dist and files above the size cap', () => {
    const dir = tempDir('skip');
    graphs.push({ cleanup: () => graphCleanup(dir) });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'dist', 'bundle.js'), 'export const y = 2;\n');
    writeFileSync(join(dir, 'src', 'a.ts'), 'export function a() {}\n');
    writeFileSync(join(dir, 'big.md'), `# Big\n\n${'x'.repeat(2048)}\n`);

    const collected = collectFiles(dir, { root: dir, maxFileBytes: 1024 });
    const rels = collected.files.map((f) => f.rel).sort();
    expect(rels).toEqual(['src/a.ts']);
    expect(collected.skipped).toBe(1);

    const stats = indexWorkspace({ root: dir, dbPath: join(dir, 'g.db'), maxFileBytes: 1024 });
    expect(stats.files).toBe(1);
    expect(stats.skippedFiles).toBe(1);
  });

  it('records languages, tags and content used for citations', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const file = graph.store.nodeByKey('file:src/graph/walker.test.ts');
    expect(file?.tags).toContain('test');
    expect(file?.tags).toContain('ts');

    const entry = graph.store.nodeByKey('file:src/index.ts');
    expect(entry?.tags).toContain('entry');

    const found = findNodes(graph.store, 'greetEmoji', { kind: 'symbol' });
    expect(found.nodes[0]?.name).toBe('greetEmoji');
    expect(found.nodes[0]?.content).toContain('export const greetEmoji');
  });

  it('adds references edges from named imports', () => {
    const graph = createFixtureGraph();
    graphs.push(graph);

    const refs = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst, e.line FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' ORDER BY s.key, d.key`,
      )
      .all() as { src: string; dst: string; line: number }[];
    const pairs = refs.map((row) => `${row.src}->${row.dst}`);
    expect(pairs).toContain('file:src/index.ts->symbol:src/greet.ts#greet');
    expect(pairs).toContain('file:src/index.ts->symbol:src/graph/walker.ts#walkGraph');
    expect(pairs).toContain('file:src/graph/walker.ts->symbol:src/graph/cycle-a.ts#cycleA');
    expect(pairs).toContain('file:src/graph/walker.test.ts->symbol:src/graph/walker.ts#walkGraph');
    // The reference is cited at the import line, not the declaration.
    expect(refs.find((r) => r.dst === 'symbol:src/greet.ts#greet')?.line).toBe(1);
  });
});

describe('mono workspace: aliases, workspace packages, default imports', () => {
  it('resolves tsconfig paths aliases to workspace files', () => {
    const graph = createFixtureGraph({ root: monoRoot });
    graphs.push(graph);

    const imports = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/app.ts'`,
      )
      .all() as { src: string; dst: string }[];
    const targets = imports.map((row) => row.dst);
    expect(targets).toContain('file:src/greet.ts'); // '@/greet'
    expect(targets).toContain('file:shared/index.ts'); // '@shared'
    expect(targets).toContain('file:packages/local-lib/src/entry.ts'); // 'local-lib' entry
  });

  it('links workspace-local packages and keeps externals external', () => {
    const graph = createFixtureGraph({ root: monoRoot });
    graphs.push(graph);

    const deps = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'depends_on'`,
      )
      .all() as { src: string; dst: string }[];
    const pairs = deps.map((row) => `${row.src}->${row.dst}`);
    expect(pairs).toContain('package:mono-root->package:local-lib');
    expect(pairs).toContain('file:src/app.ts->package:local-lib');
    expect(pairs).toContain('file:src/app.ts->package:some-external');

    const localLib = graph.store.nodeByKey('package:local-lib');
    expect(localLib?.tags).not.toContain('external');
    // Declared in a manifest → dependency; only undeclared bare imports are 'external'.
    expect(graph.store.nodeByKey('package:some-external')?.tags).toContain('dependency');
    expect(graph.store.nodeByKey('package:undeclared-pkg')?.tags).toContain('external');
  });

  it('references aliased symbols and synthetic default exports', () => {
    const graph = createFixtureGraph({ root: monoRoot });
    graphs.push(graph);

    const refs = graph.store.db
      .prepare(
        `SELECT s.key AS src, d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' AND s.key = 'file:src/app.ts'`,
      )
      .all() as { src: string; dst: string }[];
    const targets = refs.map((row) => row.dst);
    // `import { greet as sayHello }` references the exported name.
    expect(targets).toContain('symbol:src/greet.ts#greet');
    expect(targets).toContain('symbol:shared/index.ts#SHARED');
    // `import libEntry from 'local-lib'` → synthetic #default, defined and
    // exported by the entry file, so it is not an orphan.
    const synthetic = graph.store.nodeByKey('symbol:packages/local-lib/src/entry.ts#default');
    expect(synthetic?.tags).toContain('synthetic');
    expect(targets).toContain('symbol:packages/local-lib/src/entry.ts#default');
    const exported = graph.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e JOIN nodes n ON n.id = e.dst
         WHERE e.type = 'exports' AND n.key = 'symbol:packages/local-lib/src/entry.ts#default'`,
      )
      .get() as { c: number };
    expect(exported.c).toBe(1);
  });
});

describe('parsing helpers', () => {
  it('masks comments but preserves strings and byte offsets', () => {
    const source = [
      "import { a } from './a.js';",
      "// import { b } from './b.js';",
      'const url = "https://example.com//x"; /* import c */',
      'export const c = 1;',
    ].join('\n');
    const masked = maskComments(source);
    expect(masked.length).toBe(source.length);
    expect(masked.split('\n').length).toBe(source.split('\n').length);
    expect(masked).toContain("import { a } from './a.js';");
    expect(masked).not.toContain("import { b }");
    expect(masked).not.toContain('import c');
    expect(masked).toContain('https://example.com//x');
    expect(masked).toContain('export const c = 1;');
  });

  it('resolves extensionless and index imports', () => {
    const known = new Set(['src/a.ts', 'src/dir/index.ts', 'src/b.tsx']);
    expect(resolveRelative('src/main.ts', './a', known)).toBe('src/a.ts');
    expect(resolveRelative('src/main.ts', './dir', known)).toBe('src/dir/index.ts');
    expect(resolveRelative('src/main.ts', '../src/b.jsx', known)).toBe('src/b.tsx');
    expect(resolveRelative('src/main.ts', '../outside/x', known)).toBeNull();
  });

  it('slugifies headings to GitHub-style anchors', () => {
    expect(slugify('Graph Spec')).toBe('graph-spec');
    expect(slugify('Open Questions?')).toBe('open-questions');
    expect(slugify('Usage (advanced)')).toBe('usage-advanced');
  });
});

function graphCleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
