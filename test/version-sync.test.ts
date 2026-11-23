import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoRoot, tempDir } from './helpers.js';

const script = join(repoRoot, 'scripts', 'check-version-sync.mjs');
const name = '@developjik/sqlite-graph-mcp';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function workspace(v: { pkg: string; server: string; npm: string; changelog: string }): string {
  const dir = tempDir('version-sync');
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: v.pkg }));
  writeFileSync(
    join(dir, 'server.json'),
    JSON.stringify({
      version: v.server,
      packages: [{ registryType: 'npm', identifier: name, version: v.npm }],
    }),
  );
  writeFileSync(
    join(dir, 'CHANGELOG.md'),
    `# Changelog\n\n## ${v.changelog} (2026-11-22)\n\n- New thing.\n\n## 0.0.1 (2026-11-01)\n\n- Old thing.\n`,
  );
  return dir;
}

const run = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, '--root', dir, ...args], { encoding: 'utf8' });

describe('check-version-sync', () => {
  const synced = { pkg: '1.2.0', server: '1.2.0', npm: '1.2.0', changelog: '1.2.0' };

  it('passes when every version matches, including the tag', () => {
    const r = run(workspace(synced), '--tag', 'v1.2.0');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Versions in sync: 1.2.0');
  });

  it.each([
    ['server.json version', { server: '1.1.0' }],
    ['server.json packages[npm', { npm: '1.1.0' }],
    ['CHANGELOG.md latest heading', { changelog: '1.1.0' }],
  ])('fails when %s lags behind package.json', (where, override) => {
    const r = run(workspace({ ...synced, ...override }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(where);
  });

  it('fails when the tag does not match', () => {
    const r = run(workspace(synced), '--tag', 'v1.3.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git tag (expected v1.2.0): v1.3.0');
  });

  it('fails on a tag without the v prefix', () => {
    const r = run(workspace(synced), '--tag', '1.2.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('git tag (expected v1.2.0): 1.2.0');
  });

  it('writes only the latest CHANGELOG section as release notes', () => {
    const dir = workspace(synced);
    const out = join(dir, 'notes.md');
    expect(run(dir, '--notes-out', out).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('- New thing.\n');
  });

  it('passes on the repository itself', () => {
    expect(run(repoRoot).status).toBe(0);
  });
});
