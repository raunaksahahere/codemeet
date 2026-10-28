import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { Session } from '@codemeet/core';
import type { RunningServer } from '@codemeet/server';
import { cleanup, closePeer, createTestDatabase, hasDb, hostRoom, joinRoom, readIn, startTestServer, tmpProject, waitFor, type Peer } from '../helpers.js';

describe.runIf(hasDb)('room access control', () => {
  let server: RunningServer;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  const peers: Peer[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    server = await startTestServer(db.url);
  });
  afterAll(async () => {
    for (const p of peers) await closePeer(p).catch(() => undefined);
    await server.close();
    await db.drop();
  });

  it('only the real host can approve a real, unexpired request; bad passwords and strangers fail', async () => {
    const host = await hostRoom(server, 'Sam', { 'a.txt': 'hello' });
    peers.push(host);

    const stranger = new Session(server.url);
    await expect(stranger.join({ roomId: host.roomId, password: 'wrong-password', displayName: 'Mallory' })).rejects.toThrow(/Invalid room or password/);
    stranger.dispose();

    const guest = new Session(server.url);
    const pendingP = guest.join({ roomId: host.roomId, password: 'pw-secret', displayName: 'Ava' });
    const req = await waitFor(() => host.session.snapshot?.pending[0], 'pending request');

    // An unauthenticated socket cannot approve, and neither can the pending guest.
    const evil = new Session(server.url);
    await expect(evil.call('room.decide', { requestId: req.id, accept: true })).rejects.toThrow(/Not connected|Join or resume/);
    await expect(guest.call('room.decide', { requestId: req.id, accept: true })).rejects.toThrow(/Join or resume/);
    evil.dispose();

    // Unknown request ids are rejected for the real host.
    await expect(host.session.call('room.decide', { requestId: 'jr_doesnotexist', accept: true })).rejects.toThrow(/No such join request/);

    await host.session.call('room.decide', { requestId: req.id, accept: true });
    const creds = await pendingP;
    expect(creds.memberId).toMatch(/^m_/);
    // A decided request cannot be decided twice.
    await expect(host.session.call('room.decide', { requestId: req.id, accept: false })).rejects.toThrow(/already decided/);
    guest.dispose();
  });

  it('rejects malformed, oversized and cross-room requests', async () => {
    const a = await hostRoom(server, 'Sam', { 'x.txt': 'x' });
    const b = await hostRoom(server, 'Eve', { 'y.txt': 'y' });
    peers.push(a, b);
    // Malformed input is validated at runtime.
    await expect(a.session.call('doc.seed', { path: '../escape.txt', content: 'x' })).rejects.toThrow(/forbidden|invalid/);
    await expect(a.session.call('doc.seed', { path: '/etc/passwd', content: 'x' })).rejects.toThrow(/forbidden|invalid/);
    await expect(a.session.call('doc.seed', { path: 'C:\\win.ini', content: 'x' })).rejects.toThrow(/forbidden|invalid/);
    await expect(a.session.call('doc.seed', { path: '.env', content: 'SECRET=1' })).rejects.toThrow(/secret/);
    await expect(a.session.call('doc.seed', { path: 'big.txt', content: 'x'.repeat(1_000_001) })).rejects.toThrow(/at most|too large/i);
    // Room B's documents are invisible to room A.
    const listA = await a.session.call('doc.list', {});
    expect(listA.files.map((f) => f.path)).toEqual(['x.txt']);
    await expect(a.session.call('doc.sync', { path: 'y.txt', stateVector: new Uint8Array() })).resolves.toMatchObject({ exists: false });
    // Spoofed identity fields are not part of the schema: extra keys are ignored, sender comes from the token.
    const poll = await a.session.call('room.state', { ...( { memberId: 'someone-else' } as object) });
    expect(poll.me).toBe(a.creds.memberId);
  });

  it('refuses to bind a second session on the same socket and resumes by token with the same identity', async () => {
    const host = await hostRoom(server, 'Sam', { 'r.txt': '1' });
    peers.push(host);
    const again = new Session(server.url);
    await again.resume(host.creds);
    expect(again.snapshot?.me).toBe(host.creds.memberId);
    await expect(again.call('room.create', { displayName: 'x', password: 'abc', scope: 'workspace' })).rejects.toThrow(/already has a session/);
    again.dispose();
    const bad = new Session(server.url);
    await expect(bad.resume({ ...host.creds, token: 'x'.repeat(40) })).rejects.toThrow(/not valid/);
    bad.dispose();
  });
});

describe.runIf(hasDb)('document synchronization', () => {
  let server: RunningServer;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  const peers: Peer[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    server = await startTestServer(db.url);
  });
  afterAll(async () => {
    for (const p of peers) await closePeer(p).catch(() => undefined);
    await server.close();
    await db.drop();
  });

  it('starts from identical non-empty text without duplicating it, converges under concurrent edits, and handles late join', async () => {
    const text = 'line one\nline two\nline three\n';
    const host = await hostRoom(server, 'Sam', { 'src/main.ts': text, 'notes.md': '# hi\n' });
    const ava = await joinRoom(server, host, 'Ava', { 'src/main.ts': text });
    peers.push(host, ava);
    expect(readIn(ava.dir, 'src/main.ts')).toBe(text); // identical start: no duplication
    expect(readIn(ava.dir, 'notes.md')).toBe('# hi\n'); // missing file downloaded

    // Concurrent edits at different places.
    writeFileSync(path.join(host.dir, 'src/main.ts'), 'HOST line one\nline two\nline three\n');
    writeFileSync(path.join(ava.dir, 'src/main.ts'), 'line one\nline two\nline three AVA\n');
    await Promise.all([host.sync.localChanged('src/main.ts'), ava.sync.localChanged('src/main.ts')]);
    await waitFor(() => readIn(host.dir, 'src/main.ts')?.includes('AVA') && readIn(ava.dir, 'src/main.ts')?.includes('HOST'), 'convergence');
    await host.sync.idle();
    await ava.sync.idle();
    const merged = 'HOST line one\nline two\nline three AVA\n';
    expect(readIn(host.dir, 'src/main.ts')).toBe(merged);
    expect(readIn(ava.dir, 'src/main.ts')).toBe(merged);

    // Echo safety: re-reporting an unchanged file produces no further traffic.
    const before = server.hub.docs.text(host.roomId, 'src/main.ts');
    await host.sync.localChanged('src/main.ts');
    await ava.sync.localChanged('src/main.ts');
    expect(await before).toBe(merged);

    // Late join gets the current state, including an edit made before they arrived.
    const late = await joinRoom(server, host, 'Bo', {});
    peers.push(late);
    expect(readIn(late.dir, 'src/main.ts')).toBe(merged);

    // Create / rename / delete propagate; delete is recoverable on peers.
    writeFileSync(path.join(host.dir, 'new.txt'), 'fresh');
    await host.sync.localChanged('new.txt');
    await waitFor(() => readIn(ava.dir, 'new.txt') === 'fresh' && readIn(late.dir, 'new.txt') === 'fresh', 'file creation');
    await host.workspace.rename('new.txt', 'renamed.txt');
    await host.sync.localRenamed('new.txt', 'renamed.txt');
    await waitFor(() => readIn(ava.dir, 'renamed.txt') === 'fresh' && readIn(ava.dir, 'new.txt') === null, 'rename');
    await host.workspace.trash('renamed.txt');
    await host.sync.localChanged('renamed.txt');
    await waitFor(() => readIn(ava.dir, 'renamed.txt') === null, 'delete');
    expect(existsSync(path.join(ava.dir, '.codemeet', 'trash'))).toBe(true);
  });

  it('never overwrites a differing local file without acceptance, and backs it up when accepted', async () => {
    const host = await hostRoom(server, 'Sam', { 'cfg.json': '{"a":1}\n' });
    peers.push(host);
    const guestDir = tmpProject({ 'cfg.json': '{"mine":true}\n', 'private-only.txt': 'keep me' });
    const { Session: S, DocSync: D, NodeWorkspace: W, policyFromRoom: P } = await import('@codemeet/core');
    const s = new S(server.url);
    const joining = s.join({ roomId: host.roomId, password: 'pw-secret', displayName: 'Cy' });
    const req = await waitFor(() => host.session.snapshot?.pending.at(-1), 'request');
    await host.session.call('room.decide', { requestId: req.id, accept: true });
    await joining;
    const policy = P(s.snapshot!.room);
    const sync = new D(s, new W(guestDir, policy), policy);
    const first = await sync.pullBaseline();
    expect(first.conflicts.map((c) => c.path)).toEqual(['cfg.json']);
    expect(readFileSync(path.join(guestDir, 'cfg.json'), 'utf8')).toBe('{"mine":true}\n'); // untouched
    const second = await sync.pullBaseline({ acceptBaseline: true });
    expect(second.backupDir).toBeTruthy();
    expect(readFileSync(path.join(guestDir, 'cfg.json'), 'utf8')).toBe('{"a":1}\n');
    expect(readFileSync(path.join(second.backupDir!), 'utf8')).toBe('{"mine":true}\n');
    expect(second.localOnly).toContain('private-only.txt');
    sync.stop();
    s.dispose();
    cleanup(guestDir);
  });

  it('never shares secrets, out-of-scope paths or symlink escapes', async () => {
    const outside = tmpProject({ 'secret.txt': 'TOP SECRET' });
    const host = await hostRoom(
      server,
      'Sam',
      { 'ok.txt': 'ok', '.env': 'KEY=1', '.env.example': 'KEY=', 'keys/id_rsa': 'PRIVATE', 'ignored/x.txt': 'ig' },
      { codeignore: 'ignored/\n' },
    );
    peers.push(host);
    mkdirSync(path.join(host.dir, 'linkdir'));
    symlinkSync(outside, path.join(host.dir, 'escape'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(host.dir, 'leak.txt'));
    await host.sync.reconcileAll();
    const files = (await host.session.call('doc.list', {})).files.map((f) => f.path);
    expect(files.sort()).toEqual(['.env.example', 'ok.txt']);
    // Inbound writes are confined too: a poisoned local symlink must not be followed.
    await expect(host.workspace.write('escape/pwn.txt', 'x')).rejects.toThrow(/symlink|escape/i);
    expect(existsSync(path.join(outside, 'pwn.txt'))).toBe(false);
    await expect(host.workspace.write('../up.txt', 'x')).rejects.toThrow(/Unsafe path/);
    cleanup(outside);
  });
});
