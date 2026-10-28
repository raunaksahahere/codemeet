import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Responder, runAgent, type AgentHost } from '@codemeet/core';
import type { MessageView, Provider, ProposalView } from '@codemeet/shared';
import type { RunningServer } from '@codemeet/server';
import { closePeer, createTestDatabase, hasDb, hostRoom, joinRoom, readIn, startTestServer, waitFor, type Peer } from '../helpers.js';

const FAKE = path.resolve(__dirname, '../fixtures/fake-provider.mjs');

function hostFor(peer: Peer): AgentHost {
  return {
    projectRoot: peer.dir,
    runsDir: mkdtempSync(path.join(tmpdir(), 'cm-runs-')),
    room: async () => peer.session.snapshot!.room,
    ensureAgent: (p: Provider) => peer.session.call('agent.register', { provider: p }),
    call: (op, input) => peer.session.call(op, input),
  };
}

describe.runIf(hasDb)('agent proposals, attribution and approval', () => {
  let server: RunningServer;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let sam: Peer & { roomId: string };
  let ava: Peer;
  let bo: Peer;

  beforeAll(async () => {
    db = await createTestDatabase();
    server = await startTestServer(db.url);
    process.env.CODEMEET_CLAUDE_BIN = FAKE;
    process.env.CODEMEET_CODEX_BIN = FAKE;
    sam = await hostRoom(server, 'Sam', { 'src/app.ts': 'export const v = 1;\n', 'README.md': '# app\n' });
    ava = await joinRoom(server, sam, 'Ava');
    bo = await joinRoom(server, sam, 'Bo');
  });
  afterAll(async () => {
    delete process.env.CODEMEET_CLAUDE_BIN;
    delete process.env.CODEMEET_CODEX_BIN;
    for (const p of [sam, ava, bo]) await closePeer(p).catch(() => undefined);
    await server.close();
    await db.drop();
  });

  const collect = (peer: Peer) => {
    const seen: ProposalView[] = [];
    peer.session.on('evt', (e) => e.type === 'proposal' && seen.push(e.proposal));
    return seen;
  };

  it('publishes an isolated run as a proposal visible to others with the right owner/provider; nothing applies until approval, then exactly once', async () => {
    const seenByAva = collect(ava);
    process.env.FAKE_EDIT = 'src/app.ts::export const v = 2;\n|src/new.ts::export const n = 1;\n';
    const r = await runAgent(hostFor(sam), { provider: 'claude', task: 'bump v', timeoutMs: 20_000, allowShell: false, log: () => undefined });
    delete process.env.FAKE_EDIT;
    const p = r.proposal!;
    expect(p.agentLabel).toBe("Sam's Claude");
    expect(p.provider).toBe('claude');
    expect(p.changes.map((c) => `${c.op}:${c.path}`).sort()).toEqual(['create:src/new.ts', 'update:src/app.ts']);
    await waitFor(() => seenByAva.some((x) => x.id === p.id), "Ava sees Sam's Claude's proposal");
    expect(p.changes.find((c) => c.path === 'src/app.ts')!.diff).toContain('+export const v = 2;');

    // Isolation: the working tree is untouched while the proposal is pending.
    expect(readIn(sam.dir, 'src/app.ts')).toBe('export const v = 1;\n');
    expect(existsSync(path.join(sam.dir, 'src/new.ts'))).toBe(false);

    // Neither a bystander nor a non-owner may decide it.
    await expect(bo.session.call('proposal.decide', { proposalId: p.id, approve: true })).rejects.toThrow(/Only the room host or the agent owner/);

    // Concurrent approvals apply exactly once.
    const results = await Promise.allSettled([
      sam.session.call('proposal.decide', { proposalId: p.id, approve: true }),
      sam.session.call('proposal.decide', { proposalId: p.id, approve: true }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await waitFor(() => readIn(ava.dir, 'src/app.ts') === 'export const v = 2;\n' && readIn(bo.dir, 'src/new.ts') === 'export const n = 1;\n', 'applied everywhere');
    await waitFor(() => readIn(sam.dir, 'src/app.ts') === 'export const v = 2;\n', 'applied on the owner');
    expect(await server.hub.docs.text(sam.roomId, 'src/app.ts')).toBe('export const v = 2;\n'); // not doubled
    await expect(sam.session.call('proposal.decide', { proposalId: p.id, approve: true })).rejects.toThrow(/already applied/);
  });

  it('rejection never applies, and a proposal made on an outdated base fails safely as stale', async () => {
    const agent = await sam.session.call('agent.register', { provider: 'claude' });
    await sam.session.call('consent.grant', { permission: 'publish_proposals', agentId: agent.agentId, ttlMinutes: 30 });
    const manifest = await sam.session.call('doc.list', {});
    const readme = manifest.files.find((f) => f.path === 'README.md')!;
    const { proposal: rej } = await sam.session.call('proposal.upsert', { agentId: agent.agentId, runId: 'rej', title: 'to reject', changes: [{ path: 'README.md', op: 'update', baseHash: readme.hash, content: '# rejected\n' }] });
    await sam.session.call('proposal.decide', { proposalId: rej.id, approve: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(readIn(sam.dir, 'README.md')).toBe('# app\n');
    await expect(sam.session.call('proposal.decide', { proposalId: rej.id, approve: true })).rejects.toThrow(/already rejected/);

    const { proposal: stale } = await sam.session.call('proposal.upsert', { agentId: agent.agentId, runId: 'stale', title: 'will go stale', changes: [{ path: 'README.md', op: 'update', baseHash: readme.hash, content: '# agent version\n' }] });
    writeFileSync(path.join(ava.dir, 'README.md'), '# app\nhuman edit\n'); // a coworker changes the file meanwhile
    await ava.sync.localChanged('README.md');
    await waitFor(() => readIn(sam.dir, 'README.md') === '# app\nhuman edit\n', 'human edit synced');
    await expect(sam.session.call('proposal.decide', { proposalId: stale.id, approve: true })).rejects.toThrow(/stale/);
    expect((await sam.session.call('proposal.get', { proposalId: stale.id })).proposal.status).toBe('stale');
    expect(readIn(sam.dir, 'README.md')).toBe('# app\nhuman edit\n'); // newer code was not overwritten
  });

  it('rejects proposals for secrets or other paths the policy forbids, and requires publish consent', async () => {
    const agent = await ava.session.call('agent.register', { provider: 'codex' });
    const change = { path: 'src/x.ts', op: 'create' as const, baseHash: null, content: 'x' };
    await expect(ava.session.call('proposal.upsert', { agentId: agent.agentId, runId: 'nc', title: 't', changes: [change] })).rejects.toThrow(/may not publish proposals yet/);
    await ava.session.call('consent.grant', { permission: 'publish_proposals', agentId: agent.agentId, ttlMinutes: 10 });
    for (const bad of ['.env', '../escape.ts', 'keys/id_rsa', '.git/config']) {
      await expect(ava.session.call('proposal.upsert', { agentId: agent.agentId, runId: 'bad', title: 't', changes: [{ ...change, path: bad }] })).rejects.toThrow(/forbidden|unsafe|invalid|secret|never shared/i);
    }
  });

  it('derives the sender from the authenticated binding: nobody can act as another person\'s agent', async () => {
    const samClaude = await sam.session.call('agent.register', { provider: 'claude' });
    const avaCodex = await ava.session.call('agent.register', { provider: 'codex' });
    await expect(ava.session.call('proposal.upsert', { agentId: samClaude.agentId, runId: 'spoof', title: 't', changes: [{ path: 'a.ts', op: 'create', baseHash: null, content: 'x' }] })).rejects.toThrow(/belongs to another/);
    await expect(ava.session.call('msg.send', { fromAgentId: samClaude.agentId, toAgentId: avaCodex.agentId, clientMsgId: 'spoof-0001', body: 'hi' })).rejects.toThrow(/belongs to another/);
    await expect(ava.session.call('consent.grant', { permission: 'agent_message', agentId: samClaude.agentId, peerAgentId: avaCodex.agentId, ttlMinutes: 5 })).rejects.toThrow(/belongs to another/);
    // A host cannot grant on behalf of another user's agent either.
    await expect(sam.session.call('consent.grant', { permission: 'agent_message', agentId: avaCodex.agentId, peerAgentId: samClaude.agentId, ttlMinutes: 5 })).rejects.toThrow(/belongs to another/);
  });

  it('explains a missing provider executable and keeps human collaboration working', async () => {
    process.env.CODEMEET_CODEX_BIN = '/nonexistent/codex-binary';
    await expect(runAgent(hostFor(ava), { provider: 'codex', task: 't', timeoutMs: 5000, allowShell: false, log: () => undefined })).rejects.toThrow(/not found.*Human collaboration works without it/s);
    process.env.CODEMEET_CODEX_BIN = FAKE;
    writeFileSync(path.join(ava.dir, 'still-works.txt'), 'yes');
    await ava.sync.localChanged('still-works.txt');
    await waitFor(() => readIn(sam.dir, 'still-works.txt') === 'yes', 'human sync unaffected');
  });
});

describe.runIf(hasDb)('agent messaging consent and responders', () => {
  let server: RunningServer;
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let sam: Peer & { roomId: string };
  let ava: Peer;
  let bo: Peer;
  let samClaude: string;
  let avaCodex: string;
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'cm-marker-')), 'm.txt');
  const markerLines = () => (existsSync(marker) ? readFileSync(marker, 'utf8').split('\n').filter(Boolean) : []);

  beforeAll(async () => {
    db = await createTestDatabase();
    server = await startTestServer(db.url);
    process.env.CODEMEET_CLAUDE_BIN = FAKE;
    process.env.CODEMEET_CODEX_BIN = FAKE;
    process.env.FAKE_MARKER = marker;
    sam = await hostRoom(server, 'Sam', { 'a.txt': 'x' });
    ava = await joinRoom(server, sam, 'Ava');
    bo = await joinRoom(server, sam, 'Bo');
    samClaude = (await sam.session.call('agent.register', { provider: 'claude' })).agentId;
    avaCodex = (await ava.session.call('agent.register', { provider: 'codex' })).agentId;
  });
  afterAll(async () => {
    for (const k of ['CODEMEET_CLAUDE_BIN', 'CODEMEET_CODEX_BIN', 'FAKE_MARKER', 'FAKE_SLEEP_MS']) delete process.env[k];
    for (const p of [sam, ava, bo]) await closePeer(p).catch(() => undefined);
    await server.close();
    await db.drop();
  });

  /** Every test starts with no active consent, so no test depends on another's leftovers. */
  const resetGrants = async () => {
    for (const p of [sam, ava]) {
      for (const g of (await p.session.call('consent.list', {})).grants) {
        if (!g.revokedAt && g.grantorId === p.creds.memberId) await p.session.call('consent.revoke', { grantId: g.id });
      }
    }
  };
  beforeEach(resetGrants);

  const grantMsg = (p: Peer, agent: string, peer: string, params: Record<string, unknown> = {}) =>
    p.session.call('consent.grant', { permission: 'agent_message', agentId: agent, peerAgentId: peer, ttlMinutes: 30, params: params as never });
  const send = (p: Peer, from: string, to: string, body: string, extra: { threadId?: string; id?: string } = {}) =>
    p.session.call('msg.send', { fromAgentId: from, toAgentId: to, clientMsgId: extra.id ?? `cid-${Math.random().toString(36).slice(2, 12)}`, body, threadId: extra.threadId });

  it('is off by default and needs BOTH owners; sizes, dedupe, turns and visibility are enforced', async () => {
    await expect(send(sam, samClaude, avaCodex, 'hello')).rejects.toThrow(/has not granted/);
    const g1 = await grantMsg(sam, samClaude, avaCodex, { maxTurns: 2 });
    await expect(send(sam, samClaude, avaCodex, 'hello')).rejects.toThrow(/Ava has not granted/); // one-sided is still blocked
    await grantMsg(ava, avaCodex, samClaude, { maxTurns: 2 });
    const first = await send(sam, samClaude, avaCodex, 'hello', { id: 'dedupe-key-1' });
    expect(first.message.fromLabel).toBe("Sam's Claude");
    expect(first.message.toLabel).toBe("Ava's Codex");
    const dup = await send(sam, samClaude, avaCodex, 'hello', { id: 'dedupe-key-1' });
    expect(dup.deduplicated).toBe(true);
    expect(dup.message.id).toBe(first.message.id);
    await expect(send(sam, samClaude, avaCodex, 'x'.repeat(8001))).rejects.toThrow(/at most 8000/);
    // Thread turn limit (loop prevention): maxTurns=2.
    const t = first.message.threadId;
    await send(ava, avaCodex, samClaude, 'reply', { threadId: t });
    await expect(send(sam, samClaude, avaCodex, 'third', { threadId: t })).rejects.toThrow(/limit of 2 messages/);
    // Only the two owners see the history; Bo and the host's other agents do not.
    expect((await bo.session.call('msg.list', {})).messages).toHaveLength(0);
    expect((await ava.session.call('msg.list', {})).messages.length).toBeGreaterThanOrEqual(2);
    // Audit trail exists for blocked and permitted traffic.
    const audit = (await sam.session.call('activity.list', { limit: 100 })).entries.map((e) => e.kind);
    expect(audit).toEqual(expect.arrayContaining(['message-blocked', 'message-sent', 'consent-granted']));
    await sam.session.call('consent.revoke', { grantId: g1.grant.id });
  });

  it('revocation blocks queued messages, acks, new sends, and replays of the same message id', async () => {
    const g1 = await grantMsg(sam, samClaude, avaCodex);
    const g2 = await grantMsg(ava, avaCodex, samClaude);
    const queued = await send(sam, samClaude, avaCodex, 'queued before revoke', { id: 'replay-key-0001' });
    await ava.session.call('consent.revoke', { grantId: g2.grant.id });
    const afterRevoke = (await sam.session.call('msg.list', { threadId: queued.message.threadId })).messages[0]!;
    expect(afterRevoke.state).toBe('blocked');
    await expect(ava.session.call('msg.ack', { messageId: queued.message.id, state: 'delivered' })).rejects.toThrow(/consent|blocked/i);
    await expect(send(sam, samClaude, avaCodex, 'queued before revoke', { id: 'replay-key-0001' })).rejects.toThrow(/has not granted/); // replay != dedupe bypass
    // The recipient never sees blocked messages in history.
    expect((await ava.session.call('msg.list', { threadId: queued.message.threadId })).messages).toHaveLength(0);
    await sam.session.call('consent.revoke', { grantId: g1.grant.id });
  });

  it('expired grants stop working', async () => {
    const g1 = await grantMsg(sam, samClaude, avaCodex);
    await grantMsg(ava, avaCodex, samClaude);
    await send(sam, samClaude, avaCodex, 'works now');
    await server.db.query("UPDATE grants SET expires_at = now() - interval '1 second' WHERE id=$1", [g1.grant.id]);
    await expect(send(sam, samClaude, avaCodex, 'after expiry')).rejects.toThrow(/has not granted/);
  });

  it('review mode never invokes the provider until the owner approves; auto mode needs the explicit auto grant', async () => {
    const mk = (p: Peer, id: string) => new Responder({ session: p.session, agentIds: () => ({ codex: id }), log: () => undefined });
    await grantMsg(sam, samClaude, avaCodex);
    await grantMsg(ava, avaCodex, samClaude);
    const responder = mk(ava, avaCodex);
    await responder.start();
    try {
      const before = markerLines().length;
      await send(sam, samClaude, avaCodex, 'please review me');
      await waitFor(() => responder.inbox().some((i) => i.message.body === 'please review me'), 'message reaches the inbox');
      await new Promise((r) => setTimeout(r, 500));
      expect(markerLines().length).toBe(before); // provider NOT invoked in review mode
      const item = responder.inbox().find((i) => i.message.body === 'please review me')!;
      await expect(responder.act({ messageId: item.message.id, action: 'approve' })).resolves.toMatchObject({ state: 'blocked' }); // no invoke_provider grant yet
      expect(markerLines().length).toBe(before);

      await ava.session.call('consent.grant', { permission: 'invoke_provider', agentId: avaCodex, peerAgentId: samClaude, ttlMinutes: 30 });
      const m2 = await send(sam, samClaude, avaCodex, 'second');
      await waitFor(() => responder.inbox().some((i) => i.message.id === m2.message.id), 'second message');
      const item2 = responder.inbox().find((i) => i.message.id === m2.message.id)!;
      const done = await responder.act({ messageId: item2.message.id, action: 'approve' });
      expect(done!.state).toBe('replied');
      expect(markerLines().filter((l) => l === 'invoked:chat')).toHaveLength(1);
      const reply = (await sam.session.call('msg.list', { threadId: m2.message.threadId })).messages.find((m: MessageView) => m.fromAgentId === avaCodex);
      expect(reply?.body).toBe('STUB-REPLY');

      // Auto mode without the grant's auto flag must not run on its own.
      responder.configure({ provider: 'codex', mode: 'auto' });
      const before2 = markerLines().length;
      await send(sam, samClaude, avaCodex, 'auto without flag');
      await new Promise((r) => setTimeout(r, 700));
      expect(markerLines().length).toBe(before2);
    } finally {
      await responder.stop();
    }
  });

  it('revoking consent cancels a provider call that is already running and no reply is published', async () => {
    process.env.FAKE_SLEEP_MS = '6000';
    const inv = await ava.session.call('consent.grant', { permission: 'invoke_provider', agentId: avaCodex, peerAgentId: samClaude, ttlMinutes: 30, params: { auto: true } });
    const msgGrant = await grantMsg(ava, avaCodex, samClaude);
    await grantMsg(sam, samClaude, avaCodex);
    const responder = new Responder({ session: ava.session, agentIds: () => ({ codex: avaCodex }), log: () => undefined });
    await responder.start();
    responder.configure({ provider: 'codex', mode: 'auto' });
    try {
      const invokedBefore = markerLines().filter((l) => l === 'invoked:chat').length;
      const m = await send(sam, samClaude, avaCodex, 'long running question');
      await waitFor(() => markerLines().filter((l) => l === 'invoked:chat').length > invokedBefore, 'provider started');
      const startedFinished = markerLines().filter((l) => l === 'finished').length;
      await ava.session.call('consent.revoke', { grantId: msgGrant.grant.id });
      await waitFor(() => responder.inbox().find((i) => i.message.id === m.message.id)?.state === 'blocked', 'item blocked after revoke');
      await new Promise((r) => setTimeout(r, 1500));
      expect(markerLines().filter((l) => l === 'finished').length).toBe(startedFinished); // child was killed, never finished
      const thread = (await sam.session.call('msg.list', { threadId: m.message.threadId })).messages;
      expect(thread.filter((x) => x.fromAgentId === avaCodex)).toHaveLength(0); // no reply escaped
      await expect(send(sam, samClaude, avaCodex, 'replay after revoke', { threadId: m.message.threadId })).rejects.toThrow(/has not granted/);
    } finally {
      delete process.env.FAKE_SLEEP_MS;
      await responder.stop();
      void inv;
    }
  });

  it('bounded automatic conversation between two responders stops at the thread turn limit', async () => {
    // Fresh pair of agents to avoid state from earlier cases.
    const sc = samClaude;
    const ac = avaCodex;
    for (const [p, a, peer] of [[sam, sc, ac], [ava, ac, sc]] as const) {
      await grantMsg(p, a, peer, { maxTurns: 4 });
      await p.session.call('consent.grant', { permission: 'invoke_provider', agentId: a, peerAgentId: peer, ttlMinutes: 30, params: { auto: true, maxTurns: 4 } });
    }
    const rs = new Responder({ session: sam.session, agentIds: () => ({ claude: sc }), log: () => undefined });
    const ra = new Responder({ session: ava.session, agentIds: () => ({ codex: ac }), log: () => undefined });
    await rs.start();
    await ra.start();
    rs.configure({ provider: 'claude', mode: 'auto' });
    ra.configure({ provider: 'codex', mode: 'auto' });
    try {
      const first = await send(sam, sc, ac, 'start a bounded chat');
      await waitFor(async () => (await sam.session.call('msg.list', { threadId: first.message.threadId })).messages.length === 4, 'chat reaches the turn limit');
      await new Promise((r) => setTimeout(r, 1500));
      expect((await sam.session.call('msg.list', { threadId: first.message.threadId })).messages).toHaveLength(4); // and stays there
    } finally {
      await rs.stop();
      await ra.stop();
    }
  });
});
