import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Command, InvalidArgumentError } from 'commander';
import { Session, binaryFor, detectProvider, runAgent, type AgentHost } from '@codemeet/core';
import type { ActivityEntry, GrantView, MessageView, Participant, ProposalView, Provider, RoomInfo, JoinRequestView } from '@codemeet/shared';
import { runDaemon } from './daemon.js';
import { CliError, files, loadConfig, loadSession, saveConfig, saveSession, type SavedSession } from './home.js';
import { connectDaemon, readDaemonInfo, type IpcClient } from './ipc.js';
import { runMcpServer } from './mcp.js';
import { cmdDbCheck, cmdDbMigrate, cmdDoctor, cmdInit, cmdServerStart } from './serverCmds.js';
import { VERSION, ago, expandPermission, resolveSecret, startDaemonProcess, table } from './util.js';

const execFileP = promisify(execFile);
const program = new Command();
program.name('codemeet').description('Real-time code collaboration between developers and their coding agents').version(VERSION).showHelpAfterError();

function projectPath(p: string | undefined): string {
  const abs = path.resolve(p ?? process.cwd());
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new CliError(`Project folder not found: ${abs}`);
  return realpathSync(abs);
}

function readCodeignore(root: string): string {
  const f = path.join(root, '.codeignore');
  return existsSync(f) ? readFileSync(f, 'utf8').slice(0, 20_000) : '';
}

async function withDaemon<T>(fn: (c: IpcClient) => Promise<T>): Promise<T> {
  let c: IpcClient;
  try {
    c = await connectDaemon();
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  try {
    return await fn(c);
  } finally {
    c.close();
  }
}

const rpc = <T>(c: IpcClient, op: string, input: unknown = {}) => c.call<T>('rpc', { op, input });

function printReport(st: { phase: string; reason: string | null; report: import('@codemeet/core').SyncReport | null }): void {
  const r = st.report;
  if (r) {
    if (r.uploaded.length) console.log(`Shared ${r.uploaded.length} file(s) as the baseline.`);
    if (r.downloaded.length) console.log(`Downloaded ${r.downloaded.length} file(s).`);
    if (r.unchanged.length) console.log(`${r.unchanged.length} file(s) already matched.`);
    if (r.localOnly.length) console.log(`${r.localOnly.length} local-only file(s) stay private (share one with \`codemeet share <path>\`).`);
    for (const s of r.skipped.slice(0, 8)) console.log(`  skipped ${s.path}: ${s.reason}`);
    if (r.skipped.length > 8) console.log(`  ... and ${r.skipped.length - 8} more skipped`);
  }
  if (st.phase === 'blocked' && r) {
    console.log(`\n${r.conflicts.length} local file(s) differ from the shared baseline. Nothing was changed:`);
    for (const c of r.conflicts) console.log(`  ${c.path}`);
    console.log('Run `codemeet baseline accept` to back them up under .codemeet/backups/ and use the shared versions,');
    console.log('or `codemeet leave` to cancel.');
  }
}

// ── server owner commands ──

program.command('init').description('Configure your PostgreSQL database (Neon, Supabase or local)')
  .option('--database-url-env <VAR>', 'read the connection string from this environment variable')
  .option('--stdin', 'read the connection string from standard input')
  .option('--migrate', 'apply migrations after verifying the connection')
  .action(cmdInit);
program.command('doctor').description('Check prerequisites and configuration').action(cmdDoctor);
const db = program.command('db').description('Database maintenance');
db.command('check').description('Verify connectivity and schema').action(cmdDbCheck);
db.command('migrate').description('Apply pending migrations').action(cmdDbMigrate);
program.command('server').description('Run the CodeMeet backend').command('start').description('Start the server (uses your own database)')
  .option('--host <host>', 'interface to bind (default 127.0.0.1; use 0.0.0.0 for LAN)')
  .option('--port <port>', 'port (default 3001)')
  .option('--migrate', 'apply pending migrations before starting')
  .action(cmdServerStart);

// ── rooms ──

const room = program.command('room').description('Create or join a collaboration room');

room.command('create').description('Create a room from a project folder and start syncing')
  .requiredOption('--name <name>', 'your display name (e.g. Sam)')
  .option('--project <path>', 'project folder to share', process.cwd())
  .option('--server <url>', 'CodeMeet server URL (default: last used, else http://127.0.0.1:3001)')
  .option('--scope <scope>', 'workspace | folder | file', 'workspace')
  .option('--path <relative>', 'folder or file to share when scope is folder/file')
  .option('--ttl-minutes <n>', 'idle time before the room expires', (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new InvalidArgumentError('must be an integer'); return n; })
  .action(async (o) => {
    if (readDaemonInfo()) throw new CliError('A session is already active on this machine. Run `codemeet leave` first.');
    const root = projectPath(o.project);
    const serverUrl = (o.server ?? loadConfig().serverUrl ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    const password = await resolveSecret('CODEMEET_ROOM_PASSWORD', 'Room password (collaborators need it): ');
    const session = new Session(serverUrl);
    let creds;
    try {
      creds = await session.create({
        displayName: o.name, password, scope: o.scope, scopePath: o.path, codeignore: readCodeignore(root),
        projectName: path.basename(root), ttlMinutes: o.ttlMinutes,
      });
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    session.dispose();
    saveConfig({ ...loadConfig(), serverUrl, displayName: o.name });
    saveSession({ ...creds, projectRoot: root, role: 'host', displayName: o.name, bootstrapped: false, acceptBaseline: false, agents: {} });
    const c = await startDaemonProcess();
    const st = await c.call<{ phase: string; reason: string | null; report: never }>('status');
    c.close();
    console.log(`\nRoom created.\n  Room ID:   ${creds.roomId}\n  Server:    ${serverUrl}\n  Project:   ${root}`);
    console.log('Share the room ID and the password through a channel you trust.');
    printReport(st);
    if (st.phase === 'error') throw new CliError(`Could not start syncing: ${st.reason}`);
    console.log('\nApprove joiners with `codemeet members` / `codemeet members approve <id>`.');
  });

room.command('join <roomId>').description('Ask to join a room and sync into a project folder')
  .requiredOption('--name <name>', 'your display name (e.g. Ava)')
  .option('--project <path>', 'local folder to sync into (created files go here)', process.cwd())
  .option('--server <url>', 'CodeMeet server URL')
  .option('--accept-baseline', 'back up and replace local files that differ from the shared baseline')
  .action(async (roomId: string, o) => {
    if (readDaemonInfo()) throw new CliError('A session is already active on this machine. Run `codemeet leave` first.');
    const root = projectPath(o.project);
    const serverUrl = (o.server ?? loadConfig().serverUrl ?? 'http://127.0.0.1:3001').replace(/\/+$/, '');
    const password = await resolveSecret('CODEMEET_ROOM_PASSWORD', 'Room password: ');
    const session = new Session(serverUrl);
    let creds;
    try {
      creds = await session.join({ roomId, password, displayName: o.name }, { onPending: () => console.log('Waiting for the host to approve your request...') });
    } catch (e) {
      throw new CliError((e as Error).message);
    }
    session.dispose();
    saveConfig({ ...loadConfig(), serverUrl, displayName: o.name });
    saveSession({ ...creds, projectRoot: root, role: 'guest', displayName: o.name, bootstrapped: false, acceptBaseline: !!o.acceptBaseline, agents: {} });
    const c = await startDaemonProcess();
    const st = await c.call<{ phase: string; reason: string | null; report: never }>('status');
    c.close();
    console.log(`Joined room ${roomId}.`);
    printReport(st);
    if (st.phase === 'error') throw new CliError(`Could not start syncing: ${st.reason}`);
    if (st.phase === 'blocked') process.exitCode = 3;
  });

program.command('resume').description('Restart the local session daemon for the saved session').action(async () => {
  if (!loadSession()) throw new CliError('No saved session to resume.');
  const c = await startDaemonProcess();
  const st = await c.call<{ phase: string; reason: string | null; report: never }>('status');
  c.close();
  console.log(`Session resumed (${st.phase}).`);
  printReport(st);
});

program.command('baseline').description('Resolve a pending baseline decision').command('accept')
  .description('Back up differing local files and adopt the shared versions')
  .action(() => withDaemon(async (c) => { await c.call('baseline.accept'); console.log('Baseline accepted; local copies are under .codemeet/backups/.'); }));

program.command('share <path>').description('Share a local-only file that was kept private at join time')
  .action((p: string) => withDaemon(async (c) => { await c.call('share', { path: p }); console.log(`Sharing ${p}.`); }));

const members = program.command('members').description('List participants and pending join requests').option('--json');
members.action(() => withDaemon(async (c) => {
  const st = await c.call<{ participants: Participant[]; pending: JoinRequestView[] }>('status');
  console.log(table([['NAME', 'KIND', 'STATUS'], ...st.participants.map((p) => [p.label, p.kind === 'agent' ? `agent (${p.provider})` : p.role, p.online ? 'online' : 'offline'])]));
  if (st.pending.length) {
    console.log('\nPending join requests:');
    console.log(table(st.pending.map((p) => [p.id, p.displayName, `expires in ${Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000))}s`])));
  }
}));
for (const [name, accept] of [['approve', true], ['reject', false]] as const) {
  members.command(`${name} <requestId>`).description(`${name} a join request (host only)`).action((id: string) =>
    withDaemon(async (c) => { await rpc(c, 'room.decide', { requestId: id, accept }); console.log(`Request ${name}d.`); }));
}

program.command('status').description('Show the current session').option('--json', 'machine-readable output').action((o) => withDaemon(async (c) => {
  const st = await c.call<Record<string, unknown> & { phase: string; reason: string | null; roomId: string; server: string; role: string; projectRoot: string; connection: string; files: number; participants: Participant[]; pending: JoinRequestView[]; log: string[]; room: RoomInfo | null; responder: { modes: Record<string, string>; pending: number } | null }>('status');
  if (o.json) return console.log(JSON.stringify(st, null, 2));
  console.log(`Room ${st.roomId} on ${st.server}  (${st.role})`);
  console.log(`Project:     ${st.projectRoot}`);
  console.log(`State:       ${st.phase}${st.reason ? ` - ${st.reason}` : ''}   connection: ${st.connection}   files: ${st.files}`);
  if (st.room) console.log(`Scope:       ${st.room.scope}${st.room.scopePath ? ` (${st.room.scopePath})` : ''}`);
  console.log('\nParticipants:');
  for (const p of st.participants) console.log(`  ${p.online ? '●' : '○'} ${p.label}${p.kind === 'agent' ? '  [agent]' : ''}`);
  if (st.pending.length) console.log(`\n${st.pending.length} pending join request(s): codemeet members`);
  if (st.responder) console.log(`\nAgent responders: ${Object.entries(st.responder.modes).map(([k, v]) => `${k}=${v}`).join(', ')}   inbox pending: ${st.responder.pending}`);
  if (st.log.length) console.log(`\nRecent log:\n${st.log.slice(-5).map((l) => '  ' + l).join('\n')}`);
}));

const fmtActivity = (e: ActivityEntry) => `${new Date(e.at).toLocaleTimeString()}  ${e.summary}`;
program.command('activity').description('Show shared activity (edits, proposals, approvals)').option('--follow', 'keep streaming new activity').option('--limit <n>', 'entries to show', '30')
  .action((o) => withDaemon(async (c) => {
    if (!o.follow) {
      for (const e of await c.call<ActivityEntry[]>('activity', { limit: Number(o.limit) })) console.log(fmtActivity(e));
      return;
    }
    c.onEvent = (e) => console.log(fmtActivity(e as ActivityEntry));
    for (const e of await c.call<ActivityEntry[]>('activity.follow')) console.log(fmtActivity(e));
    await new Promise<void>((resolve) => { process.once('SIGINT', () => resolve()); process.once('SIGTERM', () => resolve()); });
  }));

// ── proposals ──

const proposals = program.command('proposals').description('List change proposals').option('--status <status>')
  .action((o) => withDaemon(async (c) => {
    const r = await rpc<{ proposals: ProposalView[] }>(c, 'proposal.list', { status: o.status });
    console.log(r.proposals.length ? table([['ID', 'BY', 'STATUS', 'FILES', 'TITLE'], ...r.proposals.map((p) => [p.id, p.agentLabel, p.status, String(p.changes.length), p.title.slice(0, 50)])]) : 'No proposals.');
  }));
void proposals;
program.command('diff <proposalId>').description('Show the diff of a proposal').action((id: string) => withDaemon(async (c) => {
  const { proposal: p } = await rpc<{ proposal: ProposalView }>(c, 'proposal.get', { proposalId: id });
  console.log(`${p.agentLabel}: ${p.title}\nstatus: ${p.status}   revision: ${p.revision}   updated ${ago(p.updatedAt)}`);
  if (p.staleReason) console.log(`WARNING: ${p.staleReason}`);
  for (const ch of p.changes) console.log(`\n=== ${ch.op} ${ch.path}\n${ch.diff}`);
}));
for (const [name, approve] of [['approve', true], ['reject', false]] as const) {
  program.command(`${name} <proposalId>`).description(`${name === 'approve' ? 'Approve and apply' : 'Reject'} a proposal (host or the agent's owner)`).action((id: string) =>
    withDaemon(async (c) => {
      try {
        const { proposal: p } = await rpc<{ proposal: ProposalView }>(c, 'proposal.decide', { proposalId: id, approve });
        console.log(`${p.agentLabel}'s proposal "${p.title}" is now ${p.status}.`);
      } catch (e) {
        throw new CliError((e as Error).message);
      }
    }));
}

// ── agents ──

const agent = program.command('agent').description('Run your coding agents inside the session');
agent.command('run <provider> [task...]').description('Run claude or codex on a task in an isolated snapshot; results arrive as a proposal')
  .option('--timeout <minutes>', 'time limit', '15')
  .option('--budget <usd>', 'spend cap for the run (claude)')
  .option('--allow-shell', 'let codex run shell commands inside its workspace sandbox')
  .option('--keep', 'keep the isolated snapshot for inspection')
  .action((provider: string, taskWords: string[], o) => withDaemon(async (c) => {
    if (provider !== 'claude' && provider !== 'codex') throw new CliError('Provider must be "claude" or "codex".');
    const task = taskWords.join(' ').trim();
    if (!task) throw new CliError('Describe the task, e.g. codemeet agent run claude "add input validation to src/api.ts"');
    const st = await c.call<{ projectRoot: string; phase: string; room: RoomInfo | null }>('status');
    const host: AgentHost = {
      projectRoot: st.projectRoot,
      runsDir: files.agents(),
      async room() {
        if (st.phase !== 'syncing' || !st.room) throw new Error(`Session is not ready (phase: ${st.phase}). Run \`codemeet status\`.`);
        return st.room;
      },
      ensureAgent: (p) => c.call('agent.ensure', { provider: p }),
      call: (op, input) => rpc(c, op, input),
    };
    try {
      const r = await runAgent(host, {
        provider, task, timeoutMs: Number(o.timeout) * 60_000, allowShell: !!o.allowShell,
        budgetUsd: o.budget ? Number(o.budget) : undefined, keep: o.keep, log: (l) => console.log(`[${provider}] ${l}`),
      });
      if (r.proposal) console.log(`\nProposal ${r.proposal.id}: ${r.proposal.changes.length} file(s). Review: codemeet diff ${r.proposal.id}   Apply: codemeet approve ${r.proposal.id}`);
      else console.log('\nThe agent finished without changing any shared file.');
      if (r.text) console.log(`\n${provider} said:\n${r.text.slice(0, 1500)}`);
    } catch (e) {
      throw new CliError((e as Error).message);
    }
  }));

// ── consent ──

const perms = program.command('permissions').description('View and change consent for agent actions');
const fmtGrant = (g: GrantView, who: (id: string) => string) => [g.id, who(g.agentId), g.permission, g.peerAgentId ? who(g.peerAgentId) : '-', g.revokedAt ? 'revoked' : g.expiresAt < Date.now() ? 'expired' : `until ${new Date(g.expiresAt).toLocaleTimeString()}`, g.params.maxTurns ? `turns<=${g.params.maxTurns}${g.params.auto ? ' auto' : ''}` : g.params.auto ? 'auto' : ''];
perms.action(() => withDaemon(async (c) => {
  const st = await c.call<{ participants: Participant[] }>('status');
  const who = (id: string) => st.participants.find((p) => p.id === id)?.label ?? id;
  const { grants } = await rpc<{ grants: GrantView[] }>(c, 'consent.list');
  console.log(grants.length ? table([['ID', 'AGENT', 'PERMISSION', 'WITH', 'STATE', 'LIMITS'], ...grants.map((g) => fmtGrant(g, who))]) : 'No permissions granted. Agent-to-agent messaging is off by default.');
}));
perms.command('grant <permission> <provider>').description('permission: publish | apply | message | invoke; provider: claude | codex')
  .option('--peer <agent>', 'the other participant\'s agent, e.g. "Ava\'s Codex" (message/invoke)')
  .option('--minutes <n>', 'how long the permission lasts', '60')
  .option('--max-turns <n>', 'maximum messages per thread')
  .option('--auto', 'invoke: allow answering without per-message review')
  .action((permission: string, provider: string, o) => withDaemon(async (c) => {
    if (provider !== 'claude' && provider !== 'codex') throw new CliError('Provider must be "claude" or "codex".');
    const perm = expandPermission(permission);
    const me = await c.call<{ agentId: string }>('agent.ensure', { provider });
    let peerAgentId: string | undefined;
    if (perm === 'agent_message' || perm === 'invoke_provider') {
      if (!o.peer) throw new CliError('--peer "<Name>\'s <Claude|Codex>" is required for this permission');
      const st = await c.call<{ participants: Participant[] }>('status');
      const peer = st.participants.find((p) => p.kind === 'agent' && (p.id === o.peer || p.label.toLowerCase() === String(o.peer).toLowerCase()));
      if (!peer) throw new CliError(`No agent "${o.peer}" in this room. Agents appear after their owner runs an agent command or grants a permission.\nKnown: ${st.participants.filter((p) => p.kind === 'agent').map((p) => p.label).join(', ') || 'none'}`);
      peerAgentId = peer.id;
    }
    const r = await rpc<{ grant: GrantView }>(c, 'consent.grant', {
      permission: perm, agentId: me.agentId, peerAgentId, ttlMinutes: Number(o.minutes),
      params: { ...(o.maxTurns ? { maxTurns: Number(o.maxTurns) } : {}), ...(o.auto ? { auto: true } : {}) },
    }).catch((e: Error) => { throw new CliError(e.message); });
    console.log(`Granted ${perm} (id ${r.grant.id}) until ${new Date(r.grant.expiresAt).toLocaleString()}. Revoke any time: codemeet permissions revoke ${r.grant.id}`);
  }));
perms.command('revoke <grantId>').description('Revoke a permission you granted').action((id: string) => withDaemon(async (c) => {
  await rpc(c, 'consent.revoke', { grantId: id }).catch((e: Error) => { throw new CliError(e.message); });
  console.log('Revoked. Queued messages for that pair are blocked and running replies are cancelled.');
}));

// ── agent messaging ──

const messages = program.command('messages').description('Agent-to-agent messages you are party to').option('--thread <id>');
messages.action((o) => withDaemon(async (c) => {
  const r = await rpc<{ messages: MessageView[] }>(c, 'msg.list', { threadId: o.thread });
  console.log(r.messages.length ? table([['SEQ', 'THREAD', 'FROM', 'TO', 'STATE', 'MESSAGE'], ...r.messages.map((m) => [String(m.seq), m.threadId.slice(0, 10), m.fromLabel, m.toLabel, m.state, m.body.replace(/\s+/g, ' ').slice(0, 70)])]) : 'No messages.');
}));
messages.command('send <body...>').requiredOption('--from <provider>', 'your agent: claude | codex').requiredOption('--to <agent>', 'recipient, e.g. "Ava\'s Codex"').option('--thread <id>')
  .description('Send a message from one of your agents (requires mutual consent)')
  .action((body: string[], o) => withDaemon(async (c) => {
    const me = await c.call<{ agentId: string }>('agent.ensure', { provider: o.from });
    const st = await c.call<{ participants: Participant[] }>('status');
    const peer = st.participants.find((p) => p.kind === 'agent' && (p.id === o.to || p.label.toLowerCase() === String(o.to).toLowerCase()));
    if (!peer) throw new CliError(`No agent "${o.to}" in this room.`);
    const r = await rpc<{ message: MessageView }>(c, 'msg.send', { fromAgentId: me.agentId, toAgentId: peer.id, threadId: o.thread, clientMsgId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, body: body.join(' ') })
      .catch((e: Error) => { throw new CliError(e.message); });
    console.log(`Sent (thread ${r.message.threadId}).`);
  }));

const inbox = program.command('inbox').description('Messages waiting for your agents');
type InboxItem = { message: MessageView; state: string; note?: string; reply?: string };
inbox.action(() => withDaemon(async (c) => {
  const items = await c.call<InboxItem[]>('inbox.list');
  console.log(items.length ? table([['ID', 'FROM', 'TO', 'STATE', 'MESSAGE'], ...items.map((i) => [i.message.id, i.message.fromLabel, i.message.toLabel, i.state + (i.note ? ` (${i.note})` : ''), i.message.body.replace(/\s+/g, ' ').slice(0, 60)])]) : 'Inbox is empty.');
}));
for (const [name, action] of [['approve', 'approve'], ['dismiss', 'dismiss']] as const) {
  inbox.command(`${name} <messageId>`).description(name === 'approve' ? 'Let your agent answer this message (one-message review mode)' : 'Ignore this message').action((id: string) =>
    withDaemon(async (c) => {
      const r = await c.call<InboxItem>('inbox.act', { messageId: id, action }).catch((e: Error) => { throw new CliError(e.message); });
      console.log(`${r.state}${r.note ? `: ${r.note}` : ''}${r.reply ? `\n\n${r.reply}` : ''}`);
    }));
}
program.command('responder <provider> <mode>').description('Set how your agent answers peers: off | review | auto')
  .action((provider: string, mode: string) => withDaemon(async (c) => {
    if (!['claude', 'codex'].includes(provider) || !['off', 'review', 'auto'].includes(mode)) throw new CliError('Usage: codemeet responder <claude|codex> <off|review|auto>');
    await c.call('agent.ensure', { provider });
    await c.call('responder.set', { provider, mode });
    console.log(`${provider} responder: ${mode}${mode === 'auto' ? ' (also requires an invoke grant with --auto)' : ''}`);
  }));

// ── MCP ──

const mcp = program.command('mcp').description('CodeMeet MCP server for Claude Code and Codex');
mcp.command('serve').description('Run the MCP server on stdio').action(runMcpServer);
for (const sub of ['install', 'uninstall'] as const) {
  mcp.command(sub).description(`${sub === 'install' ? 'Register' : 'Remove'} CodeMeet's MCP server with your coding agent`)
    .option('--client <client>', 'claude | codex | all', 'all')
    .option('--scope <scope>', 'claude only: local | user | project', 'user')
    .option('--dry-run', 'print what would run without changing anything')
    .action(async (o) => {
      const script = realpathSync(process.argv[1] as string);
      const clients: Provider[] = o.client === 'all' ? ['claude', 'codex'] : [o.client];
      for (const client of clients) {
        const bin = binaryFor(client);
        const info = await detectProvider(client);
        if (!info.found) { console.log(`${client}: not installed - skipped. ${info.hint}`); continue; }
        const envArgs = client === 'claude'
          ? ['-e', `CODEMEET_AGENT=claude`, ...(process.env.CODEMEET_HOME ? ['-e', `CODEMEET_HOME=${process.env.CODEMEET_HOME}`] : [])]
          : ['--env', `CODEMEET_AGENT=codex`, ...(process.env.CODEMEET_HOME ? ['--env', `CODEMEET_HOME=${process.env.CODEMEET_HOME}`] : [])];
        const argv = sub === 'install'
          ? (client === 'claude'
            ? ['mcp', 'add', '--scope', o.scope, 'codemeet', ...envArgs, '--', process.execPath, script, 'mcp', 'serve']
            : ['mcp', 'add', 'codemeet', ...envArgs, '--', process.execPath, script, 'mcp', 'serve'])
          : (client === 'claude' ? ['mcp', 'remove', '--scope', o.scope, 'codemeet'] : ['mcp', 'remove', 'codemeet']);
        console.log(`${o.dryRun ? '[dry run] ' : ''}${bin} ${argv.join(' ')}`);
        if (o.dryRun) continue;
        try {
          const { stdout } = await execFileP(bin, argv, { timeout: 30_000 });
          if (stdout.trim()) console.log(stdout.trim());
        } catch (e) {
          const err = e as { stderr?: string; message: string };
          console.log(`${client}: ${(err.stderr || err.message).trim().split('\n')[0]}`);
        }
      }
      if (sub === 'install') console.log('\nOnly your existing MCP entries were left untouched. Native file edits by these tools are not attributed; use `codemeet agent run` for attributed work.');
    });
}

// ── lifecycle ──

program.command('leave').description('End the session (host closes the room unless --keep-open)')
  .option('--keep-open', 'host: stop syncing but leave the room open so you can `codemeet resume`')
  .option('--keep-membership', 'guest: stop syncing but stay a member so you can `codemeet resume`')
  .action(async (o) => {
    const saved = loadSession();
    const info = readDaemonInfo();
    if (!info) {
      if (saved) { rmSync(files.session(), { force: true }); console.log('Removed a stale session record.'); } else console.log('No active session.');
      return;
    }
    const c = await connectDaemon();
    const permanent = !(o.keepOpen || o.keepMembership);
    await c.call('shutdown', { closeRoom: permanent && saved?.role === 'host', leaveRoom: permanent && saved?.role === 'guest' }).catch(() => undefined);
    c.close();
    for (let i = 0; i < 50 && readDaemonInfo(); i++) await new Promise((r) => setTimeout(r, 100));
    if (permanent) rmSync(files.session(), { force: true });
    console.log(permanent ? (saved?.role === 'host' ? 'Room closed. Your files are untouched.' : 'Left the room. Your files are untouched.') : 'Stopped syncing; `codemeet resume` continues this session.');
  });

program.command('daemon', { hidden: true }).action(runDaemon);

export async function main(argv: string[]): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CliError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = err.exitCode;
    } else {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}

export type { SavedSession };
void saveSession;
