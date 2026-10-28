import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { MessageView, Participant, ProposalView, ManifestEntry, ActivityEntry } from '@codemeet/shared';
import { connectDaemon, type IpcClient } from './ipc.js';

/**
 * CodeMeet MCP server (stdio). stdout carries only protocol traffic; diagnostics go to stderr.
 *
 * The identity of the calling agent comes from CODEMEET_AGENT (set when the integration is
 * registered), not from tool arguments, and the server re-derives the sender from the owner's
 * authenticated session, so a tool call can never claim to be someone else.
 */
export async function runMcpServer(): Promise<void> {
  const provider = process.env.CODEMEET_AGENT === 'codex' ? 'codex' : 'claude';
  const server = new McpServer({ name: 'codemeet', version: '0.1.0' });
  let client: IpcClient | null = null;
  const daemon = async (): Promise<IpcClient> => {
    if (!client) client = await connectDaemon();
    return client;
  };
  const rpc = async <T>(op: string, input: unknown): Promise<T> => (await daemon()).call<T>('rpc', { op, input });
  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
  const failure = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] });
  const myAgent = async (): Promise<string> => (await (await daemon()).call<{ agentId: string }>('agent.ensure', { provider })).agentId;

  server.tool('codemeet_participants', 'List people and coding agents in the current CodeMeet room.', {}, async () => {
    try {
      const s = await (await daemon()).call<{ participants: Participant[] }>('status');
      return text(s.participants.map((p) => ({ id: p.id, label: p.label, kind: p.kind, online: p.online })));
    } catch (e) {
      return failure(e);
    }
  });

  server.tool('codemeet_activity', 'Read recent shared activity (edits, proposals, approvals).', { limit: z.number().int().min(1).max(100).optional() }, async ({ limit }) => {
    try {
      return text((await rpc<{ entries: ActivityEntry[] }>('activity.list', { limit: limit ?? 30 })).entries);
    } catch (e) {
      return failure(e);
    }
  });

  server.tool('codemeet_proposals', 'List change proposals and their status.', { status: z.enum(['pending', 'applied', 'rejected', 'stale', 'superseded']).optional() }, async ({ status }) => {
    try {
      const r = await rpc<{ proposals: ProposalView[] }>('proposal.list', { status });
      return text(r.proposals.map((p) => ({ id: p.id, agent: p.agentLabel, title: p.title, status: p.status, files: p.changes.map((c) => `${c.op} ${c.path}`) })));
    } catch (e) {
      return failure(e);
    }
  });

  server.tool('codemeet_proposal_get', 'Get one proposal including unified diffs.', { id: z.string() }, async ({ id }) => {
    try {
      return text((await rpc<{ proposal: ProposalView }>('proposal.get', { proposalId: id })).proposal);
    } catch (e) {
      return failure(e);
    }
  });

  server.tool(
    'codemeet_propose_changes',
    'Publish a reviewable proposal of file changes to the room. Nothing is applied until a human approves it. Native file edits you make outside this tool are NOT attributed to you.',
    {
      title: z.string().min(1).max(200),
      summary: z.string().max(4000).optional(),
      changes: z.array(z.object({ path: z.string(), op: z.enum(['create', 'update', 'delete']), content: z.string().optional() })).min(1).max(100),
    },
    async ({ title, summary, changes }) => {
      try {
        const agentId = await myAgent();
        const { files } = await rpc<{ files: ManifestEntry[] }>('doc.list', {});
        const hashes = new Map(files.map((f) => [f.path, f.hash]));
        const withBase = changes.map((c) => ({ ...c, baseHash: c.op === 'create' ? null : (hashes.get(c.path) ?? null) }));
        const missing = withBase.find((c) => c.op !== 'create' && !c.baseHash);
        if (missing) throw new Error(`${missing.path} is not a shared file; use op "create" for new files`);
        const runId = process.env.CODEMEET_RUN_ID || `mcp_${Date.now().toString(36)}`;
        const r = await rpc<{ proposal: ProposalView }>('proposal.upsert', { agentId, runId, title, summary, changes: withBase });
        return text({ proposalId: r.proposal.id, status: r.proposal.status, note: 'Awaiting human approval: `codemeet approve ' + r.proposal.id + '`' });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.tool(
    'codemeet_message_send',
    'Send a message to another participant\'s agent. Works only after both owners granted agent_message permission.',
    { to: z.string().describe('Agent id or label, e.g. "Ava\'s Codex"'), body: z.string().min(1).max(8000), threadId: z.string().optional() },
    async ({ to, body, threadId }) => {
      try {
        const s = await (await daemon()).call<{ participants: Participant[] }>('status');
        const target = s.participants.find((p) => p.kind === 'agent' && (p.id === to || p.label.toLowerCase() === to.toLowerCase()));
        if (!target) throw new Error(`No agent named "${to}" in this room`);
        const r = await rpc<{ message: MessageView }>('msg.send', {
          fromAgentId: await myAgent(),
          toAgentId: target.id,
          threadId,
          clientMsgId: `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          body,
        });
        return text({ messageId: r.message.id, threadId: r.message.threadId, state: r.message.state });
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.tool('codemeet_messages', 'Read agent messages addressed to or sent by your agent.', { sinceSeq: z.number().int().min(0).optional(), threadId: z.string().optional() }, async ({ sinceSeq, threadId }) => {
    try {
      const r = await rpc<{ messages: MessageView[] }>('msg.list', { sinceSeq, threadId });
      return text(r.messages.map((m) => ({ id: m.id, seq: m.seq, thread: m.threadId, from: m.fromLabel, to: m.toLabel, state: m.state, body: m.body })));
    } catch (e) {
      return failure(e);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[codemeet-mcp] ready (agent=${provider})`);
}
