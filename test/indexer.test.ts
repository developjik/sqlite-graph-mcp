import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectFiles, indexWorkspace, maskComments, resolveRelative, slugify } from '../src/indexer.js';
import { findNodes, walkNodes } from '../src/query.js';
import { createFixtureGraph, fixtureRoot, idsOfKeys, keySet, monoRoot, refsRoot, tempDir } from './helpers.js';

const graphs: { cleanup: () => void }[] = [];
afterEach(() => {
  while (graphs.length > 0) graphs.pop()?.cleanup();
});

describe('indexWorkspace', () => {
  it('builds the expected node and edge counts for the fixture workspace', async () => {
    const graph = await createFixtureGraph();
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

  it('records stable, self-describing node keys', async () => {
    const graph = await createFixtureGraph();
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

  it('resolves relative imports that use a .js extension to .ts sources', async () => {
    const graph = await createFixtureGraph();
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

  it('links bare imports to package nodes from package.json', async () => {
    const graph = await createFixtureGraph();
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

  it('extracts markdown headings and resolves doc links, including anchors', async () => {
    const graph = await createFixtureGraph();
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

  it('is idempotent: re-indexing keeps keys stable and does not duplicate rows', async () => {
    const graph = await createFixtureGraph();
    graphs.push(graph);
    const before = {
      nodes: graph.store.countNodes(),
      edges: (graph.store.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c,
    };
    const reindexed = await indexWorkspace({ root: fixtureRoot, dbPath: graph.dbPath });
    expect(reindexed.nodes.total).toBe(graph.stats.nodes.total);
    expect(reindexed.edges.total).toBe(graph.stats.edges.total);
    expect(graph.store.countNodes()).toBe(before.nodes);
    expect((graph.store.db.prepare('SELECT COUNT(*) AS c FROM edges').get() as { c: number }).c).toBe(
      before.edges,
    );
    expect(graph.store.nodeByKey('symbol:src/graph/walker.ts#walkGraph')?.line).toBe(7);
  });

  it('skips node_modules, dist and files above the size cap', async () => {
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

    const stats = await indexWorkspace({ root: dir, dbPath: join(dir, 'g.db'), maxFileBytes: 1024 });
    expect(stats.files).toBe(1);
    expect(stats.skippedFiles).toBe(1);
  });

  it('records languages, tags and content used for citations', async () => {
    const graph = await createFixtureGraph();
    graphs.push(graph);

    const file = graph.store.nodeByKey('file:src/graph/walker.test.ts');
    expect(file?.tags).toContain('test');
    expect(file?.tags).toContain('ts');

    const entry = graph.store.nodeByKey('file:src/index.ts');
    expect(entry?.tags).toContain('entry');

    const found = findNodes(graph.store, 'greetEmoji', { kind: 'symbol' });
    expect(found.nodes[0]?.name).toBe('greetEmoji');
    expect(found.nodes[0]?.content).toContain('greetEmoji');
  });

  it('adds references edges from named imports', async () => {
    const graph = await createFixtureGraph();
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
    // AST engine: the reference is cited at the first *usage* line
    // (`greet(padded)` inside main), not the import or the declaration.
    expect(refs.find((r) => r.dst === 'symbol:src/greet.ts#greet')?.line).toBe(10);
  });

  it('runs the tree-sitter engine by default and falls back on demand', async () => {
    const graph = await createFixtureGraph();
    graphs.push(graph);
    expect(graph.stats.engine).toBe('ast');

    const heuristic = await createFixtureGraph({ engine: 'heuristic' });
    graphs.push(heuristic);
    expect(heuristic.stats.engine).toBe('heuristic');
    // Import-clause semantics: the citation is the import line again.
    const refs = heuristic.store.db
      .prepare(
        `SELECT e.line FROM edges e JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' AND d.key = 'symbol:src/greet.ts#greet'`,
      )
      .all() as { line: number }[];
    expect(refs[0]?.line).toBe(1);
  });
});

describe('mono workspace: aliases, workspace packages, default imports', () => {
  it('resolves tsconfig paths aliases to workspace files', async () => {
    const graph = await createFixtureGraph({ root: monoRoot });
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

  it('links workspace-local packages and keeps externals external', async () => {
    const graph = await createFixtureGraph({ root: monoRoot });
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

  it('references aliased symbols and synthetic default exports', async () => {
    const graph = await createFixtureGraph({ root: monoRoot });
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

  it('cites unused imports at the import line and tracks namespace members', async () => {
    const graph = await createFixtureGraph({ root: monoRoot });
    graphs.push(graph);

    // unused.ts imports greet but never uses it: the import clause is still a
    // rename-sensitive mention, so the edge cites the import line.
    const unusedRefs = graph.store.db
      .prepare(
        `SELECT d.key AS dst, e.line FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' AND s.key = 'file:src/unused.ts'`,
      )
      .all() as { dst: string; line: number }[];
    expect(unusedRefs).toEqual([{ dst: 'symbol:src/greet.ts#greet', line: 1 }]);
    const unusedImports = graph.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/unused.ts'`,
      )
      .get() as { c: number };
    expect(unusedImports.c).toBe(1);

    // ns.ts reaches libHelper through a namespace member access, cited at
    // the usage line.
    const nsRefs = graph.store.db
      .prepare(
        `SELECT d.key AS dst, e.line FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' AND s.key = 'file:src/ns.ts'`,
      )
      .all() as { dst: string; line: number }[];
    expect(nsRefs).toEqual([{ dst: 'symbol:packages/local-lib/src/entry.ts#libHelper', line: 3 }]);
  });
});

describe('refs fixture: type usage, barrels, package exports', () => {
  function refsFrom(store: { db: import('../src/db.js').GraphStore['db'] }, srcKey: string): string[] {
    const rows = store.db
      .prepare(
        `SELECT d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'references' AND s.key = ? ORDER BY d.key`,
      )
      .all(srcKey) as { dst: string }[];
    return rows.map((row) => row.dst);
  }

  it('counts type-position usage: annotations, generics, extends, implements, as', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const targets = refsFrom(graph.store, 'file:src/typeuse.ts');
    // `import type { T1 }` used only in type positions still references it.
    expect(targets).toContain('symbol:src/types.ts#T1');
    // Inline `{ type T2 }` specifier + `Promise<T2>`/`extends T1`/`implements` positions.
    expect(targets).toContain('symbol:src/types2.ts#T2');
    expect(targets).toContain('symbol:src/types2.ts#val');
  });

  it('resolves package.json exports (entry and subpaths)', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const imports = graph.store.db
      .prepare(
        `SELECT d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/app.ts' ORDER BY d.key`,
      )
      .all() as { dst: string }[];
    const targets = imports.map((row) => row.dst);
    expect(targets).toContain('file:pkg/src/index.ts'); // 'refs-pkg' → exports['.']
    expect(targets).toContain('file:pkg/src/sub.ts'); // 'refs-pkg/sub' → exports['./sub']

    const refs = refsFrom(graph.store, 'file:src/app.ts');
    // `coreFn`/`CoreType` are declared behind the barrel, not in index.ts.
    expect(refs).toContain('symbol:pkg/src/core.ts#coreFn');
    expect(refs).toContain('symbol:pkg/src/core.ts#CoreType');
    expect(refs).toContain('symbol:pkg/src/sub.ts#deepOnly');
  });

  it('follows export * barrels without citing the barrel itself', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const refs = refsFrom(graph.store, 'file:src/consumer.ts');
    expect(refs).toContain('symbol:src/impl.ts#viaBarrel');
    // No phantom `symbol:src/barrel.ts#viaBarrel` node was invented.
    expect(graph.store.nodeByKey('symbol:src/barrel.ts#viaBarrel')).toBeNull();
  });

  it('emits no references from export * (text carries no symbol name)', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    // barrel.ts is a pure `export *` — it keeps the file-level imports edge…
    expect(refsFrom(graph.store, 'file:src/barrel.ts')).toEqual([]);
    const imports = graph.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/barrel.ts' AND d.key = 'file:src/impl.ts'`,
      )
      .get() as { c: number };
    expect(imports.c).toBe(1);

    // …but a named re-export `export { x } from` is textual usage → references.
    const namedRefs = refsFrom(graph.store, 'file:src/namedbarrel.ts');
    expect(namedRefs).toContain('symbol:src/impl.ts#viaBarrel');
  });

  it('counts shorthand, computed-adjacent and dynamic-import destructuring', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    // `{ helperA }` object shorthand + call usage.
    const shortRefs = refsFrom(graph.store, 'file:src/shorthand.ts');
    expect(shortRefs).toContain('symbol:src/helpers.ts#helperA');
    expect(shortRefs).toContain('symbol:src/helpers.ts#helperB');

    // `const { dynFn } = await import('./dynmod')` → imports + usage reference.
    const dynImports = graph.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/dynimp.ts' AND d.key = 'file:src/dynmod.ts'`,
      )
      .get() as { c: number };
    expect(dynImports.c).toBe(1);
    const dynRefs = refsFrom(graph.store, 'file:src/dynimp.ts');
    expect(dynRefs).toContain('symbol:src/dynmod.ts#dynFn');
    // `() => import('./dynmod')` binds nothing — no phantom default-export ref.
    expect(dynRefs).not.toContain('symbol:src/dynmod.ts#default');
  });

  it('binds destructured names through a wrapped dynamic import', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    // `const { a, b } = await wrapPromise(() => import('./wraplib'))` — both
    // bindings resolve to the module's exports despite the call wrapper.
    const refs = refsFrom(graph.store, 'file:src/wrapimp.ts');
    expect(refs).toContain('symbol:src/wraplib.ts#reportRunError');
    expect(refs).toContain('symbol:src/wraplib.ts#runNonInteractive');
  });

  it('references members reached through a binding (`Wrap.Inner`)', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const refs = refsFrom(graph.store, 'file:src/nsprop.ts');
    expect(refs).toContain('symbol:src/wrapmod.ts#Wrap');
    expect(refs).toContain('symbol:src/wrapmod.ts#Inner');
  });

  it('keeps the same barrel and export-* behavior under the heuristic engine', async () => {
    const graph = await createFixtureGraph({ root: refsRoot, engine: 'heuristic' });
    graphs.push(graph);
    expect(graph.stats.engine).toBe('heuristic');

    expect(refsFrom(graph.store, 'file:src/consumer.ts')).toContain('symbol:src/impl.ts#viaBarrel');
    expect(refsFrom(graph.store, 'file:src/barrel.ts')).toEqual([]);
    expect(refsFrom(graph.store, 'file:src/app.ts')).toContain('symbol:pkg/src/core.ts#coreFn');
  });

  it('resolves export * as ns: namespace symbol plus member references', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    // The barrel exports a real namespace name importers can bind.
    const ns = graph.store.nodeByKey('symbol:src/nsbarrel.ts#Ns');
    expect(ns?.tags).toContain('exported');

    const refs = refsFrom(graph.store, 'file:src/nsuser.ts');
    expect(refs).toContain('symbol:src/nsbarrel.ts#Ns'); // `Ns` binding
    expect(refs).toContain('symbol:src/nsmod.ts#inner'); // `Ns.inner`
    expect(refs).toContain('symbol:src/nsmod.ts#InnerError'); // `Ns.InnerError`
  });

  it('resolves nested tsconfig paths aliases (@/*) to package files', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const imports = graph.store.db
      .prepare(
        `SELECT d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:pkga/src/usealias.ts' ORDER BY d.key`,
      )
      .all() as { dst: string }[];
    expect(imports.map((row) => row.dst)).toContain('file:pkga/src/aliased.ts'); // '@/aliased'

    const refs = refsFrom(graph.store, 'file:pkga/src/usealias.ts');
    expect(refs).toContain('symbol:pkga/src/aliased.ts#aliased');
    // `second` is imported but unused — the import line is cited.
    expect(refs).toContain('symbol:pkga/src/aliased.ts#second');
  });

  it('keeps export * as ns parity under the heuristic engine', async () => {
    const graph = await createFixtureGraph({ root: refsRoot, engine: 'heuristic' });
    graphs.push(graph);
    expect(graph.stats.engine).toBe('heuristic');

    expect(graph.store.nodeByKey('symbol:src/nsbarrel.ts#Ns')?.tags).toContain('exported');
    expect(refsFrom(graph.store, 'file:src/nsuser.ts')).toContain('symbol:src/nsbarrel.ts#Ns');
    expect(refsFrom(graph.store, 'file:pkga/src/usealias.ts')).toContain('symbol:pkga/src/aliased.ts#aliased');
  });

  it('resolves extensionless specs whose basename contains dots (./foo.view)', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const imports = graph.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:src/dotimp.ts' AND d.key = 'file:src/foo.view.ts'`,
      )
      .get() as { c: number };
    expect(imports.c).toBe(1);
    expect(refsFrom(graph.store, 'file:src/dotimp.ts')).toContain('symbol:src/foo.view.ts#viewFn');
  });

  it('orders exports wildcards by specificity and falls through misses', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    // './*' → './src/components/*.tsx' appears first but loses to './ctx/*'
    // (longer prefix) — and even its miss falls through to the better match.
    const refs = refsFrom(graph.store, 'file:src/ctxuse.ts');
    expect(refs).toContain('symbol:pkg2/src/context/thing.ts#thing');
  });

  it('resolves package.json imports (#-specifiers) to the node condition', async () => {
    const graph = await createFixtureGraph({ root: refsRoot });
    graphs.push(graph);

    const imports = graph.store.db
      .prepare(
        `SELECT d.key AS dst FROM edges e
         JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
         WHERE e.type = 'imports' AND s.key = 'file:pkg2/src/user.ts'`,
      )
      .all() as { dst: string }[];
    expect(imports.map((row) => row.dst)).toContain('file:pkg2/src/priv.node.ts');

    const refs = refsFrom(graph.store, 'file:pkg2/src/user.ts');
    expect(refs).toContain('symbol:pkg2/src/priv.node.ts#privVal');
    expect(refs).not.toContain('symbol:pkg2/src/priv.bun.ts#privVal');
  });
});

describe('parsing helpers', () => {
  it('masks comments but preserves strings and byte offsets', async () => {
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

  it('resolves extensionless and index imports', async () => {
    const known = new Set(['src/a.ts', 'src/dir/index.ts', 'src/b.tsx']);
    expect(resolveRelative('src/main.ts', './a', known)).toBe('src/a.ts');
    expect(resolveRelative('src/main.ts', './dir', known)).toBe('src/dir/index.ts');
    expect(resolveRelative('src/main.ts', '../src/b.jsx', known)).toBe('src/b.tsx');
    expect(resolveRelative('src/main.ts', '../outside/x', known)).toBeNull();
  });

  it('slugifies headings to GitHub-style anchors', async () => {
    expect(slugify('Graph Spec')).toBe('graph-spec');
    expect(slugify('Open Questions?')).toBe('open-questions');
    expect(slugify('Usage (advanced)')).toBe('usage-advanced');
  });
});

function graphCleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
