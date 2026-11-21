import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import * as posix from 'node:path/posix';

import { GraphStore, defaultDbPath } from './db.js';
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

interface PendingLink {
  fromKey: string;
  fromPath: string;
  target: string;
  line: number;
  /** `imports` for module specifiers, `links_to` for markdown links. */
  edge: 'imports' | 'links_to';
}

interface PackageInfo {
  name: string;
  version?: string;
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
export function indexWorkspace(options: IndexOptions): IndexStats {
  const started = Date.now();
  const root = resolve(options.root);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${root}`);
  }

  const dbPath = options.dbPath ? resolve(options.dbPath) : defaultDbPath(root);
  const collected = collectFiles(root, options);
  const relPaths = new Set(collected.files.map((f) => f.rel));

  const nodes = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  const pendingLinks: PendingLink[] = [];
  const packages = new Map<string, PackageInfo>();

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
    if (patch.external === false) info.external = false;
    if (patch.dev) info.dev = true;
    for (const m of patch.manifests ?? []) info.manifests.add(m);
    return info;
  };

  for (const file of collected.files) {
    const source = readFileSafe(file.abs);
    if (source === null) {
      collected.skipped += 1;
      continue;
    }
    const base = posix.basename(file.rel);
    if (base === 'package.json') {
      indexManifest(file.rel, source, addNode, addEdge, upsertPackage);
      continue;
    }
    const ext = posix.extname(file.rel).toLowerCase();
    if (CODE_EXTENSIONS.has(ext)) {
      indexCodeFile(file.rel, source, addNode, addEdge, pendingLinks, upsertPackage);
    } else if (DOC_EXTENSIONS.has(ext)) {
      indexDocFile(file.rel, source, addNode, addEdge, pendingLinks);
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

  // Resolve markdown links against the file/heading index.
  const headingKeys = new Set(
    [...nodes.values()].filter((n) => n.kind === 'heading').map((n) => n.key),
  );
  for (const link of pendingLinks) {
    resolveLink(link, relPaths, headingKeys, addEdge);
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
      store.setMeta('schema_version', '1');
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
        total: counts['edge:total'] ?? 0,
      },
      durationMs: Date.now() - started,
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

type AddNode = (node: ParsedNode) => void;
type AddEdge = (src: string, dst: string, type: EdgeType, line: number | null) => void;

function indexManifest(
  rel: string,
  source: string,
  addNode: AddNode,
  addEdge: AddEdge,
  upsertPackage: (name: string, patch: Partial<PackageInfo>) => PackageInfo,
): void {
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

function indexCodeFile(
  rel: string,
  source: string,
  addNode: AddNode,
  addEdge: AddEdge,
  pendingLinks: PendingLink[],
  upsertPackage: (name: string, patch: Partial<PackageInfo>) => PackageInfo,
): void {
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

  const masked = maskComments(source);
  const lineStarts = computeLineStarts(masked);

  // ---- imports / re-exports / requires ----
  const importPatterns: RegExp[] = [
    /(?:^|[^\w$])(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\sfrom\s*)?['"]([^'"\n]+)['"]/g,
    /(?:^|[^\w$.])require\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  const seenSpecs = new Set<string>();
  for (const pattern of importPatterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
      const spec = match[1];
      if (!spec) continue;
      const quoteIndex = masked.indexOf(spec, match.index);
      const line = lineAtIndex(lineStarts, quoteIndex >= 0 ? quoteIndex : match.index);
      const key = `${spec}:${line}`;
      if (seenSpecs.has(key)) continue;
      seenSpecs.add(key);

      if (spec.startsWith('.') || spec.startsWith('/')) {
        pendingLinks.push({ fromKey: fileKey, fromPath: rel, target: spec, line, edge: 'imports' });
      } else {
        const pkg = packageNameOf(spec);
        if (!pkg || isBuiltin(spec)) continue;
        upsertPackage(pkg, { external: true });
        addEdge(fileKey, `package:${pkg}`, 'depends_on', line);
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

  const lines = masked.split('\n');
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

function indexDocFile(
  rel: string,
  source: string,
  addNode: AddNode,
  addEdge: AddEdge,
  pendingLinks: PendingLink[],
): void {
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

function resolveLink(
  link: PendingLink,
  relPaths: Set<string>,
  headingKeys: Set<string>,
  addEdge: AddEdge,
): void {
  const raw = link.target.trim();
  if (!raw) return;

  // Relative module specifiers: always a file-to-file `imports` edge.
  if (link.edge === 'imports') {
    const target = resolveRelative(link.fromPath, raw, relPaths);
    if (target) addEdge(link.fromKey, `file:${target}`, 'imports', link.line);
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

  const candidates: string[] = [];
  const push = (c: string): void => {
    if (!candidates.includes(c)) candidates.push(c);
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

  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
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
