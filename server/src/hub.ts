import { randomBytes } from 'node:crypto';
import type { Namespace, Socket } from 'socket.io';
import { createTwoFilesPatch } from 'diff';
import {
  LIMITS,
  RpcError,
  RpcSchemas,
  SharingPolicy,
  agentLabel,
  normalizeRelPath,
  randomToken,
  sha256,
  type Ack,
  type ActivityEntry,
  type GrantView,
  type MessageView,
  type Participant,
  type Permission,
  type ProposalChangeView,
  type ProposalView,
  type Provider,
  type RoomInfo,
  type RpcInput,
  type RpcOp,
  type RpcResults,
  type ServerEvent,
  type SessionSnapshot,
  type JoinRequestView,
  PROTOCOL_VERSION,
} from '@codemeet/shared';
import type { ServerConfig } from './config.js';
import { Db, DbUnavailableError } from './db.js';
import { DocManager } from './docs.js';
import { TokenBucket, WindowLimiter, hashPassword, hashToken, safeEqualHex, verifyPassword } from './security.js';

const COLORS = ['#e06c75', '#61afef', '#98c379', '#e5c07b', '#c678dd', '#56b6c2', '#d19a66', '#ef596f', '#7aa2f7', '#bb9af7'];
const JOIN_REQUEST_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_TURNS = 6;

interface RoomRow {
  id: string;
  password_hash: string;
  scope: 'file' | 'folder' | 'workspace';
  scope_path: string | null;
  codeignore: string;
  project_name: string;
  host_member_id: string | null;
  status: 'active' | 'closed';
  ttl_minutes: number;
  expires_at: Date;
}

interface MemberRow {
  id: string;
  room_id: string;
  kind: 'human' | 'agent';
  display_name: string;
  owner_member_id: string | null;
  provider: Provider | null;
  role: 'host' | 'member' | 'agent';
  token_hash: string | null;
  color: string;
  removed_at: Date | null;
}

interface SockData {
  auth?: { roomId: string; memberId: string };
  ip: string;
  bucket: TokenBucket;
}
type Sock = Socket & { data: SockData };

class RoomRuntime {
  readonly members = new Map<string, MemberRow>();
  /** memberId -> connected socket ids. Presence is ephemeral and never persisted. */
  readonly online = new Map<string, Set<string>>();
  readonly policy: SharingPolicy;
  readonly lastEditAudit = new Map<string, number>();
  expiresAt: number;
  dirty = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(public row: RoomRow) {
    this.policy = new SharingPolicy({ scope: row.scope, scopePath: row.scope_path ?? undefined, codeignore: row.codeignore });
    this.expiresAt = row.expires_at.getTime();
  }

  /** Serializes structural operations (seed/delete/rename/proposal decisions) per room. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

interface Call {
  sock: Sock;
}

type Handlers = { [K in RpcOp]: (call: Call, input: ReturnType<(typeof RpcSchemas)[K]['parse']>) => Promise<RpcResults[K]> };

const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

export class Hub {
  readonly docs: DocManager;
  private readonly rooms = new Map<string, RoomRuntime>();
  private readonly limiter = new WindowLimiter();
  /** Credentials minted on approval and handed over once, to whoever holds the claim secret. */
  private readonly credentials = new Map<string, { memberId: string; token: string; expires: number }>();
  private readonly requestSockets = new Map<string, string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: ServerConfig,
    private readonly nsp: Namespace,
  ) {
    this.docs = new DocManager(db);
  }

  start(): void {
    this.nsp.on('connection', (raw) => this.onConnection(raw as Sock));
    this.sweeper = setInterval(() => void this.sweep().catch((e) => console.error('[hub] sweep failed:', this.db.redact(String(e)))), 15_000);
    this.sweeper.unref();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await this.flushActivity().catch(() => undefined);
    await this.docs.close().catch(() => undefined);
  }

  // ── connection + dispatch ──

  private clientIp(sock: Sock): string {
    if (this.config.trustProxy) {
      const fwd = sock.handshake.headers['x-forwarded-for'];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return sock.handshake.address;
  }

  private onConnection(sock: Sock): void {
    sock.data = { ip: this.clientIp(sock), bucket: new TokenBucket(300, 150) };
    sock.on('rpc', (req: unknown, ack: unknown) => {
      if (typeof ack !== 'function') return;
      void this.dispatch(sock, req).then(ack as (a: Ack<unknown>) => void);
    });
    sock.on('disconnect', () => void this.onDisconnect(sock).catch(() => undefined));
  }

  private async dispatch(sock: Sock, req: unknown): Promise<Ack<unknown>> {
    try {
      if (!sock.data.bucket.take()) throw new RpcError('rate_limited', 'Too many requests; slow down');
      if (typeof req !== 'object' || req === null) throw new RpcError('invalid', 'Malformed request');
      const { op, input } = req as { op?: unknown; input?: unknown };
      if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(RpcSchemas, op)) throw new RpcError('invalid', 'Unknown operation');
      const parsed = RpcSchemas[op as RpcOp].safeParse(input ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new RpcError('invalid', `${issue?.path.join('.') || 'input'}: ${issue?.message ?? 'invalid'}`);
      }
      const handler = this.handlers[op as RpcOp] as (c: Call, i: unknown) => Promise<unknown>;
      return { ok: true, data: await handler({ sock }, parsed.data) };
    } catch (err) {
      if (err instanceof RpcError) return { ok: false, error: { code: err.code, message: err.message } };
      if (err instanceof DbUnavailableError) return { ok: false, error: { code: 'unavailable', message: err.message } };
      console.error('[hub] internal error:', this.db.redact(err instanceof Error ? (err.stack ?? err.message) : String(err)));
      return { ok: false, error: { code: 'internal', message: 'Internal server error' } };
    }
  }

  // ── runtime / auth helpers ──

  private async runtime(roomId: string): Promise<RoomRuntime> {
    let rt = this.rooms.get(roomId);
    if (!rt) {
      const r = await this.db.query<RoomRow>('SELECT * FROM rooms WHERE id=$1', [roomId]);
      const row = r.rows[0];
      if (!row) throw new RpcError('not_found', 'Room not found');
      if (row.status === 'closed') throw new RpcError('expired', 'This room has been closed or has expired');
      const raced = this.rooms.get(roomId);
      if (raced) return raced;
      rt = new RoomRuntime(row);
      const m = await this.db.query<MemberRow>('SELECT * FROM members WHERE room_id=$1', [roomId]);
      for (const mem of m.rows) rt.members.set(mem.id, mem);
      this.rooms.set(roomId, rt);
    }
    if (Date.now() > rt.expiresAt) {
      await this.closeRoom(rt, 'Room expired after inactivity');
      throw new RpcError('expired', 'This room has expired');
    }
    return rt;
  }

  private async authed(call: Call): Promise<{ rt: RoomRuntime; me: MemberRow }> {
    const auth = call.sock.data.auth;
    if (!auth) throw new RpcError('unauthorized', 'Join or resume a room first');
    const rt = await this.runtime(auth.roomId);
    const me = rt.members.get(auth.memberId);
    if (!me || me.removed_at) throw new RpcError('unauthorized', 'You are no longer a member of this room');
    return { rt, me };
  }

  private requireHost(rt: RoomRuntime, me: MemberRow): void {
    if (rt.row.host_member_id !== me.id) throw new RpcError('forbidden', 'Only the room host can do this');
  }

  private ownedAgent(rt: RoomRuntime, me: MemberRow, agentId: string): MemberRow {
    const a = rt.members.get(agentId);
    if (!a || a.kind !== 'agent' || a.removed_at) throw new RpcError('not_found', 'Unknown agent');
    if (a.owner_member_id !== me.id) throw new RpcError('forbidden', 'That agent belongs to another participant');
    return a;
  }

  private touch(rt: RoomRuntime): void {
    rt.expiresAt = Date.now() + rt.row.ttl_minutes * 60_000;
    rt.dirty = true;
  }

  private label(rt: RoomRuntime, id: string | null): string {
    return (id && rt.members.get(id)?.display_name) || 'Unknown';
  }

  private participants(rt: RoomRuntime): Participant[] {
    const out: Participant[] = [];
    for (const m of rt.members.values()) {
      if (m.removed_at) continue;
      const online = m.kind === 'human' ? (rt.online.get(m.id)?.size ?? 0) > 0 : (rt.online.get(m.owner_member_id ?? '')?.size ?? 0) > 0;
      out.push({
        id: m.id,
        kind: m.kind,
        name: m.kind === 'agent' ? (m.provider === 'claude' ? 'Claude' : 'Codex') : m.display_name,
        label: m.display_name,
        ownerId: m.owner_member_id,
        provider: m.provider,
        role: m.role,
        color: m.color,
        online,
      });
    }
    return out;
  }

  private roomInfo(rt: RoomRuntime): RoomInfo {
    return {
      roomId: rt.row.id,
      scope: rt.row.scope,
      scopePath: rt.row.scope_path,
      codeignore: rt.row.codeignore,
      hostId: rt.row.host_member_id ?? '',
      projectName: rt.row.project_name,
      expiresAt: rt.expiresAt,
      protocol: PROTOCOL_VERSION,
    };
  }

  private async pending(rt: RoomRuntime): Promise<JoinRequestView[]> {
    const r = await this.db.query<{ id: string; display_name: string; created_at: Date; expires_at: Date }>(
      "SELECT id, display_name, created_at, expires_at FROM join_requests WHERE room_id=$1 AND status='pending' AND expires_at > now() ORDER BY created_at",
      [rt.row.id],
    );
    return r.rows.map((x) => ({ id: x.id, displayName: x.display_name, createdAt: x.created_at.getTime(), expiresAt: x.expires_at.getTime() }));
  }

  private async snapshot(rt: RoomRuntime, me: MemberRow): Promise<SessionSnapshot> {
    return {
      room: this.roomInfo(rt),
      participants: this.participants(rt),
      me: me.id,
      pending: rt.row.host_member_id === me.id ? await this.pending(rt) : [],
    };
  }

  private emitRoom(roomId: string, evt: ServerEvent, exceptSocket?: string): void {
    const t = this.nsp.to(roomId);
    (exceptSocket ? t.except(exceptSocket) : t).emit('evt', evt);
  }

  private emitMember(roomId: string, memberId: string, evt: ServerEvent): void {
    this.nsp.to(`m:${roomId}:${memberId}`).emit('evt', evt);
  }

  private async broadcastPresence(rt: RoomRuntime): Promise<void> {
    const participants = this.participants(rt);
    const host = rt.row.host_member_id;
    const t = this.nsp.to(rt.row.id);
    (host ? t.except(`m:${rt.row.id}:${host}`) : t).emit('evt', { type: 'presence', participants, pending: [] } satisfies ServerEvent);
    if (host) this.emitMember(rt.row.id, host, { type: 'presence', participants, pending: await this.pending(rt) });
  }

  private async audit(rt: RoomRuntime, actor: MemberRow | null, kind: string, path: string | null, summary: string): Promise<void> {
    const actorLabel = actor?.display_name ?? 'CodeMeet';
    const r = await this.db.query<{ seq: string; at: Date }>(
      'INSERT INTO audit_events (room_id, actor_id, actor_label, kind, path, summary) VALUES ($1,$2,$3,$4,$5,$6) RETURNING seq, at',
      [rt.row.id, actor?.id ?? null, actorLabel, kind, path, summary.slice(0, 500)],
    );
    const row = r.rows[0];
    if (!row) return;
    const entry: ActivityEntry = { seq: Number(row.seq), at: row.at.getTime(), actorId: actor?.id ?? null, actorLabel, kind, path, summary };
    this.emitRoom(rt.row.id, { type: 'activity', entry });
  }

  private bind(rt: RoomRuntime, sock: Sock, memberId: string): void {
    if (sock.data.auth && (sock.data.auth.roomId !== rt.row.id || sock.data.auth.memberId !== memberId)) {
      throw new RpcError('conflict', 'This connection is already bound to another session; reconnect first');
    }
    sock.data.auth = { roomId: rt.row.id, memberId };
    void sock.join(rt.row.id);
    void sock.join(`m:${rt.row.id}:${memberId}`);
    let set = rt.online.get(memberId);
    if (!set) rt.online.set(memberId, (set = new Set()));
    set.add(sock.id);
    void this.db.query('UPDATE members SET last_seen_at=now() WHERE id=$1', [memberId]).catch(() => undefined);
    this.touch(rt);
  }

  private async onDisconnect(sock: Sock): Promise<void> {
    const auth = sock.data.auth;
    for (const [rid, sid] of this.requestSockets) if (sid === sock.id) this.requestSockets.delete(rid);
    if (!auth) return;
    const rt = this.rooms.get(auth.roomId);
    if (!rt) return;
    const set = rt.online.get(auth.memberId);
    set?.delete(sock.id);
    if (set && set.size === 0) rt.online.delete(auth.memberId);
    await this.db.query('UPDATE members SET last_seen_at=now() WHERE id=$1', [auth.memberId]).catch(() => undefined);
    await this.broadcastPresence(rt);
  }

  // ── lifecycle / expiry ──

  async closeRoom(rt: RoomRuntime, reason: string): Promise<void> {
    if (this.rooms.get(rt.row.id) !== rt && rt.row.status === 'closed') return;
    rt.row.status = 'closed';
    this.rooms.delete(rt.row.id);
    await this.docs.evictRoom(rt.row.id);
    await this.db.query("UPDATE rooms SET status='closed', close_reason=$2, closed_at=now() WHERE id=$1 AND status='active'", [rt.row.id, reason]);
    await this.db.query("UPDATE join_requests SET status='expired' WHERE room_id=$1 AND status='pending'", [rt.row.id]);
    this.nsp.to(rt.row.id).emit('evt', { type: 'room-closed', reason } satisfies ServerEvent);
    this.nsp.in(rt.row.id).socketsLeave(rt.row.id);
    for (const sid of [...rt.online.values()].flatMap((s) => [...s])) {
      const s = this.nsp.sockets.get(sid) as Sock | undefined;
      if (s) s.data.auth = undefined;
    }
  }

  private async flushActivity(): Promise<void> {
    for (const rt of this.rooms.values()) {
      if (!rt.dirty) continue;
      rt.dirty = false;
      await this.db.query('UPDATE rooms SET last_activity=now(), expires_at=$2 WHERE id=$1', [rt.row.id, new Date(rt.expiresAt)]);
    }
  }

  /** Test hook: makes a room look idle past its TTL and runs the expiry sweep. */
  async forceExpire(roomId: string): Promise<void> {
    const rt = this.rooms.get(roomId);
    if (rt) rt.expiresAt = 0;
    await this.db.query("UPDATE rooms SET expires_at = now() - interval '1 minute' WHERE id=$1", [roomId]);
    await this.sweep();
  }

  async sweep(): Promise<void> {
    await this.flushActivity();
    for (const rt of [...this.rooms.values()]) {
      if (Date.now() > rt.expiresAt) await this.closeRoom(rt, 'Room expired after inactivity');
    }
    // Rooms nobody has loaded since a restart.
    const stale = await this.db.query<{ id: string }>("SELECT id FROM rooms WHERE status='active' AND expires_at < now()");
    for (const { id } of stale.rows) {
      try {
        const rt = await this.runtime(id);
        await this.closeRoom(rt, 'Room expired after inactivity');
      } catch {
        /* already closed */
      }
    }
    await this.db.query("UPDATE join_requests SET status='expired' WHERE status='pending' AND expires_at < now()");
    for (const [k, v] of this.credentials) if (v.expires < Date.now()) this.credentials.delete(k);
    // Retention: drop long-closed rooms and everything attached to them.
    await this.db.query("DELETE FROM rooms WHERE status='closed' AND closed_at < now() - ($1 || ' days')::interval", [String(this.config.retentionDays)]);
  }

  // ── consent helpers ──

  private async activeGrant(rt: RoomRuntime, grantor: string, agentId: string, peerAgentId: string | null, permission: Permission) {
    const r = await this.db.query<GrantRow>(
      `SELECT * FROM grants WHERE room_id=$1 AND grantor_member_id=$2 AND agent_id=$3 AND permission=$4
         AND (peer_agent_id IS NOT DISTINCT FROM $5) AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [rt.row.id, grantor, agentId, permission, peerAgentId],
    );
    return r.rows[0] ?? null;
  }

  /** Both owners must have an active, unexpired agent_message grant for the pair. */
  private async pairState(rt: RoomRuntime, fromAgent: string, toAgent: string): Promise<{ ok: boolean; reason?: string; maxTurns: number; auto: boolean }> {
    const a = rt.members.get(fromAgent);
    const b = rt.members.get(toAgent);
    if (!a || !b || a.kind !== 'agent' || b.kind !== 'agent' || a.removed_at || b.removed_at) return { ok: false, reason: 'unknown agent', maxTurns: 0, auto: false };
    const ga = await this.activeGrant(rt, a.owner_member_id as string, a.id, b.id, 'agent_message');
    const gb = await this.activeGrant(rt, b.owner_member_id as string, b.id, a.id, 'agent_message');
    if (!ga) return { ok: false, reason: `${this.label(rt, a.owner_member_id)} has not granted ${a.display_name} permission to message ${b.display_name}`, maxTurns: 0, auto: false };
    if (!gb) return { ok: false, reason: `${this.label(rt, b.owner_member_id)} has not granted ${b.display_name} permission to receive messages from ${a.display_name}`, maxTurns: 0, auto: false };
    const turns = [ga.params.maxTurns, gb.params.maxTurns].filter((x): x is number => typeof x === 'number');
    return { ok: true, maxTurns: turns.length ? Math.min(...turns) : DEFAULT_MAX_TURNS, auto: false };
  }

  private grantView(g: GrantRow): GrantView {
    return {
      id: g.id,
      grantorId: g.grantor_member_id,
      agentId: g.agent_id,
      peerAgentId: g.peer_agent_id,
      permission: g.permission,
      params: g.params ?? {},
      expiresAt: g.expires_at.getTime(),
      createdAt: g.created_at.getTime(),
      revokedAt: g.revoked_at ? g.revoked_at.getTime() : null,
    };
  }

  private async grantsForMember(rt: RoomRuntime, memberId: string): Promise<GrantView[]> {
    const agentIds = [...rt.members.values()].filter((m) => m.kind === 'agent' && m.owner_member_id === memberId).map((m) => m.id);
    const r = await this.db.query<GrantRow>(
      `SELECT * FROM grants WHERE room_id=$1 AND (grantor_member_id=$2 OR peer_agent_id = ANY($3::text[])) ORDER BY created_at DESC LIMIT 200`,
      [rt.row.id, memberId, agentIds],
    );
    return r.rows.map((g) => this.grantView(g));
  }

  private async pushConsent(rt: RoomRuntime, memberIds: string[]): Promise<void> {
    for (const id of new Set(memberIds)) this.emitMember(rt.row.id, id, { type: 'consent', grants: await this.grantsForMember(rt, id) });
  }

  // ── proposals ──

  private proposalView(rt: RoomRuntime, p: ProposalRow): ProposalView {
    return {
      id: p.id,
      agentId: p.agent_id,
      agentLabel: this.label(rt, p.agent_id),
      ownerId: p.owner_id,
      provider: p.provider,
      runId: p.run_id,
      title: p.title,
      summary: p.summary,
      status: p.status,
      revision: p.revision,
      changes: p.changes.map(({ content: _content, ...rest }) => rest),
      createdAt: p.created_at.getTime(),
      updatedAt: p.updated_at.getTime(),
      decidedBy: p.decided_by,
      decidedAt: p.decided_at ? p.decided_at.getTime() : null,
      staleReason: p.stale_reason,
    };
  }

  // ── message helpers ──

  private messageView(rt: RoomRuntime, m: MessageRow): MessageView {
    return {
      id: m.id,
      seq: Number(m.seq),
      threadId: m.thread_id,
      inReplyTo: m.in_reply_to,
      fromAgentId: m.from_agent_id,
      fromLabel: this.label(rt, m.from_agent_id),
      toAgentId: m.to_agent_id,
      toLabel: this.label(rt, m.to_agent_id),
      body: m.body,
      state: m.state,
      createdAt: m.created_at.getTime(),
    };
  }

  // ── RPC handlers ──

  private readonly handlers: Handlers = {
    'room.create': async (call, i) => {
      if (call.sock.data.auth) throw new RpcError('conflict', 'This connection already has a session');
      if (!this.limiter.allow(`create:${call.sock.data.ip}`, this.config.maxCreatesPerMinute, 60_000)) throw new RpcError('rate_limited', 'Too many rooms created; try again shortly');
      let scopePath: string | null = null;
      if (i.scope !== 'workspace') {
        scopePath = i.scopePath ? normalizeRelPath(i.scopePath) : null;
        if (!scopePath) throw new RpcError('invalid', 'scopePath must be a safe relative path for file/folder scope');
      }
      const roomId = randomBytes(7).toString('base64url');
      const memberId = newId('m');
      const token = randomToken();
      const ttl = i.ttlMinutes ?? this.config.roomTtlMinutes;
      const passwordHash = await hashPassword(i.password);
      const expires = new Date(Date.now() + ttl * 60_000);
      await this.db.tx(async (c) => {
        await c.query(
          'INSERT INTO rooms (id, password_hash, scope, scope_path, codeignore, project_name, host_member_id, ttl_minutes, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [roomId, passwordHash, i.scope, scopePath, i.codeignore ?? '', i.projectName ?? '', memberId, ttl, expires],
        );
        await c.query(
          "INSERT INTO members (id, room_id, kind, display_name, role, token_hash, color) VALUES ($1,$2,'human',$3,'host',$4,$5)",
          [memberId, roomId, i.displayName, hashToken(token), COLORS[0]],
        );
      });
      const rt = await this.runtime(roomId);
      this.bind(rt, call.sock, memberId);
      await this.audit(rt, rt.members.get(memberId) ?? null, 'room-created', null, `${i.displayName} created the room`);
      await this.broadcastPresence(rt);
      return { roomId, credentials: { memberId, token }, snapshot: await this.snapshot(rt, rt.members.get(memberId) as MemberRow) };
    },

    'room.join': async (call, i) => {
      const ip = call.sock.data.ip;
      if (this.limiter.count(`fail:${ip}:${i.roomId}`) >= 8 || this.limiter.count(`fail:*:${i.roomId}`) >= 40) {
        throw new RpcError('locked', 'Too many failed attempts; try again in a few minutes');
      }
      if (!this.limiter.allow(`join:${ip}`, this.config.maxJoinsPerMinute, 60_000)) throw new RpcError('rate_limited', 'Too many join attempts');
      const rt = await this.runtime(i.roomId);
      if (!(await verifyPassword(i.password, rt.row.password_hash))) {
        this.limiter.allow(`fail:${ip}:${i.roomId}`, 1_000, 10 * 60_000);
        this.limiter.allow(`fail:*:${i.roomId}`, 10_000, 10 * 60_000);
        throw new RpcError('unauthorized', 'Invalid room or password');
      }
      if ((await this.pending(rt)).length >= 20) throw new RpcError('rate_limited', 'Too many pending join requests for this room');
      const requestId = newId('jr');
      const claimSecret = randomToken(24);
      const expiresAt = Date.now() + JOIN_REQUEST_TTL_MS;
      await this.db.query('INSERT INTO join_requests (id, room_id, display_name, claim_hash, expires_at) VALUES ($1,$2,$3,$4,$5)', [
        requestId, rt.row.id, i.displayName, hashToken(claimSecret), new Date(expiresAt),
      ]);
      this.requestSockets.set(requestId, call.sock.id);
      const host = rt.row.host_member_id;
      if (host) this.emitMember(rt.row.id, host, { type: 'join-request', request: { id: requestId, displayName: i.displayName, createdAt: Date.now(), expiresAt } });
      return { requestId, claimSecret, expiresAt };
    },

    'room.claim': async (call, i) => {
      const r = await this.db.query<{ room_id: string; claim_hash: string; status: string; member_id: string | null; expires_at: Date }>(
        'SELECT room_id, claim_hash, status, member_id, expires_at FROM join_requests WHERE id=$1',
        [i.requestId],
      );
      const row = r.rows[0];
      if (!row || !safeEqualHex(row.claim_hash, hashToken(i.claimSecret))) throw new RpcError('unauthorized', 'Unknown join request');
      if (row.status === 'rejected') return { status: 'rejected' as const };
      if (row.status === 'pending') {
        if (row.expires_at.getTime() < Date.now()) throw new RpcError('expired', 'The join request expired; request again');
        return { status: 'pending' as const };
      }
      if (row.status !== 'approved') throw new RpcError('expired', 'This join request was already used or expired; request again');
      const creds = this.credentials.get(i.requestId);
      if (!creds) throw new RpcError('expired', 'Approval could not be completed (server restarted?); request to join again');
      const rt = await this.runtime(row.room_id);
      this.credentials.delete(i.requestId);
      await this.db.query("UPDATE join_requests SET status='claimed' WHERE id=$1", [i.requestId]);
      this.bind(rt, call.sock, creds.memberId);
      const me = rt.members.get(creds.memberId) as MemberRow;
      await this.audit(rt, me, 'member-joined', null, `${me.display_name} joined`);
      await this.broadcastPresence(rt);
      return { status: 'approved' as const, credentials: { memberId: creds.memberId, token: creds.token }, snapshot: await this.snapshot(rt, me) };
    },

    'room.resume': async (call, i) => {
      const rt = await this.runtime(i.roomId);
      const h = hashToken(i.token);
      const me = [...rt.members.values()].find((m) => m.kind === 'human' && !m.removed_at && m.token_hash && safeEqualHex(m.token_hash, h));
      if (!me) throw new RpcError('unauthorized', 'Session token is not valid for this room');
      this.bind(rt, call.sock, me.id);
      await this.broadcastPresence(rt);
      return this.snapshot(rt, me);
    },

    'room.decide': async (call, i) => {
      const { rt, me } = await this.authed(call);
      this.requireHost(rt, me);
      const r = await this.db.query<{ id: string; display_name: string; status: string; expires_at: Date }>(
        'SELECT id, display_name, status, expires_at FROM join_requests WHERE id=$1 AND room_id=$2',
        [i.requestId, rt.row.id],
      );
      const req = r.rows[0];
      if (!req) throw new RpcError('not_found', 'No such join request');
      if (req.status !== 'pending') throw new RpcError('conflict', 'This request was already decided');
      if (req.expires_at.getTime() < Date.now()) throw new RpcError('expired', 'This request has expired');
      const guestSocket = this.requestSockets.get(i.requestId);
      if (!i.accept) {
        await this.db.query("UPDATE join_requests SET status='rejected', decided_at=now() WHERE id=$1", [i.requestId]);
        if (guestSocket) this.nsp.to(guestSocket).emit('evt', { type: 'join-decision', requestId: i.requestId, accepted: false, reason: 'The host declined your request' } satisfies ServerEvent);
        await this.audit(rt, me, 'join-rejected', null, `${me.display_name} declined ${req.display_name}`);
        await this.broadcastPresence(rt);
        return { ok: true as const };
      }
      const memberId = newId('m');
      const token = randomToken();
      const humans = [...rt.members.values()].filter((m) => m.kind === 'human').length;
      const color = COLORS[humans % COLORS.length] as string;
      await this.db.tx(async (c) => {
        await c.query("INSERT INTO members (id, room_id, kind, display_name, role, token_hash, color) VALUES ($1,$2,'human',$3,'member',$4,$5)", [
          memberId, rt.row.id, req.display_name, hashToken(token), color,
        ]);
        await c.query("UPDATE join_requests SET status='approved', member_id=$2, decided_at=now() WHERE id=$1", [i.requestId, memberId]);
      });
      rt.members.set(memberId, {
        id: memberId, room_id: rt.row.id, kind: 'human', display_name: req.display_name, owner_member_id: null,
        provider: null, role: 'member', token_hash: hashToken(token), color, removed_at: null,
      });
      this.credentials.set(i.requestId, { memberId, token, expires: Date.now() + JOIN_REQUEST_TTL_MS });
      if (guestSocket) this.nsp.to(guestSocket).emit('evt', { type: 'join-decision', requestId: i.requestId, accepted: true } satisfies ServerEvent);
      await this.audit(rt, me, 'join-approved', null, `${me.display_name} approved ${req.display_name}`);
      await this.broadcastPresence(rt);
      return { ok: true as const };
    },

    'room.state': async (call) => {
      const { rt, me } = await this.authed(call);
      return this.snapshot(rt, me);
    },

    'room.leave': async (call) => {
      const { rt, me } = await this.authed(call);
      if (rt.row.host_member_id === me.id) throw new RpcError('forbidden', 'The host cannot leave; close the room or just disconnect (the room stays resumable)');
      const now = new Date();
      await this.db.query('UPDATE members SET removed_at=$2, token_hash=NULL WHERE id=$1 OR owner_member_id=$1', [me.id, now]);
      for (const m of rt.members.values()) if (m.id === me.id || m.owner_member_id === me.id) m.removed_at = now;
      const ownedAgents = [...rt.members.values()].filter((m) => m.owner_member_id === me.id).map((m) => m.id);
      await this.db.query(
        'UPDATE grants SET revoked_at=now() WHERE room_id=$1 AND revoked_at IS NULL AND (grantor_member_id=$2 OR agent_id = ANY($3::text[]) OR peer_agent_id = ANY($3::text[]))',
        [rt.row.id, me.id, ownedAgents],
      );
      const sid = call.sock.id;
      call.sock.data.auth = undefined;
      void call.sock.leave(rt.row.id);
      void call.sock.leave(`m:${rt.row.id}:${me.id}`);
      rt.online.delete(me.id);
      void sid;
      await this.audit(rt, me, 'member-left', null, `${me.display_name} left`);
      await this.broadcastPresence(rt);
      return { ok: true as const };
    },

    'room.close': async (call) => {
      const { rt, me } = await this.authed(call);
      this.requireHost(rt, me);
      await this.audit(rt, me, 'room-closed', null, `${me.display_name} closed the room`);
      await this.closeRoom(rt, 'The host closed the room');
      return { ok: true as const };
    },

    'agent.register': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const agentId = `a_${me.id.slice(2)}_${i.provider}`;
      const label = agentLabel(me.display_name, i.provider);
      if (!rt.members.has(agentId)) {
        await this.db.query(
          "INSERT INTO members (id, room_id, kind, display_name, owner_member_id, provider, role, color) VALUES ($1,$2,'agent',$3,$4,$5,'agent',$6) ON CONFLICT (id) DO NOTHING",
          [agentId, rt.row.id, label, me.id, i.provider, me.color],
        );
        rt.members.set(agentId, {
          id: agentId, room_id: rt.row.id, kind: 'agent', display_name: label, owner_member_id: me.id, provider: i.provider,
          role: 'agent', token_hash: null, color: me.color, removed_at: null,
        });
        await this.audit(rt, me, 'agent-registered', null, `${label} joined the room`);
      }
      await this.broadcastPresence(rt);
      return { agentId, label };
    },

    'doc.list': async (call) => {
      const { rt } = await this.authed(call);
      return { files: await this.docs.manifest(rt.row.id) };
    },

    'doc.seed': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const ok = rt.policy.check(i.path);
      if (!ok.ok) throw new RpcError('forbidden', `${i.path}: ${ok.reason}`);
      return rt.lock(async () => {
        const r = await this.docs.seed(rt.row.id, i.path, i.content);
        if (r.created && r.update) {
          this.emitRoom(rt.row.id, { type: 'doc-created', path: i.path, update: r.update, by: me.id }, call.sock.id);
          await this.audit(rt, me, 'file-created', i.path, `${me.display_name} shared ${i.path}`);
        }
        this.touch(rt);
        return { created: r.created, state: r.state, hash: r.hash };
      });
    },

    'doc.sync': async (call, i) => {
      const { rt } = await this.authed(call);
      const ok = rt.policy.check(i.path);
      if (!ok.ok) throw new RpcError('forbidden', `${i.path}: ${ok.reason}`);
      return this.docs.sync(rt.row.id, i.path, i.stateVector);
    },

    'doc.update': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const ok = rt.policy.check(i.path);
      if (!ok.ok) throw new RpcError('forbidden', `${i.path}: ${ok.reason}`);
      await this.docs.applyUpdate(rt.row.id, i.path, i.update);
      this.emitRoom(rt.row.id, { type: 'doc-update', path: i.path, update: i.update, by: me.id }, call.sock.id);
      this.touch(rt);
      const k = `${me.id}\u0000${i.path}`;
      if (Date.now() - (rt.lastEditAudit.get(k) ?? 0) > 60_000) {
        rt.lastEditAudit.set(k, Date.now());
        await this.audit(rt, me, 'file-edited', i.path, `${me.display_name} edited ${i.path}`);
      }
      return { ok: true as const };
    },

    'doc.delete': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const ok = rt.policy.check(i.path);
      if (!ok.ok) throw new RpcError('forbidden', `${i.path}: ${ok.reason}`);
      return rt.lock(async () => {
        await this.docs.remove(rt.row.id, i.path);
        this.emitRoom(rt.row.id, { type: 'doc-deleted', path: i.path, by: me.id }, call.sock.id);
        await this.audit(rt, me, 'file-deleted', i.path, `${me.display_name} deleted ${i.path}`);
        this.touch(rt);
        return { ok: true as const };
      });
    },

    'doc.rename': async (call, i) => {
      const { rt, me } = await this.authed(call);
      for (const p of [i.from, i.to]) {
        const ok = rt.policy.check(p);
        if (!ok.ok) throw new RpcError('forbidden', `${p}: ${ok.reason}`);
      }
      return rt.lock(async () => {
        await this.docs.rename(rt.row.id, i.from, i.to);
        this.emitRoom(rt.row.id, { type: 'doc-renamed', from: i.from, to: i.to, by: me.id }, call.sock.id);
        await this.audit(rt, me, 'file-renamed', i.to, `${me.display_name} renamed ${i.from} to ${i.to}`);
        this.touch(rt);
        return { ok: true as const };
      });
    },

    'proposal.upsert': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const agent = this.ownedAgent(rt, me, i.agentId);
      if (!(await this.activeGrant(rt, me.id, agent.id, null, 'publish_proposals'))) {
        throw new RpcError('consent_required', `${agent.display_name} may not publish proposals yet. Run: codemeet permissions grant publish ${agent.provider}`);
      }
      const seen = new Set<string>();
      for (const c of i.changes) {
        const ok = rt.policy.check(c.path);
        if (!ok.ok) throw new RpcError('forbidden', `${c.path}: ${ok.reason}`);
        if (seen.has(c.path)) throw new RpcError('invalid', `Duplicate change for ${c.path}`);
        seen.add(c.path);
        if (c.op === 'delete' ? c.content !== undefined : c.content === undefined) throw new RpcError('invalid', `${c.path}: ${c.op} requires${c.op === 'delete' ? ' no' : ''} content`);
        if (c.op !== 'create' && !c.baseHash) throw new RpcError('invalid', `${c.path}: ${c.op} requires baseHash`);
      }
      return rt.lock(async () => {
        const changes: StoredChange[] = [];
        const stale: string[] = [];
        for (const c of i.changes) {
          const cur = await this.docs.text(rt.row.id, c.path);
          const curHash = cur === null ? null : sha256(cur);
          if (c.op === 'create' ? cur !== null : curHash !== c.baseHash) stale.push(c.path);
          const base = cur ?? '';
          const next = c.op === 'delete' ? '' : (c.content as string);
          changes.push({
            path: c.path,
            op: c.op,
            baseHash: c.baseHash,
            newHash: c.op === 'delete' ? null : sha256(next),
            diff: createTwoFilesPatch(`a/${c.path}`, `b/${c.path}`, base, next, '', '', { context: 3 }).slice(0, 200_000),
            size: Buffer.byteLength(next, 'utf8'),
            content: c.op === 'delete' ? undefined : next,
          });
        }
        const staleReason = stale.length ? `Base changed since the agent started: ${stale.join(', ')}. Re-run or rebase the agent.` : null;
        const r = await this.db.query<ProposalRow>(
          `INSERT INTO proposals (id, room_id, agent_id, owner_id, provider, run_id, title, summary, changes, stale_reason)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (room_id, agent_id, run_id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary,
             changes=EXCLUDED.changes, stale_reason=EXCLUDED.stale_reason, revision=proposals.revision+1, updated_at=now()
             WHERE proposals.status='pending'
           RETURNING *`,
          [newId('p'), rt.row.id, agent.id, me.id, agent.provider, i.runId, i.title, i.summary ?? '', JSON.stringify(changes), staleReason],
        );
        const row = r.rows[0];
        if (!row) throw new RpcError('conflict', 'That proposal was already decided; start a new run');
        const view = this.proposalView(rt, row);
        this.emitRoom(rt.row.id, { type: 'proposal', proposal: view });
        if (row.revision === 1) await this.audit(rt, me, 'proposal-published', null, `${agent.display_name} proposed: ${i.title}`);
        this.touch(rt);
        return { proposal: view };
      });
    },

    'proposal.list': async (call, i) => {
      const { rt } = await this.authed(call);
      const r = await this.db.query<ProposalRow>(
        'SELECT * FROM proposals WHERE room_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 100',
        [rt.row.id, i.status ?? null],
      );
      return { proposals: r.rows.map((p) => this.proposalView(rt, p)) };
    },

    'proposal.get': async (call, i) => {
      const { rt } = await this.authed(call);
      const r = await this.db.query<ProposalRow>('SELECT * FROM proposals WHERE room_id=$1 AND id=$2', [rt.row.id, i.proposalId]);
      if (!r.rows[0]) throw new RpcError('not_found', 'No such proposal');
      return { proposal: this.proposalView(rt, r.rows[0]) };
    },

    'proposal.decide': async (call, i) => {
      const { rt, me } = await this.authed(call);
      return rt.lock(async () => {
        const r = await this.db.query<ProposalRow>('SELECT * FROM proposals WHERE room_id=$1 AND id=$2', [rt.row.id, i.proposalId]);
        const p = r.rows[0];
        if (!p) throw new RpcError('not_found', 'No such proposal');
        if (rt.row.host_member_id !== me.id && p.owner_id !== me.id) throw new RpcError('forbidden', 'Only the room host or the agent owner can decide this proposal');
        if (p.status !== 'pending') throw new RpcError('conflict', `Proposal is already ${p.status}`);
        const setStatus = async (status: string, reason: string | null): Promise<ProposalRow | null> => {
          const u = await this.db.query<ProposalRow>(
            "UPDATE proposals SET status=$2, stale_reason=COALESCE($3, stale_reason), decided_by=$4, decided_at=now(), updated_at=now() WHERE id=$1 AND status='pending' RETURNING *",
            [p.id, status, reason, me.id],
          );
          return u.rows[0] ?? null;
        };
        if (!i.approve) {
          const row = await setStatus('rejected', null);
          if (!row) throw new RpcError('conflict', 'Proposal was already decided');
          const view = this.proposalView(rt, row);
          this.emitRoom(rt.row.id, { type: 'proposal', proposal: view });
          await this.audit(rt, me, 'proposal-rejected', null, `${me.display_name} rejected: ${p.title}`);
          return { proposal: view };
        }
        // Re-verify every base right now; anything newer than the agent saw makes it stale.
        const bad: string[] = [];
        for (const c of p.changes) {
          const cur = await this.docs.text(rt.row.id, c.path);
          if (c.op === 'create' ? cur !== null : cur === null || sha256(cur) !== c.baseHash) bad.push(c.path);
          const ok = rt.policy.check(c.path);
          if (!ok.ok) bad.push(c.path);
        }
        if (bad.length) {
          const row = await setStatus('stale', `Files changed since this proposal was made: ${[...new Set(bad)].join(', ')}`);
          if (row) this.emitRoom(rt.row.id, { type: 'proposal', proposal: this.proposalView(rt, row) });
          throw new RpcError('stale', `Proposal is stale (${[...new Set(bad)].join(', ')}); ask the agent to re-run against the latest code`);
        }
        // The conditional UPDATE is the single point that makes "apply once" true.
        const row = await setStatus('applied', null);
        if (!row) throw new RpcError('conflict', 'Proposal was already decided');
        for (const c of p.changes) {
          if (c.op === 'delete') {
            await this.docs.remove(rt.row.id, c.path);
            this.emitRoom(rt.row.id, { type: 'doc-deleted', path: c.path, by: p.agent_id });
          } else if (c.op === 'create') {
            const s = await this.docs.seed(rt.row.id, c.path, c.content as string);
            if (s.update) this.emitRoom(rt.row.id, { type: 'doc-created', path: c.path, update: s.update, by: p.agent_id });
          } else {
            const update = await this.docs.replaceText(rt.row.id, c.path, c.content as string);
            this.emitRoom(rt.row.id, { type: 'doc-update', path: c.path, update, by: p.agent_id });
          }
        }
        const view = this.proposalView(rt, row);
        this.emitRoom(rt.row.id, { type: 'proposal', proposal: view });
        await this.audit(rt, me, 'proposal-applied', null, `${me.display_name} approved "${p.title}" by ${this.label(rt, p.agent_id)}`);
        this.touch(rt);
        return { proposal: view };
      });
    },

    'consent.grant': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const agent = this.ownedAgent(rt, me, i.agentId);
      let peer: string | null = null;
      if (i.permission === 'agent_message' || i.permission === 'invoke_provider') {
        if (!i.peerAgentId) throw new RpcError('invalid', 'peerAgentId is required for this permission');
        const p = rt.members.get(i.peerAgentId);
        if (!p || p.kind !== 'agent' || p.removed_at) throw new RpcError('not_found', 'Unknown peer agent');
        if (p.id === agent.id) throw new RpcError('invalid', 'An agent cannot grant itself access to itself');
        peer = p.id;
      } else if (i.peerAgentId) {
        throw new RpcError('invalid', 'peerAgentId does not apply to this permission');
      }
      const id = newId('g');
      const expires = new Date(Date.now() + i.ttlMinutes * 60_000);
      const r = await this.db.query<GrantRow>(
        'INSERT INTO grants (id, room_id, grantor_member_id, agent_id, peer_agent_id, permission, params, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id, rt.row.id, me.id, agent.id, peer, i.permission, JSON.stringify(i.params ?? {}), expires],
      );
      await this.audit(rt, me, 'consent-granted', null, `${me.display_name} granted ${i.permission} to ${agent.display_name}${peer ? ` with ${this.label(rt, peer)}` : ''}`);
      await this.pushConsent(rt, [me.id, ...(peer ? [rt.members.get(peer)?.owner_member_id ?? ''] : [])].filter(Boolean));
      return { grant: this.grantView(r.rows[0] as GrantRow) };
    },

    'consent.revoke': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const r = await this.db.query<GrantRow>('SELECT * FROM grants WHERE id=$1 AND room_id=$2', [i.grantId, rt.row.id]);
      const g = r.rows[0];
      if (!g) throw new RpcError('not_found', 'No such grant');
      if (g.grantor_member_id !== me.id) throw new RpcError('forbidden', 'Only the grantor can revoke a permission');
      await this.db.query('UPDATE grants SET revoked_at=COALESCE(revoked_at, now()) WHERE id=$1', [g.id]);
      if (g.peer_agent_id) {
        await this.db.query(
          "UPDATE messages SET state='blocked' WHERE room_id=$1 AND state='queued' AND ((from_agent_id=$2 AND to_agent_id=$3) OR (from_agent_id=$3 AND to_agent_id=$2))",
          [rt.row.id, g.agent_id, g.peer_agent_id],
        );
      }
      await this.audit(rt, me, 'consent-revoked', null, `${me.display_name} revoked ${g.permission} for ${this.label(rt, g.agent_id)}`);
      const peerOwner = g.peer_agent_id ? rt.members.get(g.peer_agent_id)?.owner_member_id : null;
      await this.pushConsent(rt, [me.id, ...(peerOwner ? [peerOwner] : [])]);
      return { ok: true as const };
    },

    'consent.list': async (call) => {
      const { rt, me } = await this.authed(call);
      return { grants: await this.grantsForMember(rt, me.id) };
    },

    'consent.check': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const mine = this.ownedAgent(rt, me, i.agentId);
      const pair = await this.pairState(rt, mine.id, i.peerAgentId);
      if (!pair.ok) return { allowed: false, reason: pair.reason };
      if (i.permission === 'agent_message') return { allowed: true, maxTurns: pair.maxTurns };
      const g = await this.activeGrant(rt, me.id, mine.id, i.peerAgentId, 'invoke_provider');
      if (!g) return { allowed: false, reason: `You have not allowed ${mine.display_name} to invoke a provider for ${this.label(rt, i.peerAgentId)}` };
      return { allowed: true, maxTurns: Math.min(pair.maxTurns, g.params.maxTurns ?? pair.maxTurns), auto: g.params.auto === true };
    },

    'msg.send': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const from = this.ownedAgent(rt, me, i.fromAgentId);
      const to = rt.members.get(i.toAgentId);
      if (!to || to.kind !== 'agent' || to.removed_at) throw new RpcError('not_found', 'Unknown recipient agent');
      if (!this.limiter.allow(`msg:${rt.row.id}:${from.id}`, 30, 60_000)) throw new RpcError('rate_limited', 'Agent message rate limit reached');
      // Consent is checked before dedup so a replay after revocation cannot slip through.
      const pair = await this.pairState(rt, from.id, to.id);
      if (!pair.ok) {
        await this.audit(rt, me, 'message-blocked', null, `Blocked ${from.display_name} -> ${to.display_name}: no mutual consent`);
        throw new RpcError('consent_required', pair.reason ?? 'Both owners must grant agent_message permission');
      }
      const dup = await this.db.query<MessageRow>('SELECT * FROM messages WHERE room_id=$1 AND from_agent_id=$2 AND client_msg_id=$3', [rt.row.id, from.id, i.clientMsgId]);
      if (dup.rows[0]) return { message: this.messageView(rt, dup.rows[0]), deduplicated: true };
      const threadId = i.threadId ?? newId('t');
      if (i.threadId) {
        const n = await this.db.query<{ n: string; other: string }>(
          `SELECT count(*) AS n, count(*) FILTER (WHERE NOT ((from_agent_id=$3 AND to_agent_id=$4) OR (from_agent_id=$4 AND to_agent_id=$3))) AS other
             FROM messages WHERE room_id=$1 AND thread_id=$2 AND state <> 'blocked'`,
          [rt.row.id, threadId, from.id, to.id],
        );
        if (Number(n.rows[0]?.other ?? 0) > 0) throw new RpcError('forbidden', 'Thread belongs to a different pair of agents');
        if (Number(n.rows[0]?.n ?? 0) >= pair.maxTurns) {
          throw new RpcError('conflict', `Thread reached its limit of ${pair.maxTurns} messages; start a new thread or raise maxTurns`);
        }
      }
      const r = await this.db.query<MessageRow>(
        'INSERT INTO messages (id, room_id, thread_id, in_reply_to, from_agent_id, to_agent_id, client_msg_id, body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [newId('msg'), rt.row.id, threadId, i.inReplyTo ?? null, from.id, to.id, i.clientMsgId, i.body],
      );
      const view = this.messageView(rt, r.rows[0] as MessageRow);
      for (const owner of new Set([from.owner_member_id as string, to.owner_member_id as string])) this.emitMember(rt.row.id, owner, { type: 'message', message: view });
      await this.audit(rt, me, 'message-sent', null, `${from.display_name} -> ${to.display_name} (thread ${threadId})`);
      this.touch(rt);
      return { message: view, deduplicated: false };
    },

    'msg.list': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const mine = [...rt.members.values()].filter((m) => m.kind === 'agent' && m.owner_member_id === me.id).map((m) => m.id);
      const r = await this.db.query<MessageRow>(
        `SELECT * FROM messages WHERE room_id=$1 AND seq > $2 AND ($3::text IS NULL OR thread_id=$3)
           AND (from_agent_id = ANY($4::text[]) OR (to_agent_id = ANY($4::text[]) AND state <> 'blocked'))
         ORDER BY seq LIMIT 500`,
        [rt.row.id, i.sinceSeq ?? 0, i.threadId ?? null, mine],
      );
      return { messages: r.rows.map((m) => this.messageView(rt, m)) };
    },

    'msg.ack': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const r = await this.db.query<MessageRow>('SELECT * FROM messages WHERE room_id=$1 AND id=$2', [rt.row.id, i.messageId]);
      const m = r.rows[0];
      if (!m) throw new RpcError('not_found', 'No such message');
      if (rt.members.get(m.to_agent_id)?.owner_member_id !== me.id) throw new RpcError('forbidden', 'Only the recipient can acknowledge a message');
      if (m.state === 'blocked') throw new RpcError('consent_required', 'This message was blocked because consent was revoked');
      const pair = await this.pairState(rt, m.from_agent_id, m.to_agent_id);
      if (!pair.ok) throw new RpcError('consent_required', pair.reason ?? 'Consent no longer active');
      const rank = { queued: 0, delivered: 1, read: 2, blocked: -1 } as const;
      if (rank[i.state] > rank[m.state]) {
        const u = await this.db.query<MessageRow>('UPDATE messages SET state=$2 WHERE id=$1 RETURNING *', [m.id, i.state]);
        const view = this.messageView(rt, u.rows[0] as MessageRow);
        const from = rt.members.get(m.from_agent_id)?.owner_member_id;
        if (from) this.emitMember(rt.row.id, from, { type: 'message', message: view });
      }
      return { ok: true as const };
    },

    'activity.list': async (call, i) => {
      const { rt } = await this.authed(call);
      const r = await this.db.query<{ seq: string; at: Date; actor_id: string | null; actor_label: string; kind: string; path: string | null; summary: string }>(
        'SELECT seq, at, actor_id, actor_label, kind, path, summary FROM audit_events WHERE room_id=$1 AND seq > $2 ORDER BY seq DESC LIMIT $3',
        [rt.row.id, i.sinceSeq ?? 0, i.limit ?? 100],
      );
      return {
        entries: r.rows.reverse().map((x) => ({ seq: Number(x.seq), at: x.at.getTime(), actorId: x.actor_id, actorLabel: x.actor_label, kind: x.kind, path: x.path, summary: x.summary })),
      };
    },

    'presence.cursor': async (call, i) => {
      const { rt, me } = await this.authed(call);
      const ok = rt.policy.check(i.path);
      if (!ok.ok) throw new RpcError('forbidden', `${i.path}: ${ok.reason}`);
      call.sock.to(rt.row.id).volatile.emit('evt', {
        type: 'cursor', participantId: me.id, label: me.display_name, color: me.color, path: i.path, line: i.line, character: i.character,
      } satisfies ServerEvent);
      return { ok: true as const };
    },
  };
}

interface GrantRow {
  id: string;
  room_id: string;
  grantor_member_id: string;
  agent_id: string;
  peer_agent_id: string | null;
  permission: Permission;
  params: { maxTurns?: number; auto?: boolean; context?: 'messages' };
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

type StoredChange = ProposalChangeView & { content?: string };

interface ProposalRow {
  id: string;
  room_id: string;
  agent_id: string;
  owner_id: string;
  provider: Provider;
  run_id: string;
  title: string;
  summary: string;
  status: ProposalView['status'];
  revision: number;
  changes: StoredChange[];
  stale_reason: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MessageRow {
  id: string;
  seq: string;
  thread_id: string;
  in_reply_to: string | null;
  from_agent_id: string;
  to_agent_id: string;
  body: string;
  state: MessageView['state'];
  created_at: Date;
}

export type { RpcInput };
export { LIMITS };
