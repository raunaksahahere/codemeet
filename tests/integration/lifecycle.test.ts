import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { ConfigError, Db, loadConfig, startServer, validateDatabaseUrl, type RunningServer } from '@codemeet/server';
import { Session } from '@codemeet/core';
import type { ServerEvent } from '@codemeet/shared';
import { ADMIN_URL, closePeer, createTestDatabase, freePort, hasDb, hostRoom, joinRoom, readIn, startTestServer, waitFor, type Peer } from '../helpers.js';

describe('configuration validation (no database needed)', () => {
  it('explains a missing DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is not set.*codemeet init/s);
  });
  it('rejects things that are not a Postgres connection string, such as a Supabase API key', () => {
    expect(() => validateDatabaseUrl('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def')).toThrow(/anon\/service-role key/);
    expect(() => validateDatabaseUrl('https://xyz.supabase.co')).toThrow(/postgresql:\/\//);
    expect(() => validateDatabaseUrl('postgresql://u:p@host.neon.tech/db?sslmode=require')).not.toThrow();
  });
});

describe.runIf(hasDb)('database lifecycle', () => {
  it('migrates a fresh database to a ready backend, and refuses to start on a stale schema', async () => {
    const db = await createTestDatabase();
    try {
      const config = loadConfig({ DATABASE_URL: db.url, PORT: '0', HOST: '127.0.0.1' });
      await expect(startServer(config, { log: () => undefined })).rejects.toThrow(/schema is behind.*codemeet db migrate/s);
      const server = await startServer(config, { migrate: true, log: () => undefined });
      const ready = await fetch(`${server.url}/readyz`);
      expect(ready.status).toBe(200);
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
      const tables = await server.db.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public'");
      expect(tables.rows.map((t) => t.tablename)).toEqual(expect.arrayContaining(['rooms', 'members', 'docs', 'proposals', 'grants', 'messages', 'audit_events', 'schema_migrations']));
      await server.close();
    } finally {
      await db.drop();
    }
  });

  it('reports an unreachable or misauthenticated database with redacted, actionable errors and does not start', async () => {
    const admin = new URL(ADMIN_URL as string);
    const wrongPw = new URL(admin.toString());
    wrongPw.password = 'Sup3rS3cretWrongPw';
    const cfg = loadConfig({ DATABASE_URL: wrongPw.toString(), PORT: '0', HOST: '127.0.0.1', CODEMEET_DB_SSL: 'disable' });
    const err = await startServer(cfg, { log: () => undefined }).then(() => null, (e: Error) => e);
    expect(err).toBeTruthy();
    expect(err!.message).not.toContain('Sup3rS3cretWrongPw');
    expect(err!.message).toMatch(/authentication failed|password/i);

    const down = new URL(admin.toString());
    down.port = '1';
    down.password = 'AnotherSecretPw9';
    const err2 = await startServer(loadConfig({ DATABASE_URL: down.toString(), PORT: '0', HOST: '127.0.0.1', CODEMEET_DB_SSL: 'disable', CODEMEET_DB_CONNECT_TIMEOUT_MS: '1500' }), { log: () => undefined }).then(() => null, (e: Error) => e);
    expect(err2!.message).not.toContain('AnotherSecretPw9');
    expect(err2!.message).toMatch(/refused|connect|timeout/i);
  });

  it('degrades gracefully when the database goes away: not-ready and per-call errors, no crash', async () => {
    const db = await createTestDatabase();
    const server = await startTestServer(db.url);
    const host = await hostRoom(server, 'Sam', { 'a.txt': 'x' });
    try {
      await server.db.close();
      expect((await fetch(`${server.url}/readyz`)).status).toBe(503);
      await expect(host.session.call('proposal.list', {})).rejects.toThrow(/unavailable|closed|Database/i);
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200); // process is alive
    } finally {
      host.session.dispose();
      await server.close();
      await db.drop();
    }
  });
});

describe.runIf(hasDb)('durability, expiry and reconnect', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  const open: Peer[] = [];
  const servers: RunningServer[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    for (const p of open) await closePeer(p).catch(() => undefined);
    for (const s of servers) await s.close().catch(() => undefined);
    await db.drop();
  });

  it('durable records survive a server restart while stale presence does not', async () => {
    const port = String(await freePort());
    const a = await startTestServer(db.url, { PORT: port });
    const host = await hostRoom(a, 'Sam', { 'keep.txt': 'durable\n' });
    const guest = await joinRoom(a, host, 'Ava');
    // A durable agent identity and a published proposal.
    const agent = await host.session.call('agent.register', { provider: 'claude' });
    await host.session.call('consent.grant', { permission: 'publish_proposals', agentId: agent.agentId, ttlMinutes: 30 });
    const hash = (await host.session.call('doc.list', {})).files[0]!.hash;
    const { proposal } = await host.session.call('proposal.upsert', { agentId: agent.agentId, runId: 'r1', title: 'survive', changes: [{ path: 'keep.txt', op: 'update', baseHash: hash, content: 'changed\n' }] });
    await host.sync.idle();
    host.session.dispose();
    guest.session.dispose();
    await a.close();

    const b = await startTestServer(db.url, { PORT: port });
    servers.push(b);
    const again = new Session(b.url);
    await again.resume(host.creds);
    const snap = again.snapshot!;
    expect(snap.participants.find((p) => p.id === guest.creds.memberId)?.online).toBe(false); // no stale presence
    expect(snap.participants.find((p) => p.id === host.creds.memberId)?.online).toBe(true);
    expect(snap.participants.map((p) => p.label)).toEqual(expect.arrayContaining(["Sam's Claude", 'Ava']));
    expect((await again.call('doc.list', {})).files.map((f) => f.path)).toEqual(['keep.txt']);
    expect((await again.call('proposal.get', { proposalId: proposal.id })).proposal.status).toBe('pending');
    expect((await again.call('consent.list', {})).grants.some((g) => g.permission === 'publish_proposals')).toBe(true);
    again.dispose();
    await b.close();
    servers.pop();
  });

  it('expiry notifies and evicts every connected member, and a closed room cannot be resumed or joined', async () => {
    const server = await startTestServer(db.url);
    servers.push(server);
    const host = await hostRoom(server, 'Sam', { 'a.txt': '1' });
    const guest = await joinRoom(server, host, 'Ava');
    open.push(host, guest);
    const closed: string[] = [];
    for (const p of [host, guest]) p.session.on('evt', (e: ServerEvent) => e.type === 'room-closed' && closed.push(p.name));
    await server.hub.forceExpire(host.roomId);
    await waitFor(() => closed.length === 2, 'both members told the room closed');
    expect(host.session.state).toBe('closed');
    expect(guest.session.state).toBe('closed');
    await expect(host.session.call('doc.list', {})).rejects.toThrow(/closed/);
    const late = new Session(server.url);
    await expect(late.resume(host.creds)).rejects.toThrow(/closed|expired/);
    await expect(late.join({ roomId: host.roomId, password: 'pw-secret', displayName: 'Z' })).rejects.toThrow(/closed|expired/);
    late.dispose();
    const row = await server.db.query<{ status: string }>('SELECT status FROM rooms WHERE id=$1', [host.roomId]);
    expect(row.rows[0]!.status).toBe('closed');
    await server.close();
    servers.pop();
  });

  it('survives a server outage: both sides keep editing offline, reconnect by token, and converge without loss or duplication', async () => {
    const port = String(await freePort());
    const a = await startTestServer(db.url, { PORT: port });
    const base = 'one\ntwo\nthree\n';
    const host = await hostRoom(a, 'Sam', { 'doc.txt': base });
    const guest = await joinRoom(a, host, 'Ava');
    open.push(host, guest);
    expect(readIn(guest.dir, 'doc.txt')).toBe(base);

    await a.close(); // outage
    await waitFor(() => host.session.state === 'offline' && guest.session.state === 'offline', 'clients notice the outage');
    writeFileSync(path.join(host.dir, 'doc.txt'), 'ONE\ntwo\nthree\n');
    writeFileSync(path.join(guest.dir, 'doc.txt'), 'one\ntwo\nTHREE\n');
    writeFileSync(path.join(guest.dir, 'offline-new.txt'), 'made offline');
    await Promise.all([host.sync.localChanged('doc.txt'), guest.sync.localChanged('doc.txt')]);
    await guest.sync.localChanged('offline-new.txt');

    const b = await startTestServer(db.url, { PORT: port }); // same port, same database
    servers.push(b);
    await waitFor(() => host.session.state === 'online' && guest.session.state === 'online', 'automatic resume', 15_000);
    const merged = 'ONE\ntwo\nTHREE\n';
    await waitFor(() => readIn(host.dir, 'doc.txt') === merged && readIn(guest.dir, 'doc.txt') === merged, 'convergence after reconnect', 15_000);
    await waitFor(() => readIn(host.dir, 'offline-new.txt') === 'made offline', 'file created offline arrives', 15_000);
    await host.sync.idle();
    await guest.sync.idle();
    expect((await b.hub.docs.text(host.roomId, 'doc.txt'))).toBe(merged);
    await b.close();
    servers.pop();
  });

  it('repeated joins and leaves do not multiply listeners or duplicate edits, and edits are not echoed', async () => {
    const server = await startTestServer(db.url);
    servers.push(server);
    const host = await hostRoom(server, 'Sam', { 'e.txt': 'start\n' });
    const watcher = await joinRoom(server, host, 'Wes');
    open.push(host, watcher);
    const before = { evt: host.session.listenerCount('evt'), auth: host.session.listenerCount('authenticated') };
    for (let i = 0; i < 4; i++) {
      const p = await joinRoom(server, host, `Guest${i}`);
      await host.sync.publishBaseline(); // re-running bootstrap must be idempotent
      await p.session.call('room.leave', {});
      await closePeer(p);
    }
    expect({ evt: host.session.listenerCount('evt'), auth: host.session.listenerCount('authenticated') }).toEqual(before);

    const seen: ServerEvent[] = [];
    watcher.session.on('evt', (e) => e.type === 'doc-update' && seen.push(e));
    writeFileSync(path.join(host.dir, 'e.txt'), 'start\nedit\n');
    await host.sync.localChanged('e.txt');
    await waitFor(() => readIn(watcher.dir, 'e.txt') === 'start\nedit\n', 'edit arrives');
    await new Promise((r) => setTimeout(r, 600)); // a feedback loop would show up as extra events
    expect(seen).toHaveLength(1);
    expect(readIn(watcher.dir, 'e.txt')).toBe('start\nedit\n'); // no duplicated text
    await server.close();
    servers.pop();
  });
});

describe.runIf(hasDb)('server hardening', () => {
  it('rejects oversized updates, unknown operations, and bursts beyond the per-socket budget', async () => {
    const db = await createTestDatabase();
    const server = await startTestServer(db.url);
    const host = await hostRoom(server, 'Sam', { 'a.txt': 'x' });
    try {
      await expect(host.session.call('doc.update', { path: 'a.txt', update: new Uint8Array(2_500_000) })).rejects.toThrow(/too large/i);
      await expect(host.session.call('doc.update', { path: 'a.txt', update: new Uint8Array([1, 2, 3, 4]) })).rejects.toThrow(/Malformed|invalid/i);
      await expect(host.session.call('nope.op' as never, {} as never)).rejects.toThrow(/Unknown operation/);
      const results = await Promise.allSettled(Array.from({ length: 700 }, () => host.session.call('room.state', {})));
      expect(results.some((r) => r.status === 'rejected' && /slow down|rate/i.test(String((r as PromiseRejectedResult).reason)))).toBe(true);
    } finally {
      host.session.dispose();
      await server.close();
      await db.drop();
    }
  });

  it('locks out repeated bad passwords for a room', async () => {
    const db = await createTestDatabase();
    const server = await startTestServer(db.url);
    const host = await hostRoom(server, 'Sam', { 'a.txt': 'x' });
    try {
      let last = '';
      for (let i = 0; i < 12; i++) {
        const s = new Session(server.url);
        await s.join({ roomId: host.roomId, password: `wrong-${i}`, displayName: 'Mal' }).catch((e: Error) => (last = e.message));
        s.dispose();
      }
      expect(last).toMatch(/Too many failed attempts/);
      const good = new Session(server.url);
      await expect(good.join({ roomId: host.roomId, password: 'pw-secret', displayName: 'Mal' }, { signal: AbortSignal.timeout(500) })).rejects.toThrow(/Too many failed|Join cancelled/);
      good.dispose();
    } finally {
      host.session.dispose();
      await server.close();
      await db.drop();
    }
  });
});

void Db;
void ConfigError;
void pg;
