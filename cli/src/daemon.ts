import { appendFileSync, rmSync } from 'node:fs';
import { DocSync, NodeWorkspace, Session, policyFromRoom, type SyncReport } from '@codemeet/core';
import { RpcError, type ActivityEntry, type RpcInput, type RpcOp } from '@codemeet/shared';
import { files, loadSession, saveSession, type SavedSession } from './home.js';
import { startIpcServer, type IpcServer } from './ipc.js';
import { FileStateStore } from './localState.js';
import { acquireLock, releaseLock } from './projectLock.js';
import { watchProject } from './watcher.js';
import { Responder } from './responder.js';

type Phase = 'starting' | 'bootstrapping' | 'blocked' | 'syncing' | 'offline' | 'closed' | 'error';

/** Operations that local tools (CLI commands, MCP server, agent runner) may forward to the server. */
const RPC_ALLOW = new Set<RpcOp>([
  'room.state', 'agent.register', 'doc.list', 'proposal.upsert', 'proposal.list', 'proposal.get', 'proposal.decide',
  'consent.grant', 'consent.revoke', 'consent.list', 'consent.check', 'msg.send', 'msg.list', 'msg.ack', 'activity.list', 'room.decide',
]);

/**
 * The long-lived owner of a CodeMeet session on this machine: server connection, file sync,
 * watcher, agent responder and the local control socket. Short-lived CLI commands talk to it.
 */
export async function runDaemon(): Promise<void> {
  const loaded = loadSession();
  if (!loaded) {
    console.error('codemeet daemon: no session.json; start with `codemeet room create|join`');
    process.exit(2);
  }
  const saved: SavedSession = loaded;
  const logLines: string[] = [];
  const log = (line: string) => {
    const l = `${new Date().toISOString()} ${line}`;
    logLines.push(l);
    if (logLines.length > 300) logLines.shift();
    try {
      appendFileSync(files.daemonLog(), l + '\n', { mode: 0o600 });
    } catch {
      /* log is best effort */
    }
  };

  const st: { phase: Phase; report: SyncReport | null; reason: string | null } = { phase: 'starting', report: null, reason: null };
  const activity: ActivityEntry[] = [];
  const session = new Session(saved.serverUrl);
  let ipc: IpcServer | null = null;
  let sync: DocSync | null = null;
  let watcher: { close(): Promise<void> } | null = null;
  let responder: Responder | null = null;
  let stopping = false;

  const stopAll = async (code = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log('daemon stopping');
    await responder?.stop().catch(() => undefined);
    await watcher?.close().catch(() => undefined);
    await sync?.flushState().catch(() => undefined);
    sync?.stop();
    session.dispose();
    releaseLock(saved.projectRoot, process.pid);
    await ipc?.close().catch(() => undefined);
    process.exit(code);
  };
  process.on('SIGINT', () => void stopAll(0));
  process.on('SIGTERM', () => void stopAll(0));
  process.on('uncaughtException', (e) => {
    log(`uncaught: ${e.stack ?? e.message}`);
    void stopAll(1);
  });

  try {
    acquireLock(saved.projectRoot, { pid: process.pid, kind: 'cli', roomId: saved.roomId });
  } catch (err) {
    log((err as Error).message);
    console.error((err as Error).message);
    process.exit(3);
  }

  const handler = async (method: string, params: unknown, ctx: { push: (e: unknown) => void; subscribe: () => void }): Promise<unknown> => {
    switch (method) {
      case 'ping':
        return 'pong';
      case 'status':
        return {
          phase: st.phase,
          reason: st.reason,
          report: st.report,
          server: saved.serverUrl,
          roomId: saved.roomId,
          role: saved.role,
          projectRoot: saved.projectRoot,
          me: session.snapshot?.me ?? saved.memberId,
          connection: session.state,
          room: session.snapshot?.room ?? null,
          participants: session.snapshot?.participants ?? [],
          pending: session.snapshot?.pending ?? [],
          files: sync?.trackedPaths.length ?? 0,
          agents: saved.agents,
          responder: responder?.status() ?? null,
          log: logLines.slice(-15),
        };
      case 'activity': {
        const limit = (params as { limit?: number } | undefined)?.limit ?? 30;
        return activity.slice(-limit);
      }
      case 'activity.follow':
        ctx.subscribe();
        return activity.slice(-20);
      case 'rpc': {
        const { op, input } = params as { op: RpcOp; input: unknown };
        if (!RPC_ALLOW.has(op)) throw new Error(`Operation ${op} is not available through the local daemon`);
        return await session.call(op, input as RpcInput<typeof op>);
      }
      case 'baseline.accept': {
        if (st.phase !== 'blocked') throw new Error('No baseline decision is pending');
        await bootstrap(true);
        return st.report;
      }
      case 'share': {
        const p = (params as { path: string }).path;
        await sync?.share(p);
        return { ok: true };
      }
      case 'agent.ensure': {
        const provider = (params as { provider: 'claude' | 'codex' }).provider;
        const r = await session.call('agent.register', { provider });
        saved.agents[provider] = r.agentId;
        saveSession(saved);
        return r;
      }
      case 'inbox.list':
        return responder?.inbox() ?? [];
      case 'inbox.act':
        return responder ? await responder.act(params as { messageId: string; action: 'approve' | 'dismiss' }) : null;
      case 'responder.set':
        return responder?.configure(params as { provider: 'claude' | 'codex'; mode: 'off' | 'review' | 'auto' }) ?? null;
      case 'shutdown': {
        const { closeRoom, leaveRoom } = (params ?? {}) as { closeRoom?: boolean; leaveRoom?: boolean };
        try {
          if (closeRoom && saved.role === 'host') await session.call('room.close', {});
          else if (leaveRoom && saved.role === 'guest') await session.call('room.leave', {});
        } catch (err) {
          log(`leave failed: ${(err as Error).message}`);
        }
        setTimeout(() => void stopAll(0), 50);
        return { ok: true };
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  };

  ipc = await startIpcServer(handler);

  // ── connect with retry ──
  for (let attempt = 0; ; attempt++) {
    try {
      await session.resume(saved);
      break;
    } catch (err) {
      const e = err as RpcError;
      if (e.code === 'unauthorized' || e.code === 'expired' || e.code === 'not_found') {
        st.phase = 'closed';
        st.reason = e.message;
        log(`session cannot be resumed: ${e.message}`);
        return; // stay alive so `codemeet status` can explain; `codemeet leave` cleans up
      }
      log(`connect attempt ${attempt + 1} failed: ${e.message}`);
      st.phase = 'offline';
      st.reason = e.message;
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
      if (stopping) return;
    }
  }

  const policy = policyFromRoom(session.snapshot!.room);
  const workspace = new NodeWorkspace(saved.projectRoot, policy);
  const store = new FileStateStore(saved.projectRoot, saved.roomId);
  sync = new DocSync(session, workspace, policy, store);
  sync.on('log', log);
  sync.on('remoteChange', (c) => log(`remote ${c.kind}: ${c.path}`));
  sync.on('skipped', (s) => log(`skipped ${s.path}: ${s.reason}`));

  session.on('evt', (e) => {
    if (e.type === 'activity') {
      activity.push(e.entry);
      if (activity.length > 500) activity.shift();
      ipc?.broadcast(e.entry);
    } else if (e.type === 'room-closed') {
      st.phase = 'closed';
      st.reason = e.reason;
      log(`room closed: ${e.reason}`);
    }
  });
  session.on('state', (s, detail) => {
    if (s === 'offline') {
      st.phase = 'offline';
      st.reason = detail ?? null;
      log(`connection lost (${detail}); will resume automatically`);
    } else if (s === 'online' && st.phase === 'offline') {
      st.phase = 'syncing';
      st.reason = null;
      log('reconnected');
    } else if (s === 'closed') {
      st.phase = 'closed';
      st.reason = detail ?? 'session closed';
    }
  });

  const recent = await session.call('activity.list', { limit: 50 }).catch(() => ({ entries: [] as ActivityEntry[] }));
  activity.push(...recent.entries);

  async function bootstrap(accept: boolean): Promise<void> {
    st.phase = 'bootstrapping';
    try {
      if (!saved.bootstrapped) {
        const report = saved.role === 'host' ? await sync!.publishBaseline() : await sync!.pullBaseline({ acceptBaseline: accept || saved.acceptBaseline });
        st.report = report;
        if (report.conflicts.length && !(accept || saved.acceptBaseline)) {
          st.phase = 'blocked';
          st.reason = `${report.conflicts.length} local file(s) differ from the shared baseline`;
          log(`blocked: ${st.reason}`);
          return;
        }
        saved.bootstrapped = true;
        saved.acceptBaseline = false;
        saveSession(saved);
      } else {
        const n = await sync!.restore();
        await sync!.resync();
        await sync!.reconcileAll();
        log(`resumed ${n} documents from local state`);
      }
      watcher = watchProject(saved.projectRoot, policy, sync!, (e) => log(`watcher error: ${e.message}`));
      responder = new Responder({ session, saved, log, projectRoot: saved.projectRoot, onChange: () => undefined });
      await responder.start();
      st.phase = 'syncing';
      st.reason = null;
      await sync!.flushState();
      log(`syncing ${sync!.trackedPaths.length} files`);
    } catch (err) {
      st.phase = 'error';
      st.reason = (err as Error).message;
      log(`bootstrap failed: ${st.reason}`);
    }
  }

  await bootstrap(false);
  // Keep the process alive; the IPC server and sockets hold the event loop open.
  void rmSync;
}
