import { EventEmitter } from 'node:events';
import { io, type Socket } from 'socket.io-client';
import {
  RpcError,
  type Ack,
  type Credentials,
  type Participant,
  type RpcInput,
  type RpcOp,
  type RpcResults,
  type ServerEvent,
  type SessionSnapshot,
} from '@codemeet/shared';

export type SessionState = 'idle' | 'connecting' | 'online' | 'offline' | 'closed';

export interface StoredSession {
  serverUrl: string;
  roomId: string;
  memberId: string;
  token: string;
}

export interface SessionEvents {
  evt: [ServerEvent];
  state: [SessionState, string | undefined];
  /** Fired after every successful (re)authentication, including the first. */
  authenticated: [SessionSnapshot, { reconnect: boolean }];
}

const CALL_TIMEOUT_MS = 15_000;

/**
 * Connection to one CodeMeet server and one room. Identity is the durable member token, not
 * the socket id, so a dropped connection resumes the same participant.
 */
export class Session extends EventEmitter {
  state: SessionState = 'idle';
  snapshot: SessionSnapshot | null = null;
  creds: StoredSession | null = null;
  private socket: Socket | null = null;
  private hadAuth = false;
  private disposed = false;

  constructor(readonly serverUrl: string) {
    super();
  }

  override on<K extends keyof SessionEvents>(event: K, listener: (...args: SessionEvents[K]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  override once<K extends keyof SessionEvents>(event: K, listener: (...args: SessionEvents[K]) => void): this {
    return super.once(event, listener as (...a: unknown[]) => void);
  }
  override off<K extends keyof SessionEvents>(event: K, listener: (...args: SessionEvents[K]) => void): this {
    return super.off(event, listener as (...a: unknown[]) => void);
  }

  private setState(s: SessionState, detail?: string): void {
    if (this.state === s && !detail) return;
    this.state = s;
    this.emit('state', s, detail);
  }

  get me(): Participant | undefined {
    return this.snapshot?.participants.find((p) => p.id === this.snapshot?.me);
  }

  get connected(): boolean {
    return this.socket?.connected === true && this.state === 'online';
  }

  /** Opens the transport. Resolves once connected; rejects if the server is unreachable. */
  private connect(timeoutMs = 10_000): Promise<Socket> {
    if (this.socket) {
      const existing = this.socket;
      if (existing.connected) return Promise.resolve(existing);
    }
    this.setState('connecting');
    const base = this.serverUrl.replace(/\/+$/, '');
    const socket = io(`${base}/rooms`, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      timeout: timeoutMs,
    });
    this.socket = socket;
    socket.on('evt', (e: ServerEvent) => this.onEvent(e));
    socket.on('disconnect', (reason) => {
      if (this.disposed || this.state === 'closed') return;
      this.setState('offline', reason);
    });
    socket.on('connect', () => {
      if (this.creds && this.hadAuth) void this.reauthenticate();
    });
    return new Promise<Socket>((resolve, reject) => {
      const onErr = (err: Error) => {
        socket.off('connect', onOk);
        socket.close();
        this.socket = null;
        this.setState('idle');
        reject(new Error(`Cannot reach CodeMeet server at ${base}: ${err.message}`));
      };
      const onOk = () => {
        socket.off('connect_error', onErr);
        resolve(socket);
      };
      socket.once('connect', onOk);
      socket.once('connect_error', onErr);
    });
  }

  private onEvent(e: ServerEvent): void {
    if (e.type === 'presence' && this.snapshot) {
      this.snapshot = { ...this.snapshot, participants: e.participants, pending: e.pending };
    } else if (e.type === 'join-request' && this.snapshot) {
      if (!this.snapshot.pending.some((p) => p.id === e.request.id)) this.snapshot = { ...this.snapshot, pending: [...this.snapshot.pending, e.request] };
    } else if (e.type === 'room-closed') {
      this.setState('closed', e.reason);
    }
    this.emit('evt', e);
  }

  private async reauthenticate(): Promise<void> {
    if (!this.creds) return;
    try {
      const snap = await this.rawCall('room.resume', { roomId: this.creds.roomId, token: this.creds.token });
      this.snapshot = snap;
      this.setState('online');
      this.emit('authenticated', snap, { reconnect: true });
    } catch (err) {
      const e = err as RpcError;
      // Transport errors retry on the next reconnect; definitive rejections end the session.
      if (e.code === 'unauthorized' || e.code === 'expired' || e.code === 'not_found') this.setState('closed', e.message);
    }
  }

  private async rawCall<K extends RpcOp>(op: K, input: RpcInput<K>, timeoutMs = CALL_TIMEOUT_MS): Promise<RpcResults[K]> {
    const socket = this.socket;
    if (!socket || !socket.connected) throw new RpcError('unavailable', 'Not connected to the CodeMeet server');
    const ack = await new Promise<Ack<RpcResults[K]>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RpcError('unavailable', `Server did not answer ${op} in time`)), timeoutMs);
      socket.emit('rpc', { op, input }, (a: Ack<RpcResults[K]>) => {
        clearTimeout(timer);
        resolve(a);
      });
    });
    if (!ack.ok) throw new RpcError(ack.error.code, ack.error.message);
    return ack.data;
  }

  /** Calls an operation on the authenticated session. */
  call<K extends RpcOp>(op: K, input: RpcInput<K>): Promise<RpcResults[K]> {
    if (this.state === 'closed') return Promise.reject(new RpcError('expired', 'Session is closed'));
    return this.rawCall(op, input);
  }

  // ── session establishment ──

  async create(input: RpcInput<'room.create'>): Promise<StoredSession> {
    await this.connect();
    const r = await this.rawCall('room.create', input);
    this.adopt(r.credentials, r.roomId, r.snapshot);
    return this.creds as StoredSession;
  }

  /**
   * Requests access and waits for the host's decision. `onPending` receives the request id so the
   * UI can tell the user who must approve.
   */
  async join(
    input: RpcInput<'room.join'>,
    opts: { onPending?: (requestId: string, expiresAt: number) => void; signal?: AbortSignal } = {},
  ): Promise<StoredSession> {
    await this.connect();
    const req = await this.rawCall('room.join', input);
    opts.onPending?.(req.requestId, req.expiresAt);
    return new Promise<StoredSession>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timeout);
        this.off('evt', onEvt);
        opts.signal?.removeEventListener('abort', onAbort);
        fn();
      };
      const attempt = async () => {
        if (done) return;
        try {
          const r = await this.rawCall('room.claim', { requestId: req.requestId, claimSecret: req.claimSecret });
          if (r.status === 'approved' && r.credentials && r.snapshot) {
            const creds = r.credentials;
            const snap = r.snapshot;
            finish(() => {
              this.adopt(creds, input.roomId, snap);
              resolve(this.creds as StoredSession);
            });
          } else if (r.status === 'rejected') {
            finish(() => reject(new RpcError('forbidden', 'The host declined your request to join')));
          }
        } catch (err) {
          if (err instanceof RpcError && err.code !== 'unavailable') finish(() => reject(err));
        }
      };
      const onEvt = (e: ServerEvent) => {
        if (e.type === 'join-decision' && e.requestId === req.requestId) void attempt();
      };
      const onAbort = () => finish(() => reject(new RpcError('expired', 'Join cancelled')));
      this.on('evt', onEvt);
      opts.signal?.addEventListener('abort', onAbort);
      const poll = setInterval(() => void attempt(), 3_000);
      const timeout = setTimeout(() => finish(() => reject(new RpcError('expired', 'The host did not respond in time'))), Math.max(1_000, req.expiresAt - Date.now()));
    });
  }

  async resume(stored: StoredSession): Promise<void> {
    await this.connect();
    const snap = await this.rawCall('room.resume', { roomId: stored.roomId, token: stored.token });
    this.creds = { ...stored, serverUrl: this.serverUrl };
    this.hadAuth = true;
    this.snapshot = snap;
    this.setState('online');
    this.emit('authenticated', snap, { reconnect: false });
  }

  private adopt(c: Credentials, roomId: string, snap: SessionSnapshot): void {
    this.creds = { serverUrl: this.serverUrl, roomId, memberId: c.memberId, token: c.token };
    this.hadAuth = true;
    this.snapshot = snap;
    this.setState('online');
    this.emit('authenticated', snap, { reconnect: false });
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
    this.removeAllListeners();
    this.state = 'closed';
  }
}
