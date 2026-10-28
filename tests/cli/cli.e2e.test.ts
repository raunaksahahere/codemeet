import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cleanup, createTestDatabase, freePort, hasDb, tmpProject, waitFor } from '../helpers.js';

const CLI = path.resolve(__dirname, '../../cli/dist/codemeet.cjs');
const FAKE = path.resolve(__dirname, '../fixtures/fake-provider.mjs');

interface Result { stdout: string; stderr: string; code: number }
function run(home: string, args: string[], env: Record<string, string> = {}, timeout = 60_000): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, CODEMEET_HOME: home, CODEMEET_CLAUDE_BIN: FAKE, CODEMEET_CODEX_BIN: FAKE, ...env }, timeout }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, code: err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number) || 1 : 0 });
    });
  });
}
const json = async <T,>(home: string, args: string[]): Promise<T> => JSON.parse((await run(home, args)).stdout) as T;

describe.runIf(hasDb)('CLI end to end (built bundle)', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: ChildProcess;
  let serverUrl = '';
  const homes: Record<string, string> = {};
  const projects: Record<string, string> = {};
  let roomId = '';
  const PW = 'cli-secret-pw';

  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error('Build the CLI first: pnpm --filter ./cli build');
    db = await createTestDatabase();
    for (const n of ['sam', 'ava', 'cy']) homes[n] = mkdtempSync(path.join(tmpdir(), `cm-home-${n}-`));
    projects.sam = tmpProject({ 'src/index.ts': 'export const greet = () => "hello";\n', 'README.md': '# demo\n', '.env': 'SECRET=1\n' });
    projects.ava = tmpProject();
    projects.cy = tmpProject({ 'README.md': '# my own readme\n', 'private.txt': 'keep private' });
  });
  afterAll(async () => {
    for (const n of ['cy', 'ava', 'sam']) await run(homes[n]!, ['leave']).catch(() => undefined);
    server?.kill('SIGTERM');
    await db.drop().catch(() => undefined);
    cleanup(...Object.values(homes), ...Object.values(projects));
  });

  it('init validates the connection string, protects server.env and never prints the secret', async () => {
    const bad = await run(homes.sam!, ['init', '--database-url-env', 'BAD'], { BAD: 'eyJhbGciOiJIUzI1NiJ9.service-role-key' });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toMatch(/anon\/service-role key/);
    const good = await run(homes.sam!, ['init', '--database-url-env', 'GOOD', '--migrate'], { GOOD: db.url });
    expect(good.code).toBe(0);
    expect(good.stdout + good.stderr).not.toContain(new URL(db.url).password);
    const envFile = path.join(homes.sam!, 'server.env');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(homes.sam!).mode & 0o777).toBe(0o700);
    expect(readFileSync(envFile, 'utf8')).toContain('DATABASE_URL=');
    const check = await run(homes.sam!, ['db', 'check']);
    expect(check.stdout).toMatch(/Schema is up to date/);
  });

  it('starts the server from the owner\'s private config and reports readiness', async () => {
    const port = await freePort();
    serverUrl = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [CLI, 'server', 'start', '--port', String(port)], { env: { ...process.env, CODEMEET_HOME: homes.sam! }, stdio: 'ignore' });
    await waitFor(async () => (await fetch(`${serverUrl}/readyz`).catch(() => null))?.status === 200, 'server ready');
  });

  it('creates a room, admits a guest, syncs files both ways, and never shares secrets', async () => {
    const created = await run(homes.sam!, ['room', 'create', '--name', 'Sam', '--project', projects.sam!, '--server', serverUrl], { CODEMEET_ROOM_PASSWORD: PW });
    expect(created.code).toBe(0);
    roomId = /Room ID:\s+(\S+)/.exec(created.stdout)![1]!;

    const joining = run(homes.ava!, ['room', 'join', roomId, '--name', 'Ava', '--project', projects.ava!, '--server', serverUrl], { CODEMEET_ROOM_PASSWORD: PW });
    const req = await waitFor(async () => (await json<{ pending: { id: string }[] }>(homes.sam!, ['status', '--json'])).pending[0], 'join request');
    expect((await run(homes.sam!, ['members', 'approve', req.id])).code).toBe(0);
    expect((await joining).code).toBe(0);

    expect(readFileSync(path.join(projects.ava!, 'src/index.ts'), 'utf8')).toBe('export const greet = () => "hello";\n');
    expect(existsSync(path.join(projects.ava!, '.env'))).toBe(false);

    writeFileSync(path.join(projects.ava!, 'src/index.ts'), 'export const greet = () => "hello";\n// ava\n');
    await waitFor(() => readFileSync(path.join(projects.sam!, 'src/index.ts'), 'utf8').includes('// ava'), 'ava edit reaches sam');
    writeFileSync(path.join(projects.sam!, 'notes.md'), 'from sam');
    await waitFor(() => existsSync(path.join(projects.ava!, 'notes.md')), 'sam file reaches ava');

    const sam = await json<{ phase: string; participants: { label: string }[] }>(homes.sam!, ['status', '--json']);
    expect(sam.phase).toBe('syncing');
    expect(sam.participants.map((p) => p.label)).toEqual(expect.arrayContaining(['Sam', 'Ava']));
  });

  it('protects the local control channel: restrictive permissions and token authentication', async () => {
    const info = JSON.parse(readFileSync(path.join(homes.sam!, 'daemon.json'), 'utf8')) as { endpoint: string; token: string };
    expect(statSync(path.join(homes.sam!, 'daemon.json')).mode & 0o777).toBe(0o600);
    if (!info.endpoint.startsWith('127.0.0.1:')) expect(statSync(info.endpoint).mode & 0o777).toBe(0o600);
    const attempt = (first: string) =>
      new Promise<string>((resolve) => {
        const s = info.endpoint.startsWith('127.0.0.1:') ? net.connect({ host: '127.0.0.1', port: Number(info.endpoint.split(':')[1]) }) : net.connect(info.endpoint);
        let data = '';
        s.on('data', (d) => (data += d.toString()));
        s.on('close', () => resolve(data));
        s.on('error', () => resolve(data));
        s.write(first + '\n');
        setTimeout(() => s.destroy(), 1500);
      });
    expect(await attempt(JSON.stringify({ id: 1, method: 'status' }))).toBe(''); // no token: dropped, no data
    expect(await attempt(JSON.stringify({ auth: 'not-the-token' }))).toBe('');
    expect(await attempt(JSON.stringify({ auth: info.token }))).toContain('authenticated');
  });

  it('runs an agent in an isolated snapshot; the other side reviews, only the owner/host approves; applied once', async () => {
    const r = await run(homes.ava!, ['agent', 'run', 'codex', 'add', 'math'], { FAKE_EDIT: 'src/math.ts::export const add = (a: number, b: number) => a + b;\n' });
    expect(r.code).toBe(0);
    const pid = /Proposal (p_\S+):/.exec(r.stdout)![1]!;
    expect(existsSync(path.join(projects.ava!, 'src/math.ts'))).toBe(false); // working tree untouched
    const listed = await run(homes.sam!, ['proposals']);
    expect(listed.stdout).toContain("Ava's Codex");
    expect((await run(homes.sam!, ['diff', pid])).stdout).toContain('+export const add');
    expect((await run(homes.sam!, ['approve', pid])).code).toBe(0);
    await waitFor(() => existsSync(path.join(projects.sam!, 'src/math.ts')) && existsSync(path.join(projects.ava!, 'src/math.ts')), 'applied on both');
    const again = await run(homes.sam!, ['approve', pid]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toMatch(/already applied/);
  });

  it('agent messaging is denied by default from the CLI too', async () => {
    const denied = await run(homes.sam!, ['messages', 'send', '--from', 'claude', '--to', "Ava's Codex", 'hello']);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/has not granted/);
    expect((await run(homes.sam!, ['permissions'])).stdout).toMatch(/Agent-to-agent messaging is off by default|publish_proposals/);
  });

  it('never overwrites a differing local file on join: reports, waits for explicit acceptance, backs up', async () => {
    const joining = run(homes.cy!, ['room', 'join', roomId, '--name', 'Cy', '--project', projects.cy!, '--server', serverUrl], { CODEMEET_ROOM_PASSWORD: PW });
    const req = await waitFor(async () => (await json<{ pending: { id: string }[] }>(homes.sam!, ['status', '--json'])).pending[0], 'cy request');
    await run(homes.sam!, ['members', 'approve', req.id]);
    const res = await joining;
    expect(res.code).toBe(3);
    expect(res.stdout).toMatch(/differ from the shared baseline/);
    expect(readFileSync(path.join(projects.cy!, 'README.md'), 'utf8')).toBe('# my own readme\n'); // untouched
    expect(existsSync(path.join(projects.cy!, 'src/index.ts'))).toBe(false); // nothing downloaded while blocked
    const accepted = await run(homes.cy!, ['baseline', 'accept']);
    expect(accepted.code).toBe(0);
    expect(readFileSync(path.join(projects.cy!, 'README.md'), 'utf8')).toBe('# demo\n');
    const backups = path.join(projects.cy!, '.codemeet', 'backups');
    const stamp = readdirSync(backups)[0]!;
    expect(readFileSync(path.join(backups, stamp, 'README.md'), 'utf8')).toBe('# my own readme\n');
    expect(readFileSync(path.join(projects.cy!, 'private.txt'), 'utf8')).toBe('keep private');
    await waitFor(async () => !(await run(homes.sam!, ['activity'])).stdout.includes('private.txt'), 'private file never announced');
    expect((await run(homes.cy!, ['leave'])).code).toBe(0);
  });

  it('resumes after the daemon stops: offline edits are merged, nothing duplicated or reverted', async () => {
    expect((await run(homes.ava!, ['leave', '--keep-membership'])).code).toBe(0);
    writeFileSync(path.join(projects.ava!, 'offline-ava.txt'), 'made while stopped');
    writeFileSync(path.join(projects.sam!, 'src/index.ts'), 'export const greet = () => "hello";\n// ava\n// sam while ava away\n');
    await waitFor(async () => (await run(homes.sam!, ['activity', '--limit', '3'])).stdout.includes('edited src/index.ts'), 'sam edit shared');
    const resumed = await run(homes.ava!, ['resume']);
    expect(resumed.code).toBe(0);
    await waitFor(() => existsSync(path.join(projects.sam!, 'offline-ava.txt')), 'offline-created file uploaded');
    await waitFor(() => readFileSync(path.join(projects.ava!, 'src/index.ts'), 'utf8').includes('sam while ava away'), 'missed change arrives');
    const finalText = readFileSync(path.join(projects.ava!, 'src/index.ts'), 'utf8');
    expect(finalText).toBe('export const greet = () => "hello";\n// ava\n// sam while ava away\n');
    expect(readFileSync(path.join(projects.sam!, 'src/index.ts'), 'utf8')).toBe(finalText);
  });

  it('serves MCP over stdio with clean stdout, attributes proposals to the owner\'s agent, and enforces consent', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [CLI, 'mcp', 'serve'], stderr: 'pipe',
      env: { ...(process.env as Record<string, string>), CODEMEET_HOME: homes.sam!, CODEMEET_AGENT: 'claude' },
    });
    const client = new Client({ name: 'e2e', version: '0.0.0' });
    let stderr = '';
    await client.connect(transport);
    transport.stderr?.on('data', (d) => (stderr += d.toString()));
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(['codemeet_participants', 'codemeet_propose_changes', 'codemeet_message_send', 'codemeet_activity']));
      const people = await client.callTool({ name: 'codemeet_participants', arguments: {} });
      expect(JSON.stringify(people.content)).toContain('Ava');
      const noConsent = await client.callTool({ name: 'codemeet_propose_changes', arguments: { title: 'via mcp', changes: [{ path: 'src/mcp.ts', op: 'create', content: 'export {}\n' }] } });
      expect(noConsent.isError).toBe(true);
      await run(homes.sam!, ['permissions', 'grant', 'publish', 'claude']);
      const ok = await client.callTool({ name: 'codemeet_propose_changes', arguments: { title: 'via mcp', changes: [{ path: 'src/mcp.ts', op: 'create', content: 'export {}\n' }] } });
      expect(ok.isError).toBeFalsy();
      const proposals = await run(homes.ava!, ['proposals']);
      expect(proposals.stdout).toContain("Sam's Claude");
      const spoof = await client.callTool({ name: 'codemeet_message_send', arguments: { to: 'Nobody', body: 'x' } });
      expect(spoof.isError).toBe(true);
    } finally {
      await client.close();
    }
    expect(stderr).toContain('[codemeet-mcp] ready');
  });

  it('leaves cleanly: the host closes the room, files stay, the daemon exits', async () => {
    expect((await run(homes.ava!, ['leave'])).code).toBe(0);
    expect((await run(homes.sam!, ['leave'])).code).toBe(0);
    expect(existsSync(path.join(homes.sam!, 'session.json'))).toBe(false);
    await waitFor(() => !existsSync(path.join(homes.sam!, 'daemon.json')), 'daemon stopped');
    expect(readFileSync(path.join(projects.sam!, 'README.md'), 'utf8')).toBe('# demo\n');
    const status = await run(homes.sam!, ['status']);
    expect(status.code).not.toBe(0);
    expect(status.stderr).toMatch(/No active CodeMeet session/);
  });
});
