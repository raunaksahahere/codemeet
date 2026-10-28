import { promises as fs, constants as fsc } from 'node:fs';
import * as path from 'node:path';
import { LIMITS, SharingPolicy, normalizeRelPath } from '@codemeet/shared';

export type ReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'skipped'; reason: string };

export interface ListResult {
  files: string[];
  skipped: { path: string; reason: string }[];
}

/**
 * Everything the sync engine needs from the local machine. The CLI implements it with the
 * filesystem; the VS Code extension wraps it so open editor buffers win over disk content.
 */
export interface Workspace {
  readonly root: string;
  list(): Promise<ListResult>;
  read(relPath: string): Promise<ReadResult>;
  write(relPath: string, text: string): Promise<void>;
  /** Removes a file recoverably (moved under .codemeet/trash). */
  trash(relPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Saves a copy of local content before it is replaced by the shared baseline. */
  backup(relPath: string, text: string, stamp: string): Promise<string>;
}

export class UnsafePathError extends Error {}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function decodeText(buf: Buffer): string | null {
  if (buf.length > LIMITS.maxFileBytes) return null;
  const sample = buf.subarray(0, 8000);
  if (sample.includes(0)) return null;
  const text = buf.toString('utf8');
  // Invalid UTF-8 decodes to U+FFFD; such files would be corrupted by a text CRDT.
  if (text.includes('�') && !buf.includes(Buffer.from('�'))) return null;
  return text;
}

export class NodeWorkspace implements Workspace {
  private realRoot: string | null = null;

  constructor(
    readonly root: string,
    private readonly policy: SharingPolicy,
  ) {}

  private async real(): Promise<string> {
    if (!this.realRoot) this.realRoot = await fs.realpath(this.root);
    return this.realRoot;
  }

  /**
   * Resolves a canonical shared path to an absolute path while proving it stays inside the
   * project: no traversal, no symlinked ancestors that point outside, no symlink at the target.
   */
  async resolve(rel: string, opts: { allowMissing?: boolean } = {}): Promise<string> {
    const p = normalizeRelPath(rel);
    if (!p) throw new UnsafePathError(`Unsafe path: ${JSON.stringify(rel)}`);
    const policy = this.policy.check(p);
    if (!policy.ok) throw new UnsafePathError(`${p}: ${policy.reason}`);
    const root = await this.real();
    const abs = path.resolve(root, ...p.split('/'));
    if (!isWithin(root, abs)) throw new UnsafePathError(`Path escapes the project: ${p}`);
    // Walk up to the nearest existing ancestor and make sure its real location is inside the root.
    let probe = abs;
    for (;;) {
      try {
        const st = await fs.lstat(probe);
        if (probe === abs && st.isSymbolicLink()) throw new UnsafePathError(`Refusing to follow symlink: ${p}`);
        const realProbe = await fs.realpath(probe);
        if (!isWithin(root, realProbe)) throw new UnsafePathError(`Symlink escapes the project: ${p}`);
        break;
      } catch (err) {
        if (err instanceof UnsafePathError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        if (probe === abs && !opts.allowMissing) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) throw new UnsafePathError(`Cannot resolve ${p}`);
        probe = parent;
      }
    }
    return abs;
  }

  async list(): Promise<ListResult> {
    const files: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const root = await this.real();
    const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) {
          if (this.policy.allows(rel)) skipped.push({ path: rel, reason: 'symlink' });
          continue;
        }
        if (e.isDirectory()) {
          if (this.policy.pruneDir(rel)) continue;
          await walk(path.join(dirAbs, e.name), rel);
        } else if (e.isFile()) {
          if (!this.policy.allows(rel)) continue;
          const st = await fs.stat(path.join(dirAbs, e.name));
          if (st.size > LIMITS.maxFileBytes) {
            skipped.push({ path: rel, reason: `larger than ${LIMITS.maxFileBytes} bytes` });
            continue;
          }
          files.push(rel);
        }
      }
    };
    await walk(root, '');
    files.sort();
    return { files, skipped };
  }

  async read(rel: string): Promise<ReadResult> {
    let abs: string;
    try {
      abs = await this.resolve(rel);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      if (err instanceof UnsafePathError) return { kind: 'skipped', reason: err.message };
      throw err;
    }
    try {
      const fh = await fs.open(abs, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      try {
        const st = await fh.stat();
        if (!st.isFile()) return { kind: 'skipped', reason: 'not a regular file' };
        if (st.size > LIMITS.maxFileBytes) return { kind: 'skipped', reason: `larger than ${LIMITS.maxFileBytes} bytes` };
        const buf = await fh.readFile();
        const text = decodeText(buf);
        return text === null ? { kind: 'skipped', reason: 'binary or non-UTF-8 file' } : { kind: 'text', text };
      } finally {
        await fh.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { kind: 'missing' };
      if (code === 'ELOOP') return { kind: 'skipped', reason: 'symlink' };
      throw err;
    }
  }

  async write(rel: string, text: string): Promise<void> {
    const abs = await this.resolve(rel, { allowMissing: true });
    await fs.mkdir(path.dirname(abs), { recursive: true });
    // Re-validate after creating directories (an ancestor could have been swapped for a symlink).
    await this.resolve(rel, { allowMissing: true });
    let mode: number | undefined;
    try {
      mode = (await fs.stat(abs)).mode & 0o777;
    } catch {
      mode = undefined;
    }
    const tmp = `${abs}.codemeet-${process.pid}-${Date.now()}.tmp`;
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: mode ?? 0o644, flag: 'wx' });
    try {
      await fs.rename(tmp, abs);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  private async sideDir(kind: 'trash' | 'backups', stamp: string): Promise<string> {
    const base = path.join(await this.real(), '.codemeet');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, '.gitignore'), '*\n', { flag: 'w' }).catch(() => undefined);
    const dir = path.join(base, kind, stamp);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async trash(rel: string): Promise<void> {
    const abs = await this.resolve(rel).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    });
    if (!abs) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(await this.sideDir('trash', stamp), ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(abs, dest);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = await this.resolve(from);
    const dst = await this.resolve(to, { allowMissing: true });
    try {
      await fs.access(dst);
      throw new UnsafePathError(`Rename target already exists: ${to}`);
    } catch (err) {
      if (err instanceof UnsafePathError) throw err;
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await this.resolve(to, { allowMissing: true });
    await fs.rename(src, dst);
  }

  async backup(rel: string, text: string, stamp: string): Promise<string> {
    const dest = path.join(await this.sideDir('backups', stamp), ...rel.split('/'));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, text, 'utf8');
    return dest;
  }
}
