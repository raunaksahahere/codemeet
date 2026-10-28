import { z } from 'zod';
import type { RoomScope } from './policy.js';
export type { RoomScope };

/** Wire protocol version; bump on incompatible changes. */
export const PROTOCOL_VERSION = 1;

export const LIMITS = {
  maxFileBytes: 1_000_000,
  maxFiles: 2_000,
  maxRoomBytes: 25_000_000,
  maxUpdateBytes: 2_000_000,
  maxMessageChars: 8_000,
  maxNameChars: 40,
  maxTitleChars: 200,
  maxProposalFiles: 100,
  maxPasswordChars: 200,
  /** Largest Socket.IO frame the server accepts. */
  maxFrameBytes: 8_000_000,
} as const;

export type Provider = 'claude' | 'codex';
export type Permission = 'publish_proposals' | 'apply_code' | 'agent_message' | 'invoke_provider';
export const PERMISSIONS: readonly Permission[] = [
  'publish_proposals',
  'apply_code',
  'agent_message',
  'invoke_provider',
];

// ── Shared views ──

export interface Participant {
  id: string;
  kind: 'human' | 'agent';
  /** Human display name, or the agent's provider name ("Claude"). */
  name: string;
  /** What coworkers see: "Sam" or "Sam's Claude". */
  label: string;
  ownerId: string | null;
  provider: Provider | null;
  role: 'host' | 'member' | 'agent';
  color: string;
  online: boolean;
}

export interface RoomInfo {
  roomId: string;
  scope: RoomScope;
  scopePath: string | null;
  codeignore: string;
  hostId: string;
  projectName: string;
  expiresAt: number;
  protocol: number;
}

export interface JoinRequestView {
  id: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
}

export interface ManifestEntry {
  path: string;
  hash: string;
  size: number;
}

export type ProposalStatus = 'pending' | 'applied' | 'rejected' | 'stale' | 'superseded';

export interface ProposalChangeView {
  path: string;
  op: 'create' | 'update' | 'delete';
  baseHash: string | null;
  newHash: string | null;
  /** Unified diff computed by the server against its current document state. */
  diff: string;
  size: number;
}

export interface ProposalView {
  id: string;
  agentId: string;
  agentLabel: string;
  ownerId: string;
  provider: Provider;
  runId: string;
  title: string;
  summary: string;
  status: ProposalStatus;
  revision: number;
  changes: ProposalChangeView[];
  createdAt: number;
  updatedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  staleReason: string | null;
}

export interface GrantView {
  id: string;
  grantorId: string;
  agentId: string;
  peerAgentId: string | null;
  permission: Permission;
  params: GrantParams;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
}

export interface GrantParams {
  /** Hard cap on messages per thread (loop prevention). */
  maxTurns?: number;
  /** Allow the responder to answer without per-message review. */
  auto?: boolean;
  /** Context the peer may receive; only "messages" is implemented. */
  context?: 'messages';
}

export type MessageState = 'queued' | 'delivered' | 'read' | 'blocked';

export interface MessageView {
  id: string;
  seq: number;
  threadId: string;
  inReplyTo: string | null;
  fromAgentId: string;
  fromLabel: string;
  toAgentId: string;
  toLabel: string;
  body: string;
  state: MessageState;
  createdAt: number;
}

export interface ActivityEntry {
  seq: number;
  at: number;
  actorId: string | null;
  actorLabel: string;
  kind: string;
  path: string | null;
  summary: string;
}

// ── RPC: client → server (all calls are acknowledged) ──

const name = z.string().trim().min(1).max(LIMITS.maxNameChars);
const bytes = z.custom<Uint8Array>((v) => v instanceof Uint8Array, 'expected binary');
const id = z.string().min(1).max(100);
const path = z.string().min(1).max(512);

export const RpcSchemas = {
  'room.create': z.object({
    displayName: name,
    password: z.string().min(3).max(LIMITS.maxPasswordChars),
    scope: z.enum(['file', 'folder', 'workspace']),
    scopePath: path.optional(),
    codeignore: z.string().max(20_000).optional(),
    projectName: z.string().trim().max(80).optional(),
    ttlMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  }),
  'room.join': z.object({
    roomId: id,
    password: z.string().max(LIMITS.maxPasswordChars),
    displayName: name,
  }),
  'room.claim': z.object({ requestId: id, claimSecret: z.string().min(8).max(200) }),
  'room.resume': z.object({ roomId: id, token: z.string().min(16).max(200) }),
  'room.decide': z.object({ requestId: id, accept: z.boolean() }),
  'room.state': z.object({}),
  'room.leave': z.object({}),
  'room.close': z.object({}),
  'agent.register': z.object({ provider: z.enum(['claude', 'codex']) }),
  'doc.list': z.object({}),
  'doc.seed': z.object({ path, content: z.string().max(LIMITS.maxFileBytes) }),
  'doc.sync': z.object({ path, stateVector: bytes }),
  'doc.update': z.object({ path, update: bytes }),
  'doc.delete': z.object({ path }),
  'doc.rename': z.object({ from: path, to: path }),
  'proposal.upsert': z.object({
    agentId: id,
    runId: id,
    title: z.string().trim().min(1).max(LIMITS.maxTitleChars),
    summary: z.string().max(4_000).optional(),
    changes: z
      .array(
        z.object({
          path,
          op: z.enum(['create', 'update', 'delete']),
          baseHash: z.string().length(64).nullable(),
          content: z.string().max(LIMITS.maxFileBytes).optional(),
        }),
      )
      .min(1)
      .max(LIMITS.maxProposalFiles),
  }),
  'proposal.list': z.object({ status: z.enum(['pending', 'applied', 'rejected', 'stale', 'superseded']).optional() }),
  'proposal.get': z.object({ proposalId: id }),
  'proposal.decide': z.object({ proposalId: id, approve: z.boolean() }),
  'consent.grant': z.object({
    permission: z.enum(['publish_proposals', 'apply_code', 'agent_message', 'invoke_provider']),
    agentId: id,
    peerAgentId: id.optional(),
    ttlMinutes: z.number().int().min(1).max(24 * 60),
    params: z
      .object({
        maxTurns: z.number().int().min(1).max(50).optional(),
        auto: z.boolean().optional(),
        context: z.literal('messages').optional(),
      })
      .optional(),
  }),
  'consent.revoke': z.object({ grantId: id }),
  'consent.list': z.object({}),
  'consent.check': z.object({ agentId: id, peerAgentId: id, permission: z.enum(['agent_message', 'invoke_provider']) }),
  'msg.send': z.object({
    fromAgentId: id,
    toAgentId: id,
    threadId: id.optional(),
    inReplyTo: id.optional(),
    clientMsgId: z.string().min(8).max(100),
    body: z.string().min(1).max(LIMITS.maxMessageChars),
  }),
  'msg.list': z.object({ threadId: id.optional(), sinceSeq: z.number().int().min(0).optional() }),
  'msg.ack': z.object({ messageId: id, state: z.enum(['delivered', 'read']) }),
  'activity.list': z.object({ sinceSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }),
  'presence.cursor': z.object({ path, line: z.number().int().min(0), character: z.number().int().min(0) }),
} as const;

export type RpcOp = keyof typeof RpcSchemas;
export type RpcInput<K extends RpcOp> = z.input<(typeof RpcSchemas)[K]>;

export interface Credentials {
  memberId: string;
  token: string;
}

export interface SessionSnapshot {
  room: RoomInfo;
  participants: Participant[];
  me: string;
  pending: JoinRequestView[];
}

export interface RpcResults {
  'room.create': { roomId: string; credentials: Credentials; snapshot: SessionSnapshot };
  'room.join': { requestId: string; claimSecret: string; expiresAt: number };
  'room.claim': { status: 'pending' | 'rejected' | 'approved'; credentials?: Credentials; snapshot?: SessionSnapshot };
  'room.resume': SessionSnapshot;
  'room.decide': { ok: true };
  'room.state': SessionSnapshot;
  'room.leave': { ok: true };
  'room.close': { ok: true };
  'agent.register': { agentId: string; label: string };
  'doc.list': { files: ManifestEntry[] };
  'doc.seed': { created: boolean; state: Uint8Array; hash: string };
  'doc.sync': { update: Uint8Array; stateVector: Uint8Array; exists: boolean };
  'doc.update': { ok: true };
  'doc.delete': { ok: true };
  'doc.rename': { ok: true };
  'proposal.upsert': { proposal: ProposalView };
  'proposal.list': { proposals: ProposalView[] };
  'proposal.get': { proposal: ProposalView };
  'proposal.decide': { proposal: ProposalView };
  'consent.grant': { grant: GrantView };
  'consent.revoke': { ok: true };
  'consent.list': { grants: GrantView[] };
  'consent.check': { allowed: boolean; reason?: string; maxTurns?: number; auto?: boolean };
  'msg.send': { message: MessageView; deduplicated: boolean };
  'msg.list': { messages: MessageView[] };
  'msg.ack': { ok: true };
  'activity.list': { entries: ActivityEntry[] };
  'presence.cursor': { ok: true };
}

export type RpcErrorCode =
  | 'invalid'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'too_large'
  | 'stale'
  | 'consent_required'
  | 'expired'
  | 'locked'
  | 'unavailable'
  | 'internal';

export type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: RpcErrorCode; message: string } };

export class RpcError extends Error {
  constructor(
    public readonly code: RpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

// ── Server → client events (single socket event name: "evt") ──

export type ServerEvent =
  | { type: 'join-request'; request: JoinRequestView }
  | { type: 'join-decision'; requestId: string; accepted: boolean; reason?: string }
  | { type: 'presence'; participants: Participant[]; pending: JoinRequestView[] }
  | { type: 'room-closed'; reason: string }
  | { type: 'doc-created'; path: string; update: Uint8Array; by: string }
  | { type: 'doc-update'; path: string; update: Uint8Array; by: string }
  | { type: 'doc-deleted'; path: string; by: string }
  | { type: 'doc-renamed'; from: string; to: string; by: string }
  | { type: 'proposal'; proposal: ProposalView }
  | { type: 'consent'; grants: GrantView[] }
  | { type: 'message'; message: MessageView }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'cursor'; participantId: string; label: string; color: string; path: string; line: number; character: number };

export function agentLabel(ownerName: string, provider: Provider): string {
  return `${ownerName}'s ${provider === 'claude' ? 'Claude' : 'Codex'}`;
}
