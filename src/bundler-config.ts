import * as posix from 'node:path/posix';

import { parseBundlerAliases, type BundlerAlias } from './bundler-alias.js';

/** vite / webpack config modules whose object-form `resolve.alias` is read. */
const BUNDLER_CONFIG_NAME = /^(?:vite|webpack)\.config\.[cm]?[jt]s$/i;

/** A bundler config's alias entries and the workspace directory they apply under. */
export interface BundlerAliasEntry {
  /** '' means the workspace root: the entry applies to every file. */
  dir: string;
  aliases: BundlerAlias[];
}

/** True when a workspace-relative path names a vite or webpack config module. */
export function isBundlerConfig(rel: string): boolean {
  return BUNDLER_CONFIG_NAME.test(posix.basename(rel));
}

/**
 * Read `resolve.alias` entries from each config. `read` returns the file text
 * or null when it cannot be read; unreadable configs are skipped. The result is
 * ordered deepest directory first, so a package's own aliases win over root ones.
 */
export function loadBundlerAliasEntries(
  configRels: string[],
  read: (rel: string) => string | null,
): BundlerAliasEntry[] {
  const out: BundlerAliasEntry[] = [];
  for (const rel of configRels) {
    const source = read(rel);
    if (source === null) continue;
    const dirRel = posix.dirname(rel);
    const dir = dirRel === '.' ? '' : dirRel;
    const aliases = parseBundlerAliases(source, dir);
    if (aliases.length > 0) out.push({ dir, aliases });
  }
  const depth = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
  out.sort((a, b) => depth(b.dir) - depth(a.dir));
  return out;
}
