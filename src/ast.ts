import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser, Language } from 'web-tree-sitter';
import type { Node as WebNode } from 'web-tree-sitter';

/**
 * Optional AST engine over web-tree-sitter (WASM, no native build). When it
 * loads, symbol/import extraction switches from regexes to a real parse tree
 * and `references` edges are grounded in identifier usage, not import clauses.
 * The vendored grammar files are committed under `vendor/`; if anything fails
 * to load, the indexer silently falls back to the heuristic engine.
 */

interface LoadedGrammar {
  parser: Parser;
}

/** Both grammars loaded and ready to parse. */
export interface AstEngine {
  typescript: LoadedGrammar;
  tsx: LoadedGrammar;
}

let enginePromise: Promise<AstEngine | null> | null = null;

/**
 * The compiled file lives at dist/src/ (two levels below the package root),
 * the source at src/ (one level) — walk up until the vendored grammars appear.
 */
function findVendorFile(file: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i += 1) {
    const candidate = join(dir, 'vendor', file);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const LOAD_ATTEMPTS = 3;
const LOAD_BACKOFF_MS = 250;

/** One load attempt; throws when the WASM runtime or a grammar cannot load. */
async function loadEngineOnce(): Promise<AstEngine> {
  await Parser.init();
  // .tsx and .jsx need the tsx grammar; plain JS/TS parse with the typescript one.
  const typescriptWasm = findVendorFile('tree-sitter-typescript.wasm');
  const tsxWasm = findVendorFile('tree-sitter-tsx.wasm');
  if (!typescriptWasm || !tsxWasm) throw new Error('vendored tree-sitter grammars not found');
  const [typescript, tsx] = await Promise.all([
    Language.load(typescriptWasm),
    Language.load(tsxWasm),
  ]);
  const forLanguage = (language: Language): LoadedGrammar => {
    const parser = new Parser();
    parser.setLanguage(language);
    return { parser };
  };
  return { typescript: forLanguage(typescript), tsx: forLanguage(tsx) };
}

/**
 * The Emscripten module (and a loaded grammar) occasionally fails to
 * instantiate on a busy CI runner — a transient stderr warning from the
 * runtime rather than a bad grammar. Retrying a few times keeps a healthy
 * workspace from silently dropping to the regex engine for a whole process.
 */
async function loadEngine(): Promise<AstEngine | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt += 1) {
    try {
      return await loadEngineOnce();
    } catch (error) {
      lastError = error;
      if (attempt < LOAD_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, LOAD_BACKOFF_MS * attempt));
      }
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  process.stderr.write(`sqlite-graph-mcp: AST engine unavailable (${reason}); indexing with the heuristic engine\n`);
  return null;
}

/** Load (once) the AST engine, or null when it is unavailable. */
export function getAstEngine(): Promise<AstEngine | null> {
  if (!enginePromise) {
    enginePromise = loadEngine().then((engine) => {
      // Never cache a failed load: a later call (or process) can still get the AST engine.
      if (!engine) enginePromise = null;
      return engine;
    });
  }
  return enginePromise;
}

/** Test hook: forget the cached engine so the next call reloads it. */
export function resetAstEngineCache(): void {
  enginePromise = null;
}

export interface AstNamedBinding {
  /** Name visible inside this file. */
  local: string;
  /** Exported name in the source module (`a` in `import { a as b }`). */
  imported: string;
  /** First line the local name is actually used on; null when unused. */
  usedAtLine: number | null;
  /** Members reached through this local (`Ns.Member`, `obj.member`) → first use line. */
  props: Map<string, number>;
}

export interface AstImport {
  spec: string;
  line: number;
  defaultLocal: { local: string; usedAtLine: number | null; props: Map<string, number> } | null;
  namespaceLocal: { local: string; props: Map<string, number> } | null;
  /** `export * [as ns] from '…'` statement (namespace re-export included). */
  exportAllLine: number | null;
  /** `export * as ns from '…'` — the namespace name the file re-exports. */
  namespaceExport: string | null;
  /** `export … from '…'`: this entry re-exports rather than imports. */
  isReexport: boolean;
  named: AstNamedBinding[];
}

export interface AstSymbol {
  name: string;
  line: number;
  kind: string;
  exported: boolean;
  defaultExport: boolean;
  snippet: string;
}

export interface AstParse {
  imports: AstImport[];
  symbols: AstSymbol[];
  /** Local names exported via `export { a }` lists. */
  listedExports: Set<string>;
  /** `export { a [as b] }` pairs: exported name → the local name it binds. */
  exportClauses: { exported: string; local: string; line: number }[];
  defaultExport: { line: number; text: string } | null;
}

const SYMBOL_NODE_KINDS: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

// The web bindings type child arrays as nullable; these guards restore a
// usable `WebNode[]` for iteration.

function childrenOf(node: WebNode): WebNode[] {
  return node.children.filter((c): c is WebNode => c !== null);
}

function namedChildrenOf(node: WebNode): WebNode[] {
  return node.namedChildren.filter((c): c is WebNode => c !== null);
}

function walk(node: WebNode, visit: (n: WebNode) => boolean): void {
  if (!visit(node)) return;
  for (const child of namedChildrenOf(node)) walk(child, visit);
}

function findDescendant(node: WebNode, pred: (n: WebNode) => boolean): WebNode | null {
  let found: WebNode | null = null;
  walk(node, (n) => {
    if (found) return false;
    if (pred(n)) {
      found = n;
      return false;
    }
    return true;
  });
  return found;
}

function findNamedChild(node: WebNode, type: string): WebNode | null {
  return namedChildrenOf(node).find((c) => c.type === type) ?? null;
}

function hasAnonymousChild(node: WebNode, token: string): boolean {
  return childrenOf(node).some((c) => !c.isNamed && c.type === token);
}

function stringSpec(node: WebNode): { spec: string; line: number } | null {
  if (node.type !== 'string') return null;
  const fragment = namedChildrenOf(node)[0];
  const spec = (fragment ? fragment.text : node.text).replace(/^['"]|['"]$/g, '');
  if (!spec) return null;
  return { spec, line: node.startPosition.row + 1 };
}

function isDeclarationNode(node: WebNode): boolean {
  return (
    node.type in SYMBOL_NODE_KINDS ||
    node.type === 'lexical_declaration' ||
    node.type === 'variable_declaration'
  );
}

function parseImportStatement(stmt: WebNode): AstImport | null {
  const sourceNode = stmt.childForFieldName('source') ?? findDescendant(stmt, (n) => n.type === 'string');
  if (!sourceNode) return null;
  const parsed = stringSpec(sourceNode);
  if (!parsed) return null;
  const imp: AstImport = {
    spec: parsed.spec,
    line: parsed.line,
    defaultLocal: null,
    namespaceLocal: null,
    exportAllLine: null,
    namespaceExport: null,
    isReexport: false,
    named: [],
  };
  const clause = findNamedChild(stmt, 'import_clause');
  if (!clause) return imp; // side-effect import `import './x'`
  for (const child of namedChildrenOf(clause)) {
    if (child.type === 'identifier' && !imp.defaultLocal) {
      imp.defaultLocal = { local: child.text, usedAtLine: null, props: new Map() };
    } else if (child.type === 'namespace_import') {
      const id = namedChildrenOf(child)[0];
      if (id) imp.namespaceLocal = { local: id.text, props: new Map() };
    } else if (child.type === 'named_imports') {
      for (const spec of namedChildrenOf(child)) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name') ?? namedChildrenOf(spec)[0];
        const alias = spec.childForFieldName('alias');
        if (!name) continue;
        imp.named.push({
          local: alias ? alias.text : name.text,
          imported: name.text,
          usedAtLine: null,
          props: new Map(),
        });
      }
    }
  }
  return imp;
}

function parseReexportStatement(stmt: WebNode, fromString: WebNode): AstImport | null {
  const parsed = stringSpec(fromString);
  if (!parsed) return null;
  const imp: AstImport = {
    spec: parsed.spec,
    line: parsed.line,
    defaultLocal: null,
    namespaceLocal: null,
    exportAllLine: null,
    namespaceExport: null,
    isReexport: true,
    named: [],
  };
  const clause = findNamedChild(stmt, 'export_clause');
  if (!clause) {
    // `export * [as ns] from './x'` — a bare star carries no symbol name,
    // but `* as ns` re-exports the module under a name importers can use.
    const nsExport = findNamedChild(stmt, 'namespace_export');
    if (nsExport) {
      const name = namedChildrenOf(nsExport)[0];
      if (name) imp.namespaceExport = name.text;
    }
    imp.exportAllLine = parsed.line;
    return imp;
  }
  for (const spec of namedChildrenOf(clause)) {
    if (spec.type !== 'export_specifier') continue;
    const name = spec.childForFieldName('name') ?? namedChildrenOf(spec)[0];
    const alias = spec.childForFieldName('alias');
    if (!name) continue;
    // A re-export is itself a usage: cite the export line.
    imp.named.push({
      local: alias ? alias.text : name.text,
      imported: name.text,
      usedAtLine: parsed.line,
      props: new Map(),
    });
  }
  return imp;
}

function requireSpecFromStatement(stmt: WebNode): AstImport | null {
  if (stmt.type !== 'lexical_declaration' && stmt.type !== 'variable_declaration') return null;
  const call = findDescendant(stmt, (n) => n.type === 'call_expression');
  if (!call) return null;
  const fn = call.childForFieldName('function');
  if (!fn || fn.type !== 'identifier' || fn.text !== 'require') return null;
  const arg = call.childForFieldName('arguments');
  const str = arg ? findDescendant(arg, (n) => n.type === 'string') : null;
  if (!str) return null;
  const parsed = stringSpec(str);
  if (!parsed) return null;
  const imp: AstImport = {
    spec: parsed.spec,
    line: parsed.line,
    defaultLocal: null,
    namespaceLocal: null,
    exportAllLine: null,
    namespaceExport: null,
    isReexport: false,
    named: [],
  };
  const declarator = findDescendant(stmt, (n) => n.type === 'variable_declarator');
  const first = namedChildrenOf(stmt)[0];
  const pattern =
    first && first.type !== 'variable_declarator' ? first : declarator ? declarator.childForFieldName('name') : null;
  bindPattern(imp, pattern);
  return imp;
}

/** Destructured/identifier bindings of a `require()` or `import()` result. */
function bindPattern(imp: AstImport, pattern: WebNode | null): void {
  if (pattern && pattern.type === 'object_pattern') {
    for (const prop of namedChildrenOf(pattern)) {
      if (prop.type === 'shorthand_property_identifier_pattern') {
        imp.named.push({ local: prop.text, imported: prop.text, usedAtLine: null, props: new Map() });
      } else if (prop.type === 'pair_pattern') {
        const key = prop.childForFieldName('key');
        const value = prop.childForFieldName('value');
        if (key && value && value.type === 'identifier') {
          imp.named.push({ local: value.text, imported: key.text, usedAtLine: null, props: new Map() });
        }
      }
    }
    return;
  }
  if (pattern && pattern.type === 'identifier') {
    imp.defaultLocal = { local: pattern.text, usedAtLine: null, props: new Map() };
  }
}

function pushDeclarationSymbols(
  node: WebNode,
  ctx: { exported: boolean; defaultExport: boolean; symbols: AstSymbol[] },
): void {
  const line = node.startPosition.row + 1;
  const snippet = (node.text.split('\n')[0] ?? '').slice(0, 300);
  const push = (name: string, kind: string): void => {
    ctx.symbols.push({ name, line, kind, exported: ctx.exported, defaultExport: ctx.defaultExport, snippet });
  };
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const child of namedChildrenOf(node)) {
      if (child.type !== 'variable_declarator') continue;
      const name = child.childForFieldName('name');
      if (name && name.type === 'identifier') push(name.text, 'variable');
    }
    return;
  }
  const kind = SYMBOL_NODE_KINDS[node.type];
  if (!kind) return;
  const name = node.childForFieldName('name');
  if (name) push(name.text, kind);
}

/** Parse one source file and extract imports, symbols and usage information. */
export function parseFile(engine: AstEngine, source: string, ext: string): AstParse | null {
  // .tsx and .jsx need the tsx grammar; plain JS/TS parse with the typescript one.
  const loaded = ext === '.tsx' || ext === '.jsx' ? engine.tsx : engine.typescript;
  let root: WebNode | null;
  try {
    root = loaded.parser.parse(source)?.rootNode ?? null;
  } catch {
    return null;
  }
  if (!root) return null;

  const lines = source.split('\n');
  const imports: AstImport[] = [];
  const symbols: AstSymbol[] = [];
  const listedExports = new Set<string>();
  const exportClauses: AstParse['exportClauses'] = [];
  let defaultExport: AstParse['defaultExport'] = null;

  // -- pass 1: module-level statements ------------------------------------
  const handledRequireStmts = new Set<WebNode>();
  for (const stmt of namedChildrenOf(root)) {
    if (stmt.type === 'import_statement') {
      const imp = parseImportStatement(stmt);
      if (imp) imports.push(imp);
      continue;
    }
    if (stmt.type === 'export_statement') {
      const isReexport = hasAnonymousChild(stmt, 'from');
      const fromString = findDescendant(stmt, (n) => n.type === 'string');
      if (isReexport && fromString) {
        const imp = parseReexportStatement(stmt, fromString);
        if (imp) imports.push(imp);
        continue;
      }
      const hasDefault = hasAnonymousChild(stmt, 'default');
      const declaration = namedChildrenOf(stmt).find(isDeclarationNode);
      if (hasDefault && !declaration) {
        defaultExport = { line: stmt.startPosition.row + 1, text: (lines[stmt.startPosition.row] ?? '').trim() };
        continue;
      }
      if (declaration) {
        pushDeclarationSymbols(declaration, { exported: true, defaultExport: hasDefault, symbols });
        if (hasDefault) {
          defaultExport = { line: stmt.startPosition.row + 1, text: (lines[stmt.startPosition.row] ?? '').trim() };
        }
        continue;
      }
      const clause = findNamedChild(stmt, 'export_clause');
      if (clause) {
        for (const spec of namedChildrenOf(clause)) {
          if (spec.type !== 'export_specifier') continue;
          const name = spec.childForFieldName('name') ?? namedChildrenOf(spec)[0];
          if (!name) continue;
          const alias = spec.childForFieldName('alias');
          listedExports.add(name.text);
          exportClauses.push({
            exported: alias ? alias.text : name.text,
            local: name.text,
            line: stmt.startPosition.row + 1,
          });
        }
      }
      continue;
    }
    if (isDeclarationNode(stmt)) {
      pushDeclarationSymbols(stmt, { exported: false, defaultExport: false, symbols });
      continue;
    }
    // `const { x } = require('...')` and friends.
    const req = requireSpecFromStatement(stmt);
    if (req) {
      imports.push(req);
      handledRequireStmts.add(stmt);
    }
  }

  // -- pass 1.5: `import('…')`/`require('…')` calls at any depth ------------
  // The module-level pass only sees top-level `const … = require()`; nested
  // calls (lazy dynamic imports, requires inside functions) are collected
  // here so they still produce `imports` edges and usage-based references.
  walk(root, (node) => {
    if (node.type !== 'call_expression') return true;
    const fn = node.childForFieldName('function');
    const isDynamicImport = fn !== null && fn.type === 'import';
    const isRequire = fn !== null && fn.type === 'identifier' && fn.text === 'require';
    if (!isDynamicImport && !isRequire) return true;
    // `const x = require('y')` at module level was already collected above.
    let top = node;
    while (top.parent && top.parent.type !== 'program') top = top.parent;
    if (isRequire && handledRequireStmts.has(top)) return true;
    const args = node.childForFieldName('arguments');
    const str = args ? findDescendant(args, (n) => n.type === 'string') : null;
    const parsed = str ? stringSpec(str) : null;
    if (!parsed) return true;
    const imp: AstImport = {
      spec: parsed.spec,
      line: parsed.line,
      defaultLocal: null,
      namespaceLocal: null,
      exportAllLine: null,
      namespaceExport: null,
      isReexport: false,
      named: [],
    };
    // `const { x } = await import('…')` / `const m = require('…')` — the call
    // is the declarator's value itself (modulo await/parens), so the pattern
    // binds to the module outright.
    let parent = node.parent;
    while (parent && (parent.type === 'await_expression' || parent.type === 'parenthesized_expression')) {
      parent = parent.parent;
    }
    if (parent && parent.type === 'variable_declarator') {
      bindPattern(imp, parent.childForFieldName('name'));
    } else {
      // A literal import anywhere in a declarator's initializer can supply
      // destructured names: `const { x } = yield* Effect.promise(() =>
      // import('…'))` binds `x` to the module. Identifier patterns keep the
      // strict rule — `const lazy = () => import('…')` binds a factory.
      let child: WebNode = node;
      let decl = node.parent;
      while (decl && decl.type !== 'variable_declarator') {
        child = decl;
        decl = decl.parent;
      }
      const name = decl?.childForFieldName('name');
      const value = decl?.childForFieldName('value');
      if (decl && value && child.equals(value) && name?.type === 'object_pattern') {
        bindPattern(imp, name);
      }
    }
    imports.push(imp);
    return true;
  });

  // -- pass 2: identifier usage against this file's own bindings -----------
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  for (const imp of imports) {
    if (imp.isReexport) continue; // re-export locals are not in-file bindings
    if (imp.defaultLocal) bindings.add(imp.defaultLocal.local);
    if (imp.namespaceLocal) namespaces.add(imp.namespaceLocal.local);
    for (const n of imp.named) bindings.add(n.local);
  }
  const usage = new Map<string, number>();
  const memberProps = new Map<string, Map<string, number>>();
  if (bindings.size > 0 || namespaces.size > 0) {
    walk(root, (node) => {
      if (node.type === 'import_statement') return false; // skip the binding sites
      if (node.type === 'member_expression' || node.type === 'nested_type_identifier') {
        const object =
          node.type === 'member_expression'
            ? node.childForFieldName('object')
            : namedChildrenOf(node)[0];
        const property =
          node.type === 'member_expression'
            ? node.childForFieldName('property')
            : namedChildrenOf(node)[1];
        if (
          object &&
          property &&
          (object.type === 'identifier' || object.type === 'type_identifier') &&
          (namespaces.has(object.text) || bindings.has(object.text))
        ) {
          let props = memberProps.get(object.text);
          if (!props) {
            props = new Map();
            memberProps.set(object.text, props);
          }
          const line = node.startPosition.row + 1;
          if (!props.has(property.text)) props.set(property.text, line);
        }
      }
      if (
        (node.type === 'identifier' ||
          node.type === 'type_identifier' ||
          node.type === 'shorthand_property_identifier') &&
        bindings.has(node.text)
      ) {
        if (!usage.has(node.text)) usage.set(node.text, node.startPosition.row + 1);
      }
      return true;
    });
  }
  const emptyProps = new Map<string, number>();
  for (const imp of imports) {
    if (imp.defaultLocal) {
      imp.defaultLocal.usedAtLine = usage.get(imp.defaultLocal.local) ?? null;
      imp.defaultLocal.props = memberProps.get(imp.defaultLocal.local) ?? new Map();
    }
    for (const n of imp.named) {
      if (imp.isReexport) {
        n.props = emptyProps;
      } else {
        n.usedAtLine = usage.get(n.local) ?? null;
        n.props = memberProps.get(n.local) ?? new Map();
      }
    }
    if (imp.namespaceLocal) imp.namespaceLocal.props = memberProps.get(imp.namespaceLocal.local) ?? new Map();
  }

  return { imports, symbols, listedExports, exportClauses, defaultExport };
}
