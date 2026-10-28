import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ensurePrivateDir, files, homeDir, readJson, writePrivate } from './home.js';

/** Unix socket paths are limited to ~100 bytes; fall back to a short private directory when needed. */
function socketPath(): string {
  const preferred = files.socket();
  if (Buffer.byteLength(preferred) < 96) return preferred;
  const dir = path.join(tmpdir(), `cm-${process.getuid?.() ?? 'u'}-${createHash('sha256').update(homeDir()).digest('hex').slice(0, 8)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  ensurePrivateDir(dir);
  return path.join(dir, 'd.sock');
}

/**
 * Local control channel between short-lived CLI commands and the long-lived session daemon.
 *
 * - POSIX: a Unix domain socket inside the 0700 CodeMeet home directory.
 * - Windows: a TCP listener bound to 127.0.0.1 only.
 * - Either way every connection must present the random token stored in the 0600 daemon.json.
 */
export interface DaemonInfo {
  pid: number;
  token: string;
  /** Unix socket path, or "127.0.0.1:PORT". */
  endpoint: string;
  startedAt: number;
}

export interface IpcRequest {
  id: number;
  method: string;
  params?: unknown;
}
export type IpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type IpcHandler = (method: string, params: unknown, ctx: { push: (event: unknown) => void; subscribe: () => void; close: () => void }) => Promise<unknown>;

function tokenEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface IpcServer {
  info: DaemonInfo;
  broadcast(event: unknown): void;
  close(): Promise<void>;
}

export async function startIpcServer(handler: IpcHandler): Promise<IpcServer> {
  const token = randomBytes(32).toString('base64url');
  const subscribers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    let authed = false;
    const authTimer = setTimeout(() => !authed && socket.destroy(), 3000);
    const write = (o: unknown) => !socket.destroyed && socket.write(JSON.stringify(o) + '\n');
    socket.on('close', () => subscribers.delete(socket));
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 4_000_000) {
        socket.destroy();
        return;
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { auth?: string } & Partial<IpcRequest>;
        try {
          msg = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          if (typeof msg.auth === 'string' && tokenEqual(msg.auth, token)) {
            authed = true;
            clearTimeout(authTimer);
            write({ id: 0, ok: true, result: 'authenticated' });
          } else {
            socket.destroy();
            return;
          }
          continue;
        }
        if (typeof msg.id !== 'number' || typeof msg.method !== 'string') continue;
        const id = msg.id;
        handler(msg.method, msg.params, {
          push: (event) => write({ event }),
          subscribe: () => subscribers.add(socket),
          close: () => socket.end(),
        })
          .then((result) => write({ id, ok: true, result } satisfies IpcResponse))
          .catch((err: Error) => write({ id, ok: false, error: err.message } satisfies IpcResponse));
      }
    });
  });

  const isWin = process.platform === 'win32';
  const sock = socketPath();
  if (!isWin && existsSync(sock)) rmSync(sock, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (isWin) server.listen(0, '127.0.0.1', () => resolve());
    else server.listen(sock, () => resolve());
  });
  let endpoint = sock;
  if (isWin) endpoint = `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  else {
    const { chmodSync } = await import('node:fs');
    chmodSync(sock, 0o600);
  }
  const info: DaemonInfo = { pid: process.pid, token, endpoint, startedAt: Date.now() };
  writePrivate(files.daemon(), JSON.stringify(info));
  return {
    info,
    broadcast(event) {
      const line = JSON.stringify({ event }) + '\n';
      for (const s of subscribers) if (!s.destroyed) s.write(line);
    },
    async close() {
      for (const s of subscribers) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(files.daemon(), { force: true });
      if (!isWin) rmSync(sock, { force: true });
    },
  };
}

export function readDaemonInfo(): DaemonInfo | null {
  const info = readJson<DaemonInfo>(files.daemon());
  if (!info) return null;
  try {
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null; // stale file from a crashed daemon
  }
}

export class IpcClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onEvent: (event: unknown) => void = () => undefined;

  static async connect(info: DaemonInfo): Promise<IpcClient> {
    const c = new IpcClient();
    await c.open(info);
    return c;
  }

  private open(info: DaemonInfo): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = info.endpoint.startsWith('127.0.0.1:')
        ? net.connect({ host: '127.0.0.1', port: Number(info.endpoint.split(':')[1]) })
        : net.connect(info.endpoint);
      this.socket = socket;
      socket.setEncoding('utf8');
      let buf = '';
      let ready = false;
      socket.on('error', (e) => (ready ? undefined : reject(e)));
      socket.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('Daemon connection closed'));
        this.pending.clear();
      });
      socket.on('connect', () => socket.write(JSON.stringify({ auth: info.token }) + '\n'));
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          const msg = JSON.parse(line) as { id?: number; ok?: boolean; result?: unknown; error?: string; event?: unknown };
          if (!ready && msg.id === 0) {
            ready = true;
            resolve();
          } else if ('event' in msg) this.onEvent(msg.event);
          else if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (p) msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
          }
        }
      });
    });
  }

  call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Daemon did not answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.socket?.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  close(): void {
    this.socket?.destroy();
  }
}

/** Connects to the running daemon or throws an actionable error. */
export async function connectDaemon(): Promise<IpcClient> {
  const info = readDaemonInfo();
  if (!info) throw new Error('No active CodeMeet session. Start one with `codemeet room create` or `codemeet room join`.');
  try {
    return await IpcClient.connect(info);
  } catch (err) {
    throw new Error(`Cannot reach the CodeMeet session daemon (${(err as Error).message}). Try \`codemeet leave\` and start again.`);
  }
}
