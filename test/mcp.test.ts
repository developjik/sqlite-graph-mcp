import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { GraphStore } from '../src/db.js';
import { cliPath, fixtureRoot, repoRoot, tempDir } from './helpers.js';

beforeAll(() => {
  if (!existsSync(cliPath)) {
    execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
});

interface ToolPayload {
  content: { type: string; text: string }[];
  isError?: boolean;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as ToolPayload).content;
  expect(Array.isArray(content)).toBe(true);
  const text = content[0]?.text ?? '';
  return JSON.parse(text) as Record<string, unknown>;
}

async function withClient(
  fn: (client: Client, paths: { dir: string; dbPath: string }) => Promise<void>,
): Promise<void> {
  const dir = tempDir('mcp');
  const dbPath = join(dir, 'index.db');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, 'serve', '--root', fixtureRoot, '--db', dbPath],
    cwd: repoRoot,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'sqlite-graph-mcp-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await fn(client, { dir, dbPath });
  } finally {
    await client.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('MCP server over stdio (SDK client)', () => {
  it('advertises the five operators and the index tool', async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        'graph_diff',
        'graph_filter',
        'graph_find',
        'graph_index',
        'graph_orphans',
        'graph_plan',
        'graph_walk',
      ]);
      for (const tool of tools.tools) {
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  it('indexes on demand and answers every tool call', async () => {
    await withClient(async (client) => {
      const indexed = payloadOf(
        await client.callTool({ name: 'graph_index', arguments: {} }),
      );
      expect(indexed.ok).toBe(true);
      expect(indexed.files).toBe(12);

      const found = payloadOf(
        await client.callTool({ name: 'graph_find', arguments: { query: 'walkGraph', kind: 'symbol' } }),
      );
      const nodes = found.nodes as { id: number; key: string; citation: string }[];
      expect(nodes.length).toBeGreaterThan(0);
      expect(nodes[0]?.key).toBe('symbol:src/graph/walker.ts#walkGraph');
      expect(nodes[0]?.citation).toBe('src/graph/walker.ts:7');

      const walked = payloadOf(
        await client.callTool({
          name: 'graph_walk',
          arguments: { start: [nodes[0]?.id], edgeType: 'defines', direction: 'in', maxDepth: 1 },
        }),
      );
      expect((walked.nodes as { key: string }[]).map((n) => n.key)).toContain('file:src/graph/walker.ts');

      const cycle = payloadOf(
        await client.callTool({
          name: 'graph_walk',
          arguments: { start: ['file:src/graph/cycle-a.ts'], edgeType: 'imports', maxDepth: 20 },
        }),
      );
      expect((cycle.nodes as unknown[]).length).toBe(2);

      const planned = payloadOf(
        await client.callTool({
          name: 'graph_plan',
          arguments: {
            plan: 'find "walker" kind=symbol | walk type=defines dir=in depth=1 | filter kind=file',
          },
        }),
      );
      expect(planned.citations).toContain('src/graph/walker.ts:1');
      expect((planned.steps as unknown[]).length).toBe(3);

      const filtered = payloadOf(
        await client.callTool({
          name: 'graph_filter',
          arguments: { ids: [nodes[0]?.id], kind: 'symbol', tag: 'exported' },
        }),
      );
      expect((filtered.nodes as unknown[]).length).toBe(1);

      const orphans = payloadOf(
        await client.callTool({ name: 'graph_orphans', arguments: {} }),
      );
      expect((orphans.files as { path: string }[]).map((f) => f.path)).toContain('src/legacy.ts');
    });
  });

  it('reports tool errors without killing the server', async () => {
    await withClient(async (client) => {
      const bad = (await client.callTool({
        name: 'graph_plan',
        arguments: { plan: 'bogus step' },
      })) as ToolPayload;
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toMatch(/Unknown plan op/);

      const good = payloadOf(
        await client.callTool({ name: 'graph_find', arguments: { query: 'greet' } }),
      );
      expect(good.count).toBeGreaterThan(0);
    });
  });
});

/** Minimal newline-delimited JSON-RPC client, to prove the wire protocol directly. */
class RawStdioClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (message: Record<string, unknown>) => void>();

  constructor(args: string[]) {
    this.child = spawn(process.execPath, args, { cwd: repoRoot, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.child.stderr.resume();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof id === 'number') {
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(message);
      }
    }
  }

  request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timed out waiting for ${method}`));
        }
      }, 15_000);
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.child.kill();
  }
}

describe('MCP server raw JSON-RPC framing', () => {
  it('speaks initialize / tools/list / tools/call as newline-delimited JSON', async () => {
    const dir = tempDir('raw-mcp');
    const client = new RawStdioClient([
      cliPath,
      'serve',
      '--root',
      fixtureRoot,
      '--db',
      join(dir, 'index.db'),
    ]);
    try {
      const init = await client.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-test', version: '0.0.0' },
      });
      const result = init.result as { serverInfo: { name: string }; protocolVersion: string };
      expect(result.serverInfo.name).toBe('sqlite-graph-mcp');
      expect(result.protocolVersion).toBeTruthy();
      client.notify('notifications/initialized');

      const list = await client.request('tools/list');
      const tools = (list.result as { tools: { name: string; description: string }[] }).tools;
      expect(tools.map((tool) => tool.name)).toContain('graph_plan');
      expect(tools.every((tool) => tool.description.length > 20)).toBe(true);

      const call = await client.request('tools/call', {
        name: 'graph_find',
        arguments: { query: 'greetEmoji' },
      });
      const content = (call.result as ToolPayload).content;
      const parsed = JSON.parse(content[0]?.text ?? '{}') as {
        nodes: { name: string; citation: string }[];
      };
      expect(parsed.nodes[0]?.name).toBe('greetEmoji');
      expect(parsed.nodes[0]?.citation).toBe('src/greet.ts:5');
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CLI', () => {
  it('indexes, queries and reports orphans from the command line', () => {
    const dir = tempDir('cli');
    try {
      const dbPath = join(dir, 'index.db');
      const indexOut = execFileSync(
        process.execPath,
        [cliPath, 'index', fixtureRoot, '--db', dbPath, '--json'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const stats = JSON.parse(indexOut) as { files: number; nodes: { total: number } };
      expect(stats.files).toBe(12);
      expect(stats.nodes.total).toBeGreaterThan(30);

      const findOut = execFileSync(
        process.execPath,
        [cliPath, 'find', 'walkGraph', '--db', dbPath, '--json'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const found = JSON.parse(findOut) as { nodes: { key: string }[] };
      expect(found.nodes[0]?.key).toBe('symbol:src/graph/walker.ts#walkGraph');

      const planOut = execFileSync(
        process.execPath,
        [
          cliPath,
          'plan',
          'find "walker" kind=file | walk type=imports dir=in depth=1',
          '--db',
          dbPath,
          '--json',
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const answer = JSON.parse(planOut) as { steps: unknown[] };
      expect(answer.steps).toHaveLength(2);

      const orphanOut = execFileSync(
        process.execPath,
        [cliPath, 'orphans', '--db', dbPath, '--json'],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      const orphans = JSON.parse(orphanOut) as { files: { path: string }[] };
      expect(orphans.files.map((file) => file.path)).toContain('src/legacy.ts');

      const help = execFileSync(process.execPath, [cliPath, 'help'], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      expect(help).toContain('Operator 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs when invoked through a symlink, as npx and npm bins do', () => {
    const dir = tempDir('bin-link');
    try {
      const link = join(dir, 'sqlite-graph-mcp');
      symlinkSync(cliPath, link);
      const out = execFileSync(process.execPath, [link, '--version'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints version and help for the leading flags without starting the server', () => {
    const version = execFileSync(process.execPath, [cliPath, '--version'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+$/);

    const help = execFileSync(process.execPath, [cliPath, '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(help).toContain('Operator 5');
    expect(help).toContain('--root');
  });

  it('rejects invalid --max-files values without touching an existing index', () => {
    const dir = tempDir('cli-maxfiles');
    try {
      const dbPath = join(dir, 'index.db');
      execFileSync(process.execPath, [cliPath, 'index', fixtureRoot, '--db', dbPath], {
        cwd: repoRoot,
      });
      const before = new GraphStore(dbPath);
      const nodeCount = before.countNodes();
      before.close();
      expect(nodeCount).toBeGreaterThan(0);

      for (const args of [
        ['--max-files=0'],
        ['--max-files=-3'],
        ['--max-files=abc'],
        ['--max-files=2.5'],
        ['--max-files'],
      ]) {
        let status = 0;
        try {
          execFileSync(
            process.execPath,
            [cliPath, 'index', fixtureRoot, '--db', dbPath, ...args],
            { cwd: repoRoot, stdio: 'pipe' },
          );
        } catch (error) {
          status = (error as { status?: number }).status ?? -1;
        }
        expect(status).not.toBe(0);
      }

      const after = new GraphStore(dbPath);
      expect(after.countNodes()).toBe(nodeCount);
      after.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 when a search finds nothing', () => {
    const dir = tempDir('cli-empty');
    try {
      const dbPath = join(dir, 'index.db');
      execFileSync(process.execPath, [cliPath, 'index', fixtureRoot, '--db', dbPath], {
        cwd: repoRoot,
      });
      let status = 0;
      try {
        execFileSync(process.execPath, [cliPath, 'find', 'zzz-nothing', '--db', dbPath], {
          cwd: repoRoot,
          stdio: 'pipe',
        });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }
      expect(status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
