import { describe, expect, it } from 'vitest';

import { isBundlerConfig, loadBundlerAliasEntries } from '../src/bundler-config.js';

describe('isBundlerConfig', () => {
  it('matches vite and webpack config modules at any depth', () => {
    expect(isBundlerConfig('vite.config.ts')).toBe(true);
    expect(isBundlerConfig('apps/web/webpack.config.js')).toBe(true);
    expect(isBundlerConfig('vite.config.mjs')).toBe(true);
  });

  it('ignores unrelated files', () => {
    expect(isBundlerConfig('tsconfig.json')).toBe(false);
    expect(isBundlerConfig('src/vite.ts')).toBe(false);
  });
});

describe('loadBundlerAliasEntries', () => {
  const files: Record<string, string> = {
    'vite.config.ts': "export default { resolve: { alias: { '@': './src' } } };",
    'apps/web/vite.config.ts': "export default { resolve: { alias: { '~': './lib' } } };",
    'pkg/empty/webpack.config.js': 'module.exports = {};',
  };
  const read = (rel: string): string | null => files[rel] ?? null;

  it('keeps the config directory and rewrites replacements against it', () => {
    const entries = loadBundlerAliasEntries(['apps/web/vite.config.ts'], read);
    expect(entries).toEqual([
      { dir: 'apps/web', aliases: [{ find: '~', replacement: 'apps/web/lib' }] },
    ]);
  });

  it('orders deeper config directories first', () => {
    const entries = loadBundlerAliasEntries(['vite.config.ts', 'apps/web/vite.config.ts'], read);
    expect(entries.map((e) => e.dir)).toEqual(['apps/web', '']);
  });

  it('skips configs that cannot be read or have no alias block', () => {
    const entries = loadBundlerAliasEntries(
      ['missing/vite.config.ts', 'pkg/empty/webpack.config.js'],
      read,
    );
    expect(entries).toEqual([]);
  });
});
