import { promises as fs, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { SharingPolicy, sha256, type ProposalView, type Provider, type RoomInfo, type RpcInput, type RpcOp, type RpcResults } from '@codemeet/shared';
import { requireProvider, runProvider } from './providers.js';
import { NodeWorkspace } from './workspace.js';

/** What an agent run needs from whoever owns the session (the CLI daemon or the VS Code extension). */
export interface AgentHost {
  projectRoot: string;
  /** Private directory for isolated run snapshots. */
  runsDir: string;
  /** Throws a user-readable error unless the session is synced and ready. */
  room(): Promise<RoomInfo>;
  ensureAgent(provider: Provider): Promise<{ agentId: string; label: string }>;
  call<K extends RpcOp>(op: K, input: RpcInput<K>): Promise<RpcResults[K]>;
}

export interface AgentRunOptions {
  provider: Provider;
  task: string;
  timeoutMs: number;
  allowShell: boolean;
  budgetUsd?: number;
  keep?: boolean;
  signal?: AbortSignal;
  log: (line: string) => void;
}

type Change = RpcInput<'proposal.upsert'>['changes'][number];

/** Copies the shareable files into an isolated directory and remembers each file's base hash. */
async function snapshot(src: NodeWorkspace, dest: string): Promise<Map<string, string>> {
  const base = new Map<string, string>();
  const { files: list } = await src.list();
  for (const rel of list) {
    const r = await src.read(rel);
    if (r.kind !== 'text') continue;
    const abs = path.join(dest, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, r.text, 'utf8');
    base.set(rel, sha256(r.text));
  }
  return base;
}

async function diffSnapshot(snap: NodeWorkspace, base: Map<string, string>): Promise<Change[]> {
  const changes: Change[] = [];
  const { files: now } = await snap.list();
  const seen = new Set<string>();
  for (const rel of now) {
    const r = await snap.read(rel);
    if (r.kind !== 'text') continue;
    seen.add(rel);
    const baseHash = base.get(rel);
    if (baseHash === undefined) changes.push({ path: rel, op: 'create', baseHash: null, content: r.text });
    else if (sha256(r.text) !== baseHash) changes.push({ path: rel, op: 'update', baseHash, content: r.text });
  }
  for (const [rel, h] of base) if (!seen.has(rel)) changes.push({ path: rel, op: 'delete', baseHash: h });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Runs Claude Code or Codex against an isolated snapshot of the project and publishes what it
 * changes as a reviewable proposal. The user's working tree is never touched: the only way
 * the agent's work reaches it is an approved proposal applied through the shared server state.
 */
export async function runAgent(host: AgentHost, o: AgentRunOptions): Promise<{ proposal: ProposalView | null; text: string }> {
  const info = await requireProvider(o.provider);
  o.log(`using ${info.binary} ${info.version ?? ''}`.trim());
  const room = await host.room();

  const agent = await host.ensureAgent(o.provider);
  const runId = `run_${randomBytes(6).toString('base64url')}`;
  // Starting a managed run is the explicit act that lets this agent publish proposals for its duration.
  await host.call('consent.grant', { permission: 'publish_proposals', agentId: agent.agentId, ttlMinutes: Math.ceil(o.timeoutMs / 60_000) + 10 });

  const policy = new SharingPolicy({ scope: room.scope, scopePath: room.scopePath ?? undefined, codeignore: room.codeignore });
  const live = new NodeWorkspace(host.projectRoot, policy);
  const runDir = path.join(host.runsDir, runId);
  const snapDir = path.join(runDir, 'workspace');
  mkdirSync(snapDir, { recursive: true, mode: 0o700 });
  const base = await snapshot(live, snapDir);
  const snap = new NodeWorkspace(snapDir, policy);
  o.log(`${agent.label}: working in an isolated snapshot of ${base.size} files (your working tree is untouched)`);

  let lastKey = '';
  let proposal: ProposalView | null = null;
  const publish = async (final: boolean): Promise<void> => {
    const changes = await diffSnapshot(snap, base);
    if (!changes.length) return;
    const key = sha256(JSON.stringify(changes.map((c) => [c.path, c.op, c.content ? sha256(c.content) : null])));
    if (key === lastKey && !final) return;
    lastKey = key;
    const res = await host.call('proposal.upsert', {
      agentId: agent.agentId,
      runId,
      title: o.task.slice(0, 120),
      summary: final ? 'Final result of the run.' : 'Work in progress; this proposal updates while the agent works.',
      changes,
    });
    proposal = res.proposal;
    o.log(`published proposal ${res.proposal.id} (revision ${res.proposal.revision}, ${changes.length} file(s))`);
  };

  const prompt =
    `You are ${agent.label}, an AI coding assistant working inside an isolated copy of a shared project. ` +
    `Make the requested change by editing files in the current directory. Do not touch files outside it. ` +
    `A teammate will review your changes as a diff before anything is applied.\n\nTask: ${o.task}`;
  const tick = setInterval(() => void publish(false).catch((e) => o.log(`progress publish failed: ${(e as Error).message}`)), 3000);
  const abort = new AbortController();
  const onSig = () => abort.abort();
  process.once('SIGINT', onSig);
  o.signal?.addEventListener('abort', onSig);
  try {
    const res = await runProvider({
      provider: o.provider,
      cwd: snapDir,
      prompt,
      mode: 'edit',
      timeoutMs: o.timeoutMs,
      allowShell: o.allowShell,
      maxBudgetUsd: o.budgetUsd,
      signal: abort.signal,
      env: { CODEMEET_AGENT: o.provider, CODEMEET_RUN_ID: runId },
      onEvent: (s) => o.log(s),
    });
    clearInterval(tick);
    if (res.timedOut) o.log('the run hit its time limit; publishing whatever was produced');
    if (res.aborted) o.log('the run was cancelled; publishing whatever was produced');
    if (res.exitCode !== 0 && !res.timedOut && !res.aborted) o.log(`provider exited with ${res.exitCode}: ${res.stderrTail.slice(-300)}`);
    await publish(true);
    return { proposal, text: res.finalText };
  } finally {
    clearInterval(tick);
    process.off('SIGINT', onSig);
    o.signal?.removeEventListener('abort', onSig);
    if (!o.keep) rmSync(runDir, { recursive: true, force: true });
  }
}
