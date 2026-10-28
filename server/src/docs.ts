import * as Y from 'yjs';
import { LIMITS, RpcError, applyTextDiff, sha256, type ManifestEntry } from '@codemeet/shared';
import type { Db } from './db.js';

interface DocEntry {
  ydoc: Y.Doc;
  /** Upper bound of the UTF-8 size; recomputed exactly when near the limit and on flush. */
  approxBytes: number;
  persistedBytes: number;
  hash: string | null;
  dirty: boolean;
  deleted: boolean;
}

const key = (roomId: string, path: string) => `${roomId}\u0000${path}`;
const REMOTE = Symbol('remote');

/**
 * Authoritative per-file Yjs documents. The server is the only place a document is ever
 * created from plain text, so peers can never seed the same text independently
 * (which would duplicate it when their states merge).
 */
export class DocManager {
  private readonly docs = new Map<string, DocEntry>();
  private readonly roomBytes = new Map<string, number>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private readonly db: Db) {
    this.flushTimer = setInterval(() => void this.flush().catch((e) => console.error('[docs] flush failed:', this.db.redact(String(e)))), 750);
    this.flushTimer.unref();
  }

  private async load(roomId: string, path: string): Promise<DocEntry | null> {
    const k = key(roomId, path);
    const cached = this.docs.get(k);
    if (cached) return cached.deleted ? null : cached;
    const r = await this.db.query<{ state: Buffer; deleted: boolean; size_bytes: number; text_hash: string }>(
      'SELECT state, deleted, size_bytes, text_hash FROM docs WHERE room_id=$1 AND path=$2',
      [roomId, path],
    );
    const row = r.rows[0];
    if (!row || row.deleted) return null;
    // Another request may have loaded it while we awaited.
    const raced = this.docs.get(k);
    if (raced) return raced.deleted ? null : raced;
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(row.state), REMOTE);
    const entry: DocEntry = { ydoc, approxBytes: row.size_bytes, persistedBytes: row.size_bytes, hash: row.text_hash, dirty: false, deleted: false };
    this.docs.set(k, entry);
    return entry;
  }

  private async bytesFor(roomId: string): Promise<number> {
    const cached = this.roomBytes.get(roomId);
    if (cached !== undefined) return cached;
    const r = await this.db.query<{ n: string }>('SELECT COALESCE(SUM(size_bytes),0) AS n FROM docs WHERE room_id=$1 AND NOT deleted', [roomId]);
    const n = Number(r.rows[0]?.n ?? 0);
    this.roomBytes.set(roomId, this.roomBytes.get(roomId) ?? n);
    return this.roomBytes.get(roomId) as number;
  }

  private adjust(roomId: string, delta: number): void {
    this.roomBytes.set(roomId, Math.max(0, (this.roomBytes.get(roomId) ?? 0) + delta));
  }

  private exactBytes(e: DocEntry): number {
    return Buffer.byteLength(e.ydoc.getText('content').toString(), 'utf8');
  }

  async exists(roomId: string, path: string): Promise<boolean> {
    return (await this.load(roomId, path)) !== null;
  }

  async text(roomId: string, path: string): Promise<string | null> {
    const e = await this.load(roomId, path);
    return e ? e.ydoc.getText('content').toString() : null;
  }

  async hash(roomId: string, path: string): Promise<string | null> {
    const e = await this.load(roomId, path);
    if (!e) return null;
    if (e.hash === null) e.hash = sha256(e.ydoc.getText('content').toString());
    return e.hash;
  }

  /** Creates the document from plain text if it does not exist; otherwise returns the existing state. */
  async seed(roomId: string, path: string, content: string): Promise<{ created: boolean; state: Uint8Array; update: Uint8Array | null; hash: string }> {
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS.maxFileBytes) throw new RpcError('too_large', `File exceeds ${LIMITS.maxFileBytes} bytes`);
    const existing = await this.load(roomId, path);
    if (existing) {
      return { created: false, state: Y.encodeStateAsUpdate(existing.ydoc), update: null, hash: (await this.hash(roomId, path)) as string };
    }
    const count = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM docs WHERE room_id=$1 AND NOT deleted', [roomId]);
    if (Number(count.rows[0]?.n ?? 0) >= LIMITS.maxFiles) throw new RpcError('too_large', `Room is limited to ${LIMITS.maxFiles} files`);
    if ((await this.bytesFor(roomId)) + bytes > LIMITS.maxRoomBytes) throw new RpcError('too_large', 'Room storage limit reached');
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, content);
    const entry: DocEntry = { ydoc, approxBytes: bytes, persistedBytes: 0, hash: sha256(content), dirty: true, deleted: false };
    this.docs.set(key(roomId, path), entry);
    this.adjust(roomId, bytes);
    const state = Y.encodeStateAsUpdate(ydoc);
    return { created: true, state, update: state, hash: entry.hash as string };
  }

  async sync(roomId: string, path: string, stateVector: Uint8Array): Promise<{ update: Uint8Array; stateVector: Uint8Array; exists: boolean }> {
    const e = await this.load(roomId, path);
    if (!e) return { update: new Uint8Array(), stateVector: new Uint8Array(), exists: false };
    try {
      return { update: Y.encodeStateAsUpdate(e.ydoc, stateVector), stateVector: Y.encodeStateVector(e.ydoc), exists: true };
    } catch {
      throw new RpcError('invalid', 'Malformed state vector');
    }
  }

  async applyUpdate(roomId: string, path: string, update: Uint8Array): Promise<void> {
    if (update.length > LIMITS.maxUpdateBytes) throw new RpcError('too_large', 'Update too large');
    const e = await this.load(roomId, path);
    if (!e) throw new RpcError('not_found', 'No such shared file');
    if ((await this.bytesFor(roomId)) + update.length > LIMITS.maxRoomBytes) throw new RpcError('too_large', 'Room storage limit reached');
    if (e.approxBytes + update.length > LIMITS.maxFileBytes) {
      e.approxBytes = this.exactBytes(e);
      if (e.approxBytes + update.length > LIMITS.maxFileBytes) {
        // Could exceed the cap: apply to a throwaway copy first and measure.
        const probe = new Y.Doc();
        try {
          Y.applyUpdate(probe, Y.encodeStateAsUpdate(e.ydoc));
          Y.applyUpdate(probe, update);
        } catch {
          throw new RpcError('invalid', 'Malformed document update');
        }
        const exact = Buffer.byteLength(probe.getText('content').toString(), 'utf8');
        probe.destroy();
        if (exact > LIMITS.maxFileBytes) throw new RpcError('too_large', `File would exceed ${LIMITS.maxFileBytes} bytes`);
      }
    }
    try {
      Y.applyUpdate(e.ydoc, update, REMOTE);
    } catch {
      throw new RpcError('invalid', 'Malformed document update');
    }
    e.approxBytes += update.length;
    this.adjust(roomId, update.length);
    e.hash = null;
    e.dirty = true;
  }

  /** Replaces the text of an existing document (used when a proposal is applied). Returns the Yjs delta. */
  async replaceText(roomId: string, path: string, next: string): Promise<Uint8Array> {
    const e = await this.load(roomId, path);
    if (!e) throw new RpcError('not_found', 'No such shared file');
    const before = Y.encodeStateVector(e.ydoc);
    applyTextDiff(e.ydoc.getText('content'), next);
    const update = Y.encodeStateAsUpdate(e.ydoc, before);
    e.approxBytes = this.exactBytes(e);
    e.hash = null;
    e.dirty = true;
    return update;
  }

  async remove(roomId: string, path: string): Promise<void> {
    const e = await this.load(roomId, path);
    if (!e) throw new RpcError('not_found', 'No such shared file');
    e.deleted = true;
    e.dirty = true;
    this.adjust(roomId, -e.approxBytes);
    await this.flush();
    this.docs.delete(key(roomId, path));
  }

  async rename(roomId: string, from: string, to: string): Promise<void> {
    const e = await this.load(roomId, from);
    if (!e) throw new RpcError('not_found', 'No such shared file');
    if (await this.exists(roomId, to)) throw new RpcError('conflict', 'Destination already exists');
    // A rename keeps history: the document moves to the new key and the old row is tombstoned.
    const state = Y.encodeStateAsUpdate(e.ydoc);
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state, REMOTE);
    this.docs.set(key(roomId, to), { ...e, ydoc, dirty: true, persistedBytes: 0, deleted: false });
    e.deleted = true;
    e.dirty = true;
    await this.flush();
    this.docs.delete(key(roomId, from));
  }

  async manifest(roomId: string): Promise<ManifestEntry[]> {
    await this.flush();
    const r = await this.db.query<{ path: string; text_hash: string; size_bytes: number }>(
      'SELECT path, text_hash, size_bytes FROM docs WHERE room_id=$1 AND NOT deleted ORDER BY path',
      [roomId],
    );
    return r.rows.map((x) => ({ path: x.path, hash: x.text_hash, size: x.size_bytes }));
  }

  /** Writes dirty documents to PostgreSQL. Safe to call concurrently; calls are serialized. */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    for (const [k, e] of [...this.docs]) {
      if (!e.dirty) continue;
      const [roomId, path] = k.split('\u0000') as [string, string];
      const text = e.ydoc.getText('content').toString();
      const size = Buffer.byteLength(text, 'utf8');
      const hash = sha256(text);
      e.dirty = false; // new edits during the await re-dirty the entry
      try {
        await this.db.query(
          `INSERT INTO docs (room_id, path, state, text_hash, size_bytes, deleted, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,now())
           ON CONFLICT (room_id, path) DO UPDATE SET state=EXCLUDED.state, text_hash=EXCLUDED.text_hash,
             size_bytes=EXCLUDED.size_bytes, deleted=EXCLUDED.deleted, updated_at=now()`,
          [roomId, path, Buffer.from(Y.encodeStateAsUpdate(e.ydoc)), hash, size, e.deleted],
        );
        // The room counter holds approxBytes for this doc; correct it to the exact size.
        if (!e.deleted) this.adjust(roomId, size - e.approxBytes);
        e.persistedBytes = size;
        e.approxBytes = size;
        e.hash = hash;
      } catch (err) {
        e.dirty = true;
        throw err;
      }
    }
  }

  /** Drops in-memory state for a room (after it closes). Persisted rows stay until retention purge. */
  async evictRoom(roomId: string): Promise<void> {
    await this.flush().catch(() => undefined);
    for (const k of [...this.docs.keys()]) if (k.startsWith(roomId + '\u0000')) this.docs.delete(k);
    this.roomBytes.delete(roomId);
  }

  async close(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
    this.docs.clear();
  }
}
