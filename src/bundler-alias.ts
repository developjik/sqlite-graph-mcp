/**
 * Bundler `resolve.alias` support (vite / webpack config files).
 *
 * Parsing is deliberately literal: only object-form `alias: { key: 'path' }`
 * entries whose values are string literals are read. Package redirects
 * (`react: 'preact/compat'`) and computed values (`path.resolve(...)`) are
 * skipped, so an unsupported entry is never guessed at.
 */
import * as posix from 'node:path/posix';

export interface BundlerAlias {
  /** Import prefix to match (`@`, `@components`, `~utils`). */
  find: string;
  /** Workspace-relative replacement base ('' = workspace root). */
  replacement: string;
}

const ALIAS_HEAD = /\balias\s*:\s*\{/g;
const QUOTED_ENTRY = /(['"])([^'"\n]+)\1\s*:\s*(['"])([^'"\n]+)\3/g;
const IDENT_ENTRY = /\b([A-Za-z_$][\w$]*)\s*:\s*(['"])([^'"\n]+)\2/g;

/** Bodies of every `alias: { … }` object literal in a config source. */
function aliasBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const match of source.matchAll(ALIAS_HEAD)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(start, i));
          break;
        }
      }
    }
  }
  return blocks;
}

/**
 * Turn a config-relative path value into a workspace-relative base.
 * Returns null for package redirects and paths that escape the workspace.
 */
function replacementFor(configDir: string, value: string): string | null {
  // Only path-like values are aliases; bare names are package redirects.
  if (!value.startsWith('.') && !value.startsWith('/')) return null;
  const joined = value.startsWith('/')
    ? posix.join('.', value)
    : posix.join(configDir || '.', value);
  const clean = posix.normalize(joined).replace(/^\.\/?/, '').replace(/\/+$/, '');
  if (clean === '..' || clean.startsWith('../')) return null;
  return clean;
}

/**
 * Read the object-form `alias` entries of one vite/webpack config file.
 * `configDir` is the config's workspace-relative directory ('' = root).
 * The longest `find` is first, so the most specific alias wins.
 */
export function parseBundlerAliases(source: string, configDir: string): BundlerAlias[] {
  const out = new Map<string, string>();
  const collect = (find: string, value: string): void => {
    if (out.has(find)) return;
    const replacement = replacementFor(configDir, value);
    if (replacement !== null) out.set(find, replacement);
  };
  for (const block of aliasBlocks(source)) {
    for (const m of block.matchAll(QUOTED_ENTRY)) collect(m[2] ?? '', m[4] ?? '');
    for (const m of block.matchAll(IDENT_ENTRY)) collect(m[1] ?? '', m[3] ?? '');
  }
  return [...out.entries()]
    .map(([find, replacement]) => ({ find, replacement }))
    .sort((a, b) => b.find.length - a.find.length);
}

/**
 * Resolve an import specifier through bundler aliases. An alias matches the
 * exact specifier or a `find/…` prefix. `resolveBase` maps the rewritten
 * workspace-relative base to an indexed file (or null).
 */
export function resolveBundlerAlias(
  aliases: BundlerAlias[],
  spec: string,
  resolveBase: (base: string) => string | null,
): string | null {
  for (const { find, replacement } of aliases) {
    if (spec !== find && !spec.startsWith(`${find}/`)) continue;
    const rest = spec.slice(find.length);
    const base = posix.normalize(posix.join(replacement || '.', `.${rest}`)).replace(/^\.\/?/, '').replace(/\/+$/, '');
    const target = resolveBase(base);
    if (target) return target;
  }
  return null;
}
