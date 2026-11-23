#!/usr/bin/env node
// Fails unless package.json, server.json (top-level and its npm package entry)
// and the newest CHANGELOG.md heading carry the same version — and, with
// --tag, unless the git tag is v<version>. --notes-out writes that version's
// CHANGELOG section to a file (used as the GitHub Release body).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    root: { type: 'string', default: process.cwd() },
    tag: { type: 'string' },
    'notes-out': { type: 'string' },
  },
});

const read = (file) => readFileSync(join(values.root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const server = JSON.parse(read('server.json'));
const changelog = read('CHANGELOG.md');

const headings = [...changelog.matchAll(/^## v?(\d+\.\d+\.\d+\S*)/gm)];
const npmEntry = (server.packages ?? []).find(
  (p) => p.registryType === 'npm' && p.identifier === pkg.name,
);

const sources = {
  'package.json version': pkg.version,
  'server.json version': server.version,
  [`server.json packages[npm ${pkg.name}].version`]: npmEntry?.version,
  'CHANGELOG.md latest heading': headings[0]?.[1],
};
if (values.tag !== undefined) sources['git tag'] = values.tag.replace(/^v/, '');

const expected = pkg.version;
const mismatches = Object.entries(sources).filter(([, v]) => v !== expected);

if (mismatches.length > 0) {
  console.error(`Version mismatch (package.json is ${expected}):`);
  for (const [where, v] of mismatches) console.error(`  ${where}: ${v ?? '(missing)'}`);
  process.exit(1);
}

if (values['notes-out']) {
  const start = headings[0].index + headings[0][0].length;
  const end = headings[1]?.index ?? changelog.length;
  const body = changelog.slice(start, end).replace(/^[^\n]*\n/, '').trim();
  writeFileSync(values['notes-out'], `${body}\n`);
}

console.log(`Versions in sync: ${expected}`);
