import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { LIMITS, LOCAL_ORIGIN, RpcError, SharingPolicy, applyTextDiff, normalizeRelPath, sha256, type ManifestEntry, type ServerEvent } from '@codemeet/shared';
import type { Session } from './session.js';
import type { Workspace } from './workspace.js';

const REMOTE = Symbol('remote');

export interface SyncReport {
  uploaded: string[];
  downloaded: string[];
  unchanged: string[];
  skipped: { path: string; reason: string }[];
  /** Local files that differ from the shared baseline. Nothing is overwritten until accepted. */
  conflicts: { path: string; localHash: string; remoteHash: string }[];
  /** Local files that exist only here; they stay private until explicitly shared. */
  localOnly: string[];
  backupDir?: string;
}

export interface DocSyncEvents {
  log: [string];
  /** A shared file changed on disk because of a remote participant. */
  remoteChange: [{ path: string; by: string; kind: 'update' | 'create' | 'delete' | 'rename' }];
  skipped: [{ path: string; reason: string }];
}

interface Doc {
  ydoc: Y.Doc;
  path: string;
}

/**
 * Optional persistence of each document's CRDT state on this machine. With it, a restarted
 * client can tell "I edited this offline" from "this is stale", so restarting never reverts
 * a coworker's newer changes.
 */
export interface StateStore {
  loadAll(): Promise<Map<string, Uint8Array>>;
  save(path: string, state: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * Keeps local files and the server's authoritative Yjs documents in step.
 *
 * Key invariants:
 *  - Only the server creates a document from plain text; clients always start from server state.
 *  - Local changes are detected by comparing content with the CRDT text, so writes we make
 *    ourselves are no-ops when the file watcher / editor reports them back. No timers.
 *  - All work for one path runs through a queue so reads, merges and writes never interleave.
 */
export class DocSync extends EventEmitter {
  private readonly docs = new Map<string, Doc>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly privateLocal = new Set<string>();
  private readonly onSessionEvent = (e: ServerEvent) => this.handleEvent(e);
  private readonly onAuth = (_s: unknown, info: { reconnect: boolean }) => {
    if (info.reconnect) void this.resync().catch((e) => this.log(`resync failed: ${(e as Error).message}`));
  };
  private started = false;

  constructor(
    private readonly session: Session,
    private readonly workspace: Workspace,
    private readonly policy: SharingPolicy,
    private readonly store?: StateStore,
  ) {
    super();
  }

  private readonly dirtyState = new Set<string>();
  private stateTimer: ReturnType<typeof setTimeout> | null = null;

  private markState(path: string): void {
    if (!this.store) return;
    this.dirtyState.add(path);
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.flushState();
    }, 400);
    this.stateTimer.unref?.();
  }

  /** Writes pending CRDT state to the local store. */
  async flushState(): Promise<void> {
    if (!this.store) return;
    const paths = [...this.dirtyState];
    this.dirtyState.clear();
    for (const p of paths) {
      const doc = this.docs.get(p);
      if (doc) await this.store.save(p, Y.encodeStateAsUpdate(doc.ydoc)).catch((e: Error) => this.log(`could not persist state for ${p}: ${e.message}`));
    }
  }

  /**
   * Reloads persisted documents after a restart. Call before {@link resync}; offline edits are
   * then detected against the persisted state and merged with the server's CRDT history.
   */
  async restore(): Promise<number> {
    this.attachListeners();
    if (!this.store) return 0;
    const saved = await this.store.loadAll();
    for (const [path, state] of saved) {
      if (!this.acceptInbound(path)) continue;
      this.adoptState(path, state);
    }
    return saved.size;
  }

  override on<K extends keyof DocSyncEvents>(event: K, listener: (...args: DocSyncEvents[K]) => void): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }

  private log(line: string): void {
    this.emit('log', line);
  }

  get trackedPaths(): string[] {
    return [...this.docs.keys()];
  }

  has(path: string): boolean {
    return this.docs.has(path);
  }

  text(path: string): string | null {
    return this.docs.get(path)?.ydoc.getText('content').toString() ?? null;
  }

  private attachListeners(): void {
    if (this.started) return; // idempotent: never register twice
    this.started = true;
    this.session.on('evt', this.onSessionEvent);
    this.session.on('authenticated', this.onAuth as never);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    // Best effort; callers that need durability await flushState() first.
    for (const p of this.dirtyState) {
      const doc = this.docs.get(p);
      if (doc && this.store) void this.store.save(p, Y.encodeStateAsUpdate(doc.ydoc)).catch(() => undefined);
    }
    this.dirtyState.clear();
    this.session.off('evt', this.onSessionEvent);
    this.session.off('authenticated', this.onAuth as never);
    for (const d of this.docs.values()) d.ydoc.destroy();
    this.docs.clear();
    this.queues.clear();
    this.privateLocal.clear();
  }

  // ── bootstrap ──

  /** Host: uploads the project as the authoritative baseline. */
  async publishBaseline(): Promise<SyncReport> {
    this.attachListeners();
    const report = emptyReport();
    const { files, skipped } = await this.workspace.list();
    report.skipped.push(...skipped);
    for (const rel of files) {
      const r = await this.workspace.read(rel);
      if (r.kind !== 'text') {
        if (r.kind === 'skipped') report.skipped.push({ path: rel, reason: r.reason });
        continue;
      }
      try {
        const res = await this.session.call('doc.seed', { path: rel, content: r.text });
        this.adoptState(rel, res.state);
        report.uploaded.push(rel);
      } catch (err) {
        if (err instanceof RpcError && (err.code === 'forbidden' || err.code === 'too_large')) report.skipped.push({ path: rel, reason: err.message });
        else throw err;
      }
    }
    return report;
  }

  /**
   * Guest: pulls the shared baseline. Without `acceptBaseline`, differing local files are only
   * reported. With it, each is backed up first and then replaced.
   */
  async pullBaseline(opts: { acceptBaseline?: boolean } = {}): Promise<SyncReport> {
    const report = emptyReport();
    const { files: manifest } = await this.session.call('doc.list', {});
    const remote = new Map<string, ManifestEntry>(manifest.map((m) => [m.path, m]));
    const local = await this.workspace.list();
    report.skipped.push(...local.skipped);
    const toWrite: string[] = [];
    for (const entry of manifest) {
      const safe = this.acceptInbound(entry.path);
      if (!safe) {
        report.skipped.push({ path: entry.path, reason: 'rejected by sharing policy' });
        continue;
      }
      const r = await this.workspace.read(entry.path);
      if (r.kind === 'missing') toWrite.push(entry.path);
      else if (r.kind === 'text' && sha256(r.text) === entry.hash) report.unchanged.push(entry.path);
      else if (r.kind === 'text') report.conflicts.push({ path: entry.path, localHash: sha256(r.text), remoteHash: entry.hash });
      else report.skipped.push({ path: entry.path, reason: r.reason });
    }
    report.localOnly = local.files.filter((f) => !remote.has(f));
    for (const f of report.localOnly) this.privateLocal.add(f);
    if (report.conflicts.length && !opts.acceptBaseline) return report; // caller decides; nothing touched

    this.attachListeners();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const c of report.conflicts) {
      const r = await this.workspace.read(c.path);
      if (r.kind === 'text') report.backupDir = await this.workspace.backup(c.path, r.text, stamp);
    }
    const fetch = [...toWrite, ...report.unchanged, ...report.conflicts.map((c) => c.path)];
    for (const rel of fetch) {
      await this.fetchAndMaterialize(rel);
      if (toWrite.includes(rel) || report.conflicts.some((c) => c.path === rel)) report.downloaded.push(rel);
    }
    return report;
  }

  /** Marks a local-only file as shared and uploads it. */
  async share(path: string): Promise<void> {
    this.privateLocal.delete(path);
    await this.localChanged(path);
  }

  private acceptInbound(path: string): string | null {
    const p = normalizeRelPath(path);
    if (!p || !this.policy.allows(p)) return null;
    return p;
  }

  /** Creates the in-memory doc from server state and writes the file if it differs. */
  private async fetchAndMaterialize(path: string): Promise<void> {
    await this.enqueue(path, async () => {
      const res = await this.session.call('doc.sync', { path, stateVector: new Uint8Array(Y.encodeStateVector(new Y.Doc())) });
      if (!res.exists) return;
      const doc = this.adoptState(path, res.update);
      const text = doc.ydoc.getText('content').toString();
      const local = await this.workspace.read(path);
      if (local.kind !== 'text' || local.text !== text) await this.workspace.write(path, text);
    });
  }

  private adoptState(path: string, state: Uint8Array): Doc {
    let doc = this.docs.get(path);
    if (!doc) {
      doc = this.createDoc(path);
    }
    Y.applyUpdate(doc.ydoc, state, REMOTE);
    return doc;
  }

  private createDoc(path: string): Doc {
    const ydoc = new Y.Doc();
    const doc: Doc = { ydoc, path };
    ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      this.markState(path);
      if (origin === REMOTE) return;
      this.session.call('doc.update', { path, update }).catch((err: Error) => {
        // Not lost: the CRDT keeps the change and resync() sends it after reconnect.
        this.log(`update for ${path} not delivered yet (${err.message}); will retry on reconnect`);
      });
    });
    this.docs.set(path, doc);
    return doc;
  }

  // ── per-path serialization ──

  private enqueue(path: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.queues.get(path) ?? Promise.resolve();
    const next = prev.then(fn).catch((err: Error) => {
      this.log(`sync error on ${path}: ${err.message}`);
    });
    this.queues.set(path, next);
    void next.finally(() => {
      if (this.queues.get(path) === next) this.queues.delete(path);
    });
    return next;
  }

  /** Waits until all queued work has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  // ── local → shared ──

  /** Call whenever a local file (or editor buffer) may have changed. Cheap and idempotent. */
  localChanged(path: string): Promise<void> {
    const p = this.acceptInbound(path);
    if (!p) return Promise.resolve();
    if (this.privateLocal.has(p)) return Promise.resolve();
    return this.enqueue(p, async () => {
      const r = await this.workspace.read(p);
      const existing = this.docs.get(p);
      if (r.kind === 'missing') {
        if (existing) await this.pushDelete(p);
        return;
      }
      if (r.kind === 'skipped') {
        if (existing) this.log(`${p} is no longer shareable (${r.reason}); keeping the shared copy unchanged`);
        this.emit('skipped', { path: p, reason: r.reason });
        return;
      }
      if (!existing) {
        const res = await this.session.call('doc.seed', { path: p, content: r.text });
        const doc = this.adoptState(p, res.state);
        // If it already existed remotely, fold our version in as an ordinary edit.
        applyTextDiff(doc.ydoc.getText('content'), r.text);
        return;
      }
      applyTextDiff(existing.ydoc.getText('content'), r.text); // no-op when content is identical
    });
  }

  private async pushDelete(path: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    this.docs.delete(path);
    doc.ydoc.destroy();
    await this.store?.remove(path).catch(() => undefined);
    await this.session.call('doc.delete', { path }).catch((err: Error) => this.log(`delete of ${path} not delivered: ${err.message}`));
  }

  /** Call when the user renames a file locally and the platform reports it as one operation. */
  async localRenamed(from: string, to: string): Promise<void> {
    const a = this.acceptInbound(from);
    const b = this.acceptInbound(to);
    if (!a || !b || !this.docs.has(a)) {
      if (b) await this.localChanged(b);
      if (a) await this.localChanged(a);
      return;
    }
    await this.enqueue(a, async () => {
      const doc = this.docs.get(a);
      if (!doc) return;
      try {
        await this.session.call('doc.rename', { from: a, to: b });
        this.docs.delete(a);
        doc.path = b;
        this.docs.set(b, doc);
      } catch (err) {
        this.log(`rename ${a} -> ${b} not shared (${(err as Error).message}); treating as delete + create`);
        await this.pushDelete(a);
        await this.localChanged(b);
      }
    });
  }

  // ── shared → local ──

  private handleEvent(e: ServerEvent): void {
    switch (e.type) {
      case 'doc-created':
      case 'doc-update':
        void this.onRemoteUpdate(e.path, e.update, e.by, e.type === 'doc-created');
        break;
      case 'doc-deleted':
        void this.onRemoteDelete(e.path, e.by);
        break;
      case 'doc-renamed':
        void this.onRemoteRename(e.from, e.to, e.by);
        break;
      default:
        break;
    }
  }

  private onRemoteUpdate(rawPath: string, update: Uint8Array, by: string, created: boolean): Promise<void> {
    const p = this.acceptInbound(rawPath);
    if (!p) {
      this.log(`ignored remote update for disallowed path ${JSON.stringify(rawPath)}`);
      return Promise.resolve();
    }
    return this.enqueue(p, async () => {
      let doc = this.docs.get(p);
      if (!doc) {
        // A file we have not seen (created after we joined, or an update we missed): get full state.
        doc = this.createDoc(p);
        const res = await this.session.call('doc.sync', { path: p, stateVector: Y.encodeStateVector(doc.ydoc) });
        if (!res.exists) {
          this.docs.delete(p);
          doc.ydoc.destroy();
          return;
        }
        Y.applyUpdate(doc.ydoc, res.update, REMOTE);
      } else {
        // Fold any not-yet-seen local edit into the CRDT before applying the remote change.
        const local = await this.workspace.read(p);
        if (local.kind === 'text') applyTextDiff(doc.ydoc.getText('content'), local.text);
        Y.applyUpdate(doc.ydoc, update, REMOTE);
      }
      const text = doc.ydoc.getText('content').toString();
      const now = await this.workspace.read(p);
      if (now.kind !== 'text' || now.text !== text) {
        await this.workspace.write(p, text);
        this.emit('remoteChange', { path: p, by, kind: created ? 'create' : 'update' });
      }
    });
  }

  private onRemoteDelete(rawPath: string, by: string): Promise<void> {
    const p = this.acceptInbound(rawPath);
    if (!p) return Promise.resolve();
    return this.enqueue(p, async () => {
      const doc = this.docs.get(p);
      this.docs.delete(p);
      doc?.ydoc.destroy();
      await this.store?.remove(p).catch(() => undefined);
      await this.workspace.trash(p);
      this.emit('remoteChange', { path: p, by, kind: 'delete' });
    });
  }

  private async onRemoteRename(rawFrom: string, rawTo: string, by: string): Promise<void> {
    const from = this.acceptInbound(rawFrom);
    const to = this.acceptInbound(rawTo);
    if (!from || !to) return;
    await this.enqueue(from, async () => {
      const doc = this.docs.get(from);
      if (!doc) {
        await this.fetchAndMaterialize(to);
        return;
      }
      this.docs.delete(from);
      doc.path = to;
      this.docs.set(to, doc);
      await this.workspace.rename(from, to).catch(async () => {
        await this.workspace.write(to, doc.ydoc.getText('content').toString());
        await this.workspace.trash(from);
      });
      this.emit('remoteChange', { path: to, by, kind: 'rename' });
    });
  }

  // ── reconnect ──

  /** Re-aligns every document after a reconnect or server restart, in both directions. */
  async resync(): Promise<void> {
    const { files } = await this.session.call('doc.list', {});
    const remote = new Set(files.map((f) => f.path));
    for (const path of [...this.docs.keys()]) {
      if (!remote.has(path)) {
        // Deleted while we were away: recoverable removal, never a silent unlink.
        await this.onRemoteDelete(path, 'server');
        continue;
      }
      await this.enqueue(path, async () => {
        const doc = this.docs.get(path);
        if (!doc) return;
        const local = await this.workspace.read(path);
        if (local.kind === 'missing') {
          await this.pushDelete(path); // deleted locally while we were away
          return;
        }
        if (local.kind === 'text') applyTextDiff(doc.ydoc.getText('content'), local.text);
        const res = await this.session.call('doc.sync', { path, stateVector: Y.encodeStateVector(doc.ydoc) });
        if (res.exists) {
          Y.applyUpdate(doc.ydoc, res.update, REMOTE);
          // Send what the server is missing (edits made while offline).
          const missing = Y.encodeStateAsUpdate(doc.ydoc, res.stateVector);
          if (missing.length > 2) await this.session.call('doc.update', { path, update: missing });
          const text = doc.ydoc.getText('content').toString();
          const now = await this.workspace.read(path);
          if (now.kind !== 'text' || now.text !== text) await this.workspace.write(path, text);
        }
      });
    }
    for (const path of remote) {
      if (!this.docs.has(path) && this.acceptInbound(path) && !this.privateLocal.has(path)) await this.fetchAndMaterialize(path);
    }
  }

  /** Re-scans the project and reconciles every shareable file (used after missed watcher events). */
  async reconcileAll(): Promise<void> {
    const { files } = await this.workspace.list();
    await Promise.all([...new Set([...files, ...this.docs.keys()])].map((f) => this.localChanged(f)));
  }
}

function emptyReport(): SyncReport {
  return { uploaded: [], downloaded: [], unchanged: [], skipped: [], conflicts: [], localOnly: [] };
}

export { LIMITS, LOCAL_ORIGIN };
