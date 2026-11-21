import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as posix from 'node:path/posix';

import { getAstEngine, parseFile, type AstEngine, type AstImport, type AstParse } from './ast.js';
import { GraphStore, SCHEMA_VERSION, defaultDbPath } from './db.js';
import type { EdgeType, IndexOptions, IndexStats, NodeKind } from './types.js';
import {
  buildTerms,
  computeLineStarts,
  lineAtIndex,
  snippet,
  toPosix,
} from './util.js';

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']);
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.markdown']);

const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  '.venv',
  'venv',
  '__pycache__',
  '.sqlite-graph',
  '.vitest',
  '.expo',
  '.angular',
  '.gradle',
  'Pods',
  'DerivedData',
  'target',
  'vendor',
]);

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'dns',
  'domain',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'trace_events',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
  'zlib',
]);

export interface ParsedNode {
  key: string;
  kind: NodeKind;
  name: string;
  path: string | null;
  line: number;
  content: string | null;
  tags: string[];
  meta: Record<string, unknown>;
}

interface ParsedEdge {
  src: string;
  dst: string;
  type: EdgeType;
  line: number | null;
}

export interface ImportedNames {
  /** `import X from …` / `const X = require(…)`. */
  defaultImport: boolean;
  /** `import * as NS from …` / `export * from …`: references every export. */
  namespace: boolean;
  /** Exported names from `{ a, b as c }` (the name before `as`). */
  names: string[];
}

interface PendingLink {
  fromKey: string;
  fromPath: string;
  target: string;
  line: number;
  /** `imports` for module specifiers, `links_to` for markdown links. */
  edge: 'imports' | 'links_to';
  /** Symbols the importing statement uses, when the clause was parsed. */
  imports?: ImportedNames;
  /** Already resolved workspace-relative target (alias / workspace package). */
  resolved?: string;
  /** AST engine bindings with usage lines; drives usage-based references. */
  ast?: AstImport;
}

interface PackageInfo {
  name: string;
  version?: string;
  /** `main`/`module` field, relative to the manifest. */
  entry?: string;
  external: boolean;
  dev: boolean;
  manifests: Set<string>;
}

export interface IndexResult {
  stats: IndexStats;
  store: GraphStore;
}

/**
 * Index a workspace directory into a SQLite graph and return the summary.
 * The database is rebuilt in a single transaction, so a failure leaves the
 * previous graph untouched.
 */
export async function indexWorkspace(options: IndexOptions): Promise<IndexStats> {
  const started = Date.now();
  const root = resolve(options.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }

  const dbPath = options.dbPath ? resolve(options.dbPath) : defaultDbPath(root);
  const collected = collectFiles(root, options);
  const relPaths = new Set(collected.files.map((f) => f.rel));
  const aliasMap = loadAliasMap(root);
  const astEngine = options.engine === 'heuristic' ? null : await getAstEngine();

  const nodes = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  const pendingLinks: PendingLink[] = [];
  const packages = new Map<string, PackageInfo>();
  /** First `export default` line per file, for default-import references. */
  const defaultExports = new Map<string, { line: number; text: string }>();

  const addNode = (node: ParsedNode): void => {
    const existing = nodes.get(node.key);
    if (existing) {
      // Keep the first, but merge tags so duplicate concepts stay searchable.
      for (const tag of node.tags) if (!existing.tags.includes(tag)) existing.tags.push(tag);
      return;
    }
    nodes.set(node.key, node);
  };
  const addEdge = (src: string, dst: string, type: EdgeType, line: number | null): void => {
    if (src === dst) return;
    edges.push({ src, dst, type, line });
  };

  const upsertPackage = (name: string, patch: Partial<PackageInfo> & { dev?: boolean }): PackageInfo => {
    let info = packages.get(name);
    if (!info) {
      info = { name, external: patch.external ?? false, dev: patch.dev ?? false, manifests: new Set() };
      packages.set(name, info);
    }
    if (patch.version) info.version = patch.version;
    if (patch.entry) info.entry = patch.entry;
    if (patch.external === false) info.external = false;
    if (patch.dev) info.dev = true;
    for (const m of patch.manifests ?? []) info.manifests.add(m);
    return info;
  };

  const ctx: IndexContext = {
    relPaths,
    aliasMap,
    astEngine,
    packages,
    pendingLinks,
    defaultExports,
    addNode,
    addEdge,
    upsertPackage,
  };

  // Pass 1: manifests first, so workspace-local packages are known before any
  // code import is resolved.
  for (const file of collected.files) {
    if (posix.basename(file.rel) !== 'package.json') continue;
    const source = readFileSafe(file.abs);
    if (source === null) {
      collected.skipped += 1;
      continue;
    }
    indexManifest(file.rel, source, ctx);
  }

  // Pass 2: code and docs.
  for (const file of collected.files) {
    if (posix.basename(file.rel) === 'package.json') continue;
    const source = readFileSafe(file.abs);
    if (source === null) {
      collected.skipped += 1;
      continue;
    }
    const ext = posix.extname(file.rel).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      indexCodeFile(file.rel, source, ctx);
    } else if (DOC_EXTENSIONS.has(ext)) {
      indexDocFile(file.rel, source, ctx);
    }
  }

  // Materialize package nodes now that manifests and bare imports are known.
  for (const info of packages.values()) {
    addNode({
      key: `package:${info.name}`,
      kind: 'package',
      name: info.name,
      path: [...info.manifests][0] ?? null,
      line: 1,
      content: info.version ?? null,
      tags: info.external ? ['package', 'external'] : ['package', 'dependency'],
      meta: {
        version: info.version,
        external: info.external,
        dev: info.dev,
        manifests: [...info.manifests],
      },
    });
  }

  // Resolve markdown links and import specifiers, and build `references`
  // edges (importer file → exported symbol) for every parsed import clause.
  const headingKeys = new Set(
    [...nodes.values()].filter((n) => n.kind === 'heading').map((n) => n.key),
  );
  const exportedByFile = new Map<string, ParsedNode[]>();
  const symbolByLine = new Map<string, ParsedNode>();
  for (const node of nodes.values()) {
    if (node.kind !== 'symbol' || !node.path) continue;
    symbolByLine.set(`${node.path}:${node.line}`, node);
    if (node.meta.exported === true) {
      const list = exportedByFile.get(node.path);
      if (list) list.push(node);
      else exportedByFile.set(node.path, [node]);
    }
  }
  const refs: ReferenceContext = {
    relPaths,
    nodes,
    exportedByFile,
    symbolByLine,
    defaultExports,
    addNode,
    addEdge,
  };
  for (const link of pendingLinks) {
    resolveLink(link, headingKeys, refs);
  }

  const store = new GraphStore(dbPath);
  try {
    store.transaction(() => {
      store.clear();
      const ids = new Map<string, number>();
      for (const node of nodes.values()) {
        const id = store.insertNode({
          key: node.key,
          kind: node.kind,
          name: node.name,
          path: node.path,
          line: node.line,
          content: node.content,
          terms: buildTerms(node.name, node.path, [node.content ?? '']),
          meta: node.meta,
          tags: node.tags,
        });
        ids.set(node.key, id);
      }
      for (const edge of edges) {
        const src = ids.get(edge.src);
        const dst = ids.get(edge.dst);
        if (src === undefined || dst === undefined) continue;
        store.addEdge(src, dst, edge.type, edge.line);
      }
      store.setMeta('root', root);
      store.setMeta('indexed_at', new Date().toISOString());
      store.setMeta('schema_version', SCHEMA_VERSION);
      store.setMeta('file_count', String(collected.files.length));
    });

    const counts = store.counts();
    const stats: IndexStats = {
      root: toPosix(root),
      dbPath: toPosix(dbPath),
      files: collected.files.length,
      skippedFiles: collected.skipped,
      nodes: {
        file: counts['node:file'] ?? 0,
        symbol: counts['node:symbol'] ?? 0,
        heading: counts['node:heading'] ?? 0,
        package: counts['node:package'] ?? 0,
        total: counts['node:total'] ?? 0,
      },
      edges: {
        imports: counts['edge:imports'] ?? 0,
        exports: counts['edge:exports'] ?? 0,
        defines: counts['edge:defines'] ?? 0,
        links_to: counts['edge:links_to'] ?? 0,
        depends_on: counts['edge:depends_on'] ?? 0,
        references: counts['edge:references'] ?? 0,
        total: counts['edge:total'] ?? 0,
      },
      durationMs: Date.now() - started,
      engine: astEngine ? 'ast' : 'heuristic',
      indexedAt: new Date().toISOString(),
    };
    return stats;
  } finally {
    store.close();
  }
}

export function readFileSafe(abs: string): string | null {
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

interface CollectedFiles {
  files: { abs: string; rel: string; size: number }[];
  skipped: number;
}

export function collectFiles(root: string, options: IndexOptions): CollectedFiles {
  const extraIgnore = new Set((options.ignore ?? []).map((p) => toPosix(p).replace(/^\.\//, '')));
  const maxFiles = options.maxFiles ?? 5000;
  const maxBytes = options.maxFileBytes ?? 512 * 1024;
  const files: { abs: string; rel: string; size: number }[] = [];
  let skipped = 0;

  const walk = (dir: string): void => {
    if (files.length >= maxFiles) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (extraIgnore.has(rel) || extraIgnore.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (extraIgnore.has(rel) || extraIgnore.has(entry.name)) continue;
      const ext = posix.extname(entry.name).toLowerCase();
      const isManifest = entry.name === 'package.json';
      if (!isManifest && !CODE_EXTENSIONS.has(ext) && !DOC_EXTENSIONS.has(ext)) continue;
      let size = 0;
      try {
        size = statSync(abs).size;
      } catch {
        skipped += 1;
        continue;
      }
      if (size > maxBytes) {
        skipped += 1;
        continue;
      }
      files.push({ abs, rel: rel.split(sep).join('/'), size });
    }
  };

  walk(root);
  return { files, skipped };
}

/** Shared context for the per-file indexing passes. */
export interface IndexContext {
  relPaths: Set<string>;
  aliasMap: AliasMap | null;
  /** Loaded tree-sitter grammars; null → regex extraction. */
  astEngine: AstEngine | null;
  packages: Map<string, PackageInfo>;
  pendingLinks: PendingLink[];
  defaultExports: Map<string, { line: number; text: string }>;
  addNode: (node: ParsedNode) => void;
  addEdge: (src: string, dst: string, type: EdgeType, line: number | null) => void;
  upsertPackage: (name: string, patch: Partial<PackageInfo> & { dev?: boolean }) => PackageInfo;
}

/** Everything `resolveLink` needs to add `references` edges. */
interface ReferenceContext {
  relPaths: Set<string>;
  nodes: Map<string, ParsedNode>;
  exportedByFile: Map<string, ParsedNode[]>;
  symbolByLine: Map<string, ParsedNode>;
  defaultExports: Map<string, { line: number; text: string }>;
  addNode: (node: ParsedNode) => void;
  addEdge: (src: string, dst: string, type: EdgeType, line: number | null) => void;
}

function indexManifest(rel: string, source: string, ctx: IndexContext): void {
  const { addNode, addEdge, upsertPackage } = ctx;
  const fileKey = `file:${rel}`;
  addNode({
    key: fileKey,
    kind: 'file',
    name: posix.basename(rel),
    path: rel,
    line: 1,
    content: null,
    tags: ['manifest', 'json'],
    meta: { language: 'json', size: source.length },
  });

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(source) as Record<string, unknown>;
  } catch {
    return;
  }

  const selfName = typeof manifest.name === 'string' && manifest.name ? manifest.name : rel;
  const self = upsertPackage(selfName, {
    version: typeof manifest.version === 'string' ? manifest.version : undefined,
    entry:
      typeof manifest.main === 'string' && manifest.main
        ? manifest.main
        : typeof manifest.module === 'string' && manifest.module
          ? manifest.module
          : undefined,
    external: false,
    manifests: new Set([rel]),
  });
  addEdge(fileKey, `package:${self.name}`, 'defines', 1);

  const sections: { field: string; dev: boolean }[] = [
    { field: 'dependencies', dev: false },
    { field: 'devDependencies', dev: true },
    { field: 'peerDependencies', dev: true },
    { field: 'optionalDependencies', dev: false },
  ];
  for (const section of sections) {
    const deps = manifest[section.field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [depName, range] of Object.entries(deps as Record<string, unknown>)) {
      upsertPackage(depName, { dev: section.dev, external: false, manifests: new Set() });
      addEdge(`package:${self.name}`, `package:${depName}`, 'depends_on', null);
      void range;
    }
  }
}

/** File node + tags, then engine dispatch (AST when available, else regexes). */
function indexCodeFile(rel: string, source: string, ctx: IndexContext): void {
  const { addNode } = ctx;
  const fileKey = `file:${rel}`;
  const ext = posix.extname(rel).toLowerCase();
  const tags = ['code', ext.replace('.', '')];
  const base = posix.basename(rel);
  if (/(^|[._-])(test|spec)\.[cm]?[jt]sx?$/.test(base)) tags.push('test');
  if (/(^|\/)__(tests|mocks)__\//.test(rel)) tags.push('test');
  if (/^(index|main|cli|server|app)\.[cm]?[jt]sx?$/.test(base) || rel.startsWith('bin/')) tags.push('entry');

  addNode({
    key: fileKey,
    kind: 'file',
    name: base,
    path: rel,
    line: 1,
    content: null,
    tags,
    meta: { language: ext.replace('.', ''), size: source.length },
  });

  if (ctx.astEngine) {
    const parsed = parseFile(ctx.astEngine, source, ext);
    if (parsed) {
      indexCodeFileAst(rel, parsed, ctx);
      return;
    }
  }
  indexCodeFileHeuristic(rel, source, ctx);
}

/** Extra per-import payload: heuristic clause info and/or AST bindings. */
interface ImportPayload {
  imports?: ImportedNames;
  ast?: AstImport;
}

/**
 * Route one import specifier: relative → file, tsconfig alias → file,
 * workspace-local package → depends_on + entry/subpath file, else external
 * package. Shared by both engines so alias/monorepo behavior never diverges.
 */
function routeImport(
  rel: string,
  spec: string,
  line: number,
  payload: ImportPayload,
  ctx: IndexContext,
): void {
  const { addEdge, upsertPackage, pendingLinks, aliasMap, relPaths, packages } = ctx;
  const fileKey = `file:${rel}`;
  const base = { fromKey: fileKey, fromPath: rel, target: spec, line, edge: 'imports' as const, ...payload };

  if (spec.startsWith('.') || spec.startsWith('/')) {
    pendingLinks.push(base);
    return;
  }

  // tsconfig `paths` alias → a workspace file, not a package.
  const aliased = aliasMap ? resolveAlias(aliasMap, spec, relPaths) : null;
  if (aliased) {
    pendingLinks.push({ ...base, resolved: aliased });
    return;
  }

  const pkg = packageNameOf(spec);
  if (!pkg || isBuiltin(spec)) return;
  const info = packages.get(pkg);
  if (info && info.manifests.size > 0) {
    // Workspace-local package: link the package node and, when the entry or
    // subpath resolves to an indexed file, an imports edge too.
    addEdge(fileKey, `package:${pkg}`, 'depends_on', line);
    const pkgDir = posix.dirname([...info.manifests][0] ?? rel);
    const sub = spec.slice(pkg.length).replace(/^[\/\\]+/, '');
    const bases = sub ? [`${pkgDir}/${sub}`] : [info.entry ? `${pkgDir}/${info.entry}` : null, `${pkgDir}/index`];
    for (const b of bases) {
      if (!b) continue;
      const target = resolveFromRoot(b, relPaths);
      if (target) {
        pendingLinks.push({ ...base, resolved: target });
        return;
      }
    }
    return;
  }
  upsertPackage(pkg, { external: true });
  addEdge(fileKey, `package:${pkg}`, 'depends_on', line);
}

/** AST extraction: parse-tree symbols and usage-based references. */
function indexCodeFileAst(rel: string, parse: AstParse, ctx: IndexContext): void {
  const { addNode, addEdge, pendingLinks, defaultExports } = ctx;
  const fileKey = `file:${rel}`;
  const ext = posix.extname(rel).toLowerCase();
  const seenSpecs = new Set<string>();

  for (const imp of parse.imports) {
    const key = `${imp.spec}:${imp.line}`;
    if (seenSpecs.has(key)) continue;
    seenSpecs.add(key);
    routeImport(rel, imp.spec, imp.line, { ast: imp }, ctx);
  }

  for (const sym of parse.symbols) {
    const exported = sym.exported || parse.listedExports.has(sym.name);
    const symbolKey = `symbol:${rel}#${sym.name}`;
    addNode({
      key: symbolKey,
      kind: 'symbol',
      name: sym.name,
      path: rel,
      line: sym.line,
      content: snippet(sym.snippet, 300),
      tags: exported ? ['symbol', 'exported', sym.kind] : ['symbol', sym.kind],
      meta: { symbolKind: sym.kind, exported, language: ext.replace('.', '') },
    });
    addEdge(fileKey, symbolKey, 'defines', sym.line);
    if (exported) addEdge(fileKey, symbolKey, 'exports', sym.line);
  }

  if (parse.defaultExport && !defaultExports.has(rel)) {
    defaultExports.set(rel, parse.defaultExport);
  }
}

/** Regex extraction: comment-masked scans, import-clause-based references. */
function indexCodeFileHeuristic(rel: string, source: string, ctx: IndexContext): void {
  const { addNode, addEdge, upsertPackage, pendingLinks, aliasMap, relPaths, packages, defaultExports } = ctx;
  const fileKey = `file:${rel}`;
  const ext = posix.extname(rel).toLowerCase();

  const masked = maskComments(source);
  const lineStarts = computeLineStarts(masked);
  const lines = masked.split('\n');

  // ---- imports / re-exports / requires ----
  // Pattern 1 captures the import clause (everything before `from`) so
  // `references` edges can name the symbols the importer uses.
  const importPatterns: { re: RegExp; clauseGroup: number; specGroup: number }[] = [
    {
      re: /(?:^|[^\w$])(?:import|export)\s+(?:type\s+)?((?:[^;'"]*?)\s+from\s*)?['"]([^'"\n]+)['"]/g,
      clauseGroup: 1,
      specGroup: 2,
    },
    { re: /(?:^|[^\w$.])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, clauseGroup: 0, specGroup: 1 },
    { re: /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g, clauseGroup: 0, specGroup: 1 },
  ];
  const seenSpecs = new Set<string>();
  for (const { re: pattern, clauseGroup, specGroup } of importPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const spec = match[specGroup];
      if (!spec) continue;
      const quoteIndex = masked.indexOf(spec, match.index);
      const line = lineAtIndex(lineStarts, quoteIndex >= 0 ? quoteIndex : match.index);
      const key = `${spec}:${line}`;
      if (seenSpecs.has(key)) continue;
      seenSpecs.add(key);

      const imports = parseImportedNames(
        clauseGroup > 0 ? (match[clauseGroup] ?? null) : null,
        clauseGroup === 0 ? (lines[line - 1] ?? null) : null,
      );

      routeImport(rel, spec, line, { imports }, ctx);
    }
  }

  // ---- first `export default` line, for default-import references ----
  if (!defaultExports.has(rel)) {
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i] ?? '';
      if (/^\s*export\s+default\b/.test(text)) {
        defaultExports.set(rel, { line: i + 1, text: text.trim() });
        break;
      }
    }
  }

  // ---- exported names listed in `export { a, b as c }` ----
  const listedExports = new Set<string>();
  const exportListRe = /(?:^|[^\w$])export\s+(?:type\s+)?\{([^}]*)\}/g;
  let exportMatch: RegExpExecArray | null;
  while ((exportMatch = exportListRe.exec(masked)) !== null) {
    for (const part of (exportMatch[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) listedExports.add(name);
    }
  }

  // ---- top-level symbol declarations ----
  const symbolPatterns: { kind: string; re: RegExp }[] = [
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([\p{L}_$][\p{L}\p{N}_$]*)/u },
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u },
    { kind: 'variable', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*[:=!]/u },
    { kind: 'interface', re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+([\p{L}_$][\p{L}\p{N}_$]*)/u },
    { kind: 'type', re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:<|=)/u },
    { kind: 'enum', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([\p{L}_$][\p{L}\p{N}_$]*)/u },
  ];


  const localSymbols = new Map<string, { line: number; kind: string }>();
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (!text.trim()) continue;
    // Only module-level declarations: locals and class members are indented.
    if (/^\s+/.test(text) && !/^\s*export\b/.test(text)) continue;
    for (const { kind, re } of symbolPatterns) {
      const m = re.exec(text);
      if (!m || !m[1]) continue;
      const name = m[1];
      if (!localSymbols.has(name)) localSymbols.set(name, { line: i + 1, kind });
      break;
    }
  }

  for (const [name, info] of localSymbols) {
    const declarationLine = (lines[info.line - 1] ?? '').trim();
    const exported =
      /^\s*export\b/.test(lines[info.line - 1] ?? '') || listedExports.has(name);
    const symbolKey = `symbol:${rel}#${name}`;
    addNode({
      key: symbolKey,
      kind: 'symbol',
      name,
      path: rel,
      line: info.line,
      content: snippet(declarationLine, 300),
      tags: exported ? ['symbol', 'exported', info.kind] : ['symbol', info.kind],
      meta: { symbolKind: info.kind, exported, language: ext.replace('.', '') },
    });
    addEdge(fileKey, symbolKey, 'defines', info.line);
    if (exported) addEdge(fileKey, symbolKey, 'exports', info.line);
  }
}

function indexDocFile(rel: string, source: string, ctx: IndexContext): void {
  const { addNode, addEdge, pendingLinks } = ctx;
  const fileKey = `file:${rel}`;
  const ext = posix.extname(rel).toLowerCase();
  addNode({
    key: fileKey,
    kind: 'file',
    name: posix.basename(rel),
    path: rel,
    line: 1,
    content: null,
    tags: ['doc', ext.replace('.', '')],
    meta: { language: 'markdown', size: source.length },
  });

  const lines = source.split('\n');
  const seenSlugs = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading && heading[2]) {
      const text = heading[2].trim();
      const baseSlug = slugify(text);
      const prior = seenSlugs.get(baseSlug) ?? 0;
      seenSlugs.set(baseSlug, prior + 1);
      const slug = prior === 0 ? baseSlug : `${baseSlug}-${prior + 1}`;
      const key = `heading:${rel}#${slug}`;
      addNode({
        key,
        kind: 'heading',
        name: text,
        path: rel,
        line: i + 1,
        content: text,
        tags: ['heading', `h${heading[1].length}`],
        meta: { level: heading[1].length, slug },
      });
      addEdge(fileKey, key, 'defines', i + 1);
    }

    for (const rawTarget of extractLinkTargets(line)) {
      pendingLinks.push({
        fromKey: fileKey,
        fromPath: rel,
        target: rawTarget,
        line: i + 1,
        edge: 'links_to',
      });
    }
  }
}

/** Inline `[text](target)` links and `[id]: target` definitions; images excluded. */
export function extractLinkTargets(line: string): string[] {
  const out: string[] = [];
  const inline = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = inline.exec(line)) !== null) {
    if (m[1] === '!') continue;
    const target = m[2];
    if (target) out.push(target);
  }
  const definition = /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
  if (definition?.[1]) out.push(definition[1]);
  return out;
}

function resolveLink(link: PendingLink, headingKeys: Set<string>, refs: ReferenceContext): void {
  const { relPaths, addEdge } = refs;
  const raw = link.target.trim();
  if (!raw) return;

  // Module specifiers: a file-to-file `imports` edge, plus `references` edges
  // from the importer to each symbol the import clause uses.
  if (link.edge === 'imports') {
    const target = link.resolved ?? resolveRelative(link.fromPath, raw, relPaths);
    if (target) {
      addEdge(link.fromKey, `file:${target}`, 'imports', link.line);
      if (link.ast) addAstReferenceEdges(link.ast, link.fromKey, target, refs);
      else addReferenceEdges(link, target, refs);
    }
    return;
  }

  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) return;

  const hashIndex = raw.indexOf('#');
  const pathPart = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
  const anchor = hashIndex >= 0 ? raw.slice(hashIndex + 1) : '';

  if (!pathPart) {
    if (!anchor) return;
    const key = `heading:${link.fromPath}#${anchor}`;
    if (headingKeys.has(key)) addEdge(link.fromKey, key, 'links_to', link.line);
    return;
  }

  const target = resolveRelative(link.fromPath, pathPart, relPaths);
  if (!target) return;
  addEdge(link.fromKey, `file:${target}`, 'links_to', link.line);
  if (anchor) {
    const key = `heading:${target}#${anchor}`;
    if (headingKeys.has(key)) addEdge(link.fromKey, key, 'links_to', link.line);
  }
}

/**
 * Add `references` edges (importer file → exported symbol) for a resolved
 * module import: named imports, default imports, and namespace imports
 * (which reference every export of the target file).
 */
function addReferenceEdges(link: PendingLink, targetRel: string, refs: ReferenceContext): void {
  const imports = link.imports;
  if (!imports) return;
  if (imports.names.length > 0) {
    for (const name of imports.names) {
      const key = `symbol:${targetRel}#${name}`;
      if (refs.nodes.has(key)) refs.addEdge(link.fromKey, key, 'references', link.line);
    }
  }
  if (imports.defaultImport) {
    const symbol = defaultExportSymbol(targetRel, refs);
    if (symbol) refs.addEdge(link.fromKey, symbol.key, 'references', link.line);
  }
  if (imports.namespace) {
    for (const symbol of refs.exportedByFile.get(targetRel) ?? []) {
      refs.addEdge(link.fromKey, symbol.key, 'references', link.line);
    }
  }
}

/**
 * Usage-based `references` edges from the AST engine: one edge per imported
 * symbol the file actually uses, cited at the first usage line (never at the
 * import line), plus `export *` re-exports referencing every export.
 */
function addAstReferenceEdges(
  ast: AstImport,
  fromKey: string,
  targetRel: string,
  refs: ReferenceContext,
): void {
  for (const binding of ast.named) {
    if (binding.usedAtLine === null) continue; // imported but never used
    const key = `symbol:${targetRel}#${binding.imported}`;
    if (refs.nodes.has(key)) refs.addEdge(fromKey, key, 'references', binding.usedAtLine);
  }
  if (ast.defaultLocal && ast.defaultLocal.usedAtLine !== null) {
    const symbol = defaultExportSymbol(targetRel, refs);
    if (symbol) refs.addEdge(fromKey, symbol.key, 'references', ast.defaultLocal.usedAtLine);
  }
  if (ast.exportAllLine !== null) {
    for (const symbol of refs.exportedByFile.get(targetRel) ?? []) {
      refs.addEdge(fromKey, symbol.key, 'references', ast.exportAllLine);
    }
  }
  if (ast.namespaceLocal) {
    for (const [prop, line] of ast.namespaceLocal.props) {
      const key = `symbol:${targetRel}#${prop}`;
      if (refs.nodes.has(key)) refs.addEdge(fromKey, key, 'references', line);
    }
  }
}

/**
 * The symbol a `import X from …` statement refers to: the named declaration
 * on the `export default` line when there is one, otherwise a synthetic
 * `#default` symbol node so default imports still have something to cite.
 */
function defaultExportSymbol(targetRel: string, refs: ReferenceContext): ParsedNode | null {
  const info = refs.defaultExports.get(targetRel);
  const named = info ? refs.symbolByLine.get(`${targetRel}:${info.line}`) : undefined;
  if (named) return named;
  const key = `symbol:${targetRel}#default`;
  const existing = refs.nodes.get(key);
  if (existing) return existing;
  const line = info?.line ?? 1;
  const node: ParsedNode = {
    key,
    kind: 'symbol',
    name: 'default',
    path: targetRel,
    line,
    content: snippet(info?.text ?? null, 300),
    tags: ['symbol', 'exported', 'synthetic', 'default'],
    meta: { symbolKind: 'default', exported: true, synthetic: true },
  };
  refs.addNode(node);
  refs.addEdge(`file:${targetRel}`, key, 'defines', line);
  refs.addEdge(`file:${targetRel}`, key, 'exports', line);
  return node;
}

/**
 * Parse an import clause (`X, { a as b }` before `from`) or a `require`
 * line into the symbols it uses. `as` aliases map to the exported name;
 * `import type` counts like any other import.
 */
export function parseImportedNames(
  clause: string | null | undefined,
  requireLine: string | null | undefined,
): ImportedNames {
  const result: ImportedNames = { defaultImport: false, namespace: false, names: [] };
  if (clause) {
    const text = clause.replace(/\s+from\s*$/, '').trim();
    applyClauseText(text, result);
  } else if (requireLine) {
    const destructured = /(?:const|let|var)\s+\{([^}]*)\}\s*=/.exec(requireLine);
    if (destructured?.[1] !== undefined) {
      for (const part of destructured[1].split(',')) {
        const name = part.trim().split(':')[0]?.trim();
        if (name && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) result.names.push(name);
      }
    } else if (/(?:const|let|var)\s+[\p{L}_$][\p{L}\p{N}_$]*\s*=\s*require\s*\(/u.test(requireLine)) {
      result.defaultImport = true;
    }
  }
  return result;
}

function applyClauseText(text: string, result: ImportedNames): void {
  const braces = /\{([^}]*)\}/.exec(text);
  if (braces?.[1] !== undefined) {
    for (const part of braces[1].split(',')) {
      const raw = part.trim().replace(/^type\s+/, '');
      const exported = raw.split(/\s+as\s+/)[0]?.trim();
      if (exported && /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(exported)) result.names.push(exported);
    }
  }
  if (/\*\s*as\s+[\p{L}_$][\p{L}\p{N}_$]*/u.test(text)) result.namespace = true;
  const before = braces ? text.slice(0, braces.index) : text;
  if (/^[\p{L}_$][\p{L}\p{N}_$]*\s*(,|$)/u.test(before.trim())) result.defaultImport = true;
}

/** Candidate workspace-relative paths for a specifier base, in priority order. */
function candidatesFor(base: string): string[] {
  const candidates: string[] = [];
  const push = (c: string): void => {
    if (c && !candidates.includes(c)) candidates.push(c);
  };

  push(base);
  if (/\.(m|c)?jsx?$/.test(base)) {
    push(base.replace(/\.(m|c)?js$/, '.ts'));
    push(base.replace(/\.(m|c)?js$/, '.tsx'));
    push(base.replace(/\.(m|c)?jsx?$/, '.ts'));
    push(base.replace(/\.(m|c)?jsx?$/, '.tsx'));
  }
  if (/\.d\.ts$/.test(base)) {
    push(base.replace(/\.d\.ts$/, '.ts'));
  }
  if (!posix.extname(base)) {
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.md', '.mdx', '.json']) {
      push(`${base}${ext}`);
    }
  }
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.md']) {
    push(`${base}/index${ext}`);
  }
  return candidates;
}

/** Resolve a relative module/link specifier to a workspace-relative path. */
export function resolveRelative(
  fromRel: string,
  spec: string,
  known: Set<string>,
): string | null {
  const fromDir = posix.dirname(fromRel);
  const clean = spec.replace(/[?#].*$/, '');
  let base = posix.normalize(posix.join(fromDir, clean));
  if (base.startsWith('../')) return null; // outside the workspace
  base = base.replace(/^\.\//, '').replace(/\/$/, '');
  for (const candidate of candidatesFor(base)) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve an already workspace-relative base (alias target, package entry). */
export function resolveFromRoot(base: string, known: Set<string>): string | null {
  const clean = toPosix(base).replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('../')) return null;
  for (const candidate of candidatesFor(posix.normalize(clean))) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* tsconfig paths aliases                                              */
/* ------------------------------------------------------------------ */

/** A `compilerOptions.paths` mapping, resolved against the workspace root. */
export interface AliasMap {
  /** Workspace-relative base every substitution is joined to ('' = root). */
  baseUrl: string;
  /** `pattern` keeps its `*`; `subs` are the path substitutions. */
  patterns: { pattern: string; subs: string[] }[];
}

/**
 * Read `baseUrl` and `paths` from the root tsconfig/jsconfig, following the
 * `extends` chain (local files only; node_modules extends are ignored).
 * Returns null when no usable `paths` mapping exists.
 */
export function loadAliasMap(root: string): AliasMap | null {
  const configs: { dir: string; compilerOptions: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  let configPath = join(root, 'tsconfig.json');
  if (!existsSync(configPath)) configPath = join(root, 'jsconfig.json');
  while (existsSync(configPath) && !seen.has(configPath) && configs.length < 6) {
    seen.add(configPath);
    const parsed = parseJsonc(readFileSafe(configPath) ?? '');
    if (!parsed) break;
    const dir = dirname(configPath);
    const co = parsed.compilerOptions;
    configs.push({ dir, compilerOptions: co && typeof co === 'object' ? (co as Record<string, unknown>) : {} });
    const ext = parsed.extends;
    if (typeof ext !== 'string' || !ext.startsWith('.')) break;
    configPath = resolve(dir, ext.endsWith('.json') ? ext : `${ext}.json`);
  }
  if (configs.length === 0) return null;

  // Apply from the outermost ancestor down so nearer configs override.
  let baseUrl = '.';
  let paths: Record<string, string[]> | null = null;
  for (let i = configs.length - 1; i >= 0; i -= 1) {
    const { dir, compilerOptions } = configs[i]!;
    if (typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl) {
      const resolved = resolve(dir, compilerOptions.baseUrl);
      baseUrl = relative(root, resolved);
      if (baseUrl.startsWith('..')) return null; // baseUrl outside the workspace
    }
    if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
      const map: Record<string, string[]> = {};
      for (const [pattern, subs] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
        if (Array.isArray(subs) && subs.every((s): s is string => typeof s === 'string')) {
          map[pattern] = subs;
        }
      }
      paths = map;
    }
  }
  if (!paths || Object.keys(paths).length === 0) return null;
  const normalizedBase = toPosix(baseUrl).replace(/^\.\//, '').replace(/\/+$/, '');
  return {
    baseUrl: normalizedBase === '.' ? '' : normalizedBase,
    patterns: Object.entries(paths).map(([pattern, subs]) => ({ pattern, subs })),
  };
}

/** Resolve a bare specifier through a paths mapping, or null. */
export function resolveAlias(map: AliasMap, spec: string, known: Set<string>): string | null {
  for (const { pattern, subs } of map.patterns) {
    let middles: string[] | null = null;
    const star = pattern.indexOf('*');
    if (star >= 0) {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length) {
        const middle = spec.slice(prefix.length, spec.length - suffix.length);
        middles = subs.map((sub) => (sub.includes('*') ? sub.replace('*', middle) : sub));
      }
    } else if (spec === pattern) {
      middles = subs;
    }
    if (!middles) continue;
    for (const middle of middles) {
      const base = posix.normalize(posix.join(map.baseUrl || '.', middle));
      const target = resolveFromRoot(base, known);
      if (target) return target;
    }
  }
  return null;
}

/** Parse JSONC: comments masked (strings preserved), trailing commas dropped. */
function parseJsonc(text: string): Record<string, unknown> | null {
  const masked = maskComments(text);
  let out = '';
  let inString = false;
  let quote = '';
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < masked.length) {
        out += (masked[i + 1] as string);
        i += 1;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch !== ',') {
      out += ch;
      continue;
    }
    let j = i + 1;
    while (j < masked.length && /\s/.test(masked[j] as string)) j += 1;
    const next = masked[j];
    if (next === '}' || next === ']') continue; // drop the trailing comma
    out += ch;
  }
  try {
    return JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `@scope/pkg/sub` -> `@scope/pkg`, `pkg/sub` -> `pkg`. */
export function packageNameOf(spec: string): string | null {
  if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

export function isBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec.split('/')[0] ?? '');
}

/**
 * Replace `//` and block comments with spaces, preserving string literals and
 * every byte offset so line numbers stay exact.
 */
export function maskComments(source: string): string {
  const out = source.split('');
  const len = source.length;
  let i = 0;
  while (i < len) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < len && source[i] !== '\n') {
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i += 1;
      }
      if (i < len) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < len) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}
