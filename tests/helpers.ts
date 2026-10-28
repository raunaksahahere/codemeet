import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { startServer, loadConfig, type RunningServer } from '@codemeet/server';
import { DocSync, NodeWorkspace, Session, policyFromRoom, type StoredSession } from '@codemeet/core';
import { SharingPolicy } from '@codemeet/shared';

/** Admin connection used to create throwaway databases. Set by `pnpm test:db`. */
export const ADMIN_URL = process.env.CODEMEET_TEST_DATABASE_URL;
export const hasDb = Boolean(ADMIN_URL);

export async function createTestDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  if (!ADMIN_URL) throw new Error('CODEMEET_TEST_DATABASE_URL is not set');
  const name = `cm_test_${randomBytes(5).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  u.searchParams.set('sslmode', 'disable');
  return {
    url: u.toString(),
    async drop() {
      const a = new pg.Client({ connectionString: ADMIN_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}

export async function startTestServer(databaseUrl: string, env: Record<string, string> = {}): Promise<RunningServer> {
  const config = loadConfig({ DATABASE_URL: databaseUrl, CODEMEET_DB_SSL: 'disable', HOST: '127.0.0.1', PORT: '0', ...env });
  return startServer(config, { migrate: true, log: () => undefined });
}

export function tmpProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codemeet-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

export function readIn(dir: string, rel: string): string | null {
  const p = path.join(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

export interface Peer {
  name: string;
  dir: string;
  session: Session;
  sync: DocSync;
  workspace: NodeWorkspace;
  creds: StoredSession;
  logs: string[];
}

function wire(name: string, dir: string, session: Session, policy: SharingPolicy, creds: StoredSession): Peer {
  const workspace = new NodeWorkspace(dir, policy);
  const sync = new DocSync(session, workspace, policy);
  const logs: string[] = [];
  sync.on('log', (l) => logs.push(l));
  return { name, dir, session, sync, workspace, creds, logs };
}

export async function hostRoom(server: RunningServer, name: string, files: Record<string, string>, opts: { codeignore?: string } = {}): Promise<Peer & { roomId: string }> {
  const dir = tmpProject(files);
  const session = new Session(server.url);
  const creds = await session.create({ displayName: name, password: 'pw-secret', scope: 'workspace', codeignore: opts.codeignore });
  const peer = wire(name, dir, session, policyFromRoom(session.snapshot!.room), creds);
  await peer.sync.publishBaseline();
  return Object.assign(peer, { roomId: creds.roomId });
}

export async function joinRoom(
  server: RunningServer,
  host: Peer & { roomId: string },
  name: string,
  files: Record<string, string> = {},
  opts: { acceptBaseline?: boolean } = {},
): Promise<Peer> {
  const dir = tmpProject(files);
  const session = new Session(server.url);
  const joining = session.join({ roomId: host.roomId, password: 'pw-secret', displayName: name });
  const req = await waitFor(() => host.session.snapshot?.pending[0], 'join request at host');
  await host.session.call('room.decide', { requestId: req.id, accept: true });
  const creds = await joining;
  const peer = wire(name, dir, session, policyFromRoom(session.snapshot!.room), creds);
  const report = await peer.sync.pullBaseline(opts);
  (peer as Peer & { report?: unknown }).report = report;
  return peer;
}

export async function closePeer(p: Peer): Promise<void> {
  await p.sync.idle();
  p.sync.stop();
  p.session.dispose();
  cleanup(p.dir);
}
