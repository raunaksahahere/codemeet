import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { StateStore } from './docsync.js';

/** Persists each document's CRDT state under <project>/.codemeet/state/<room>/. */
export class FileStateStore implements StateStore {
  private readonly dir: string;
  constructor(projectRoot: string, roomId: string) {
    this.dir = path.join(projectRoot, '.codemeet', 'state', roomId.replace(/[^A-Za-z0-9_-]/g, '_'));
  }
  private file(p: string): string {
    return path.join(this.dir, createHash('sha256').update(p).digest('hex').slice(0, 40));
  }
  async loadAll(): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    let names: string[];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!n.endsWith('.bin')) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, n));
        const len = raw.readUInt32BE(0);
        const rel = raw.subarray(4, 4 + len).toString('utf8');
        out.set(rel, new Uint8Array(raw.subarray(4 + len)));
      } catch {
        /* corrupt entry: the server copy will repopulate it */
      }
    }
    return out;
  }
  async save(p: string, state: Uint8Array): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const name = Buffer.from(p, 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(name.length, 0);
    const target = this.file(p) + '.bin';
    const tmp = target + '.tmp';
    await fs.writeFile(tmp, Buffer.concat([head, name, Buffer.from(state)]));
    await fs.rename(tmp, target);
  }
  async remove(p: string): Promise<void> {
    await fs.rm(this.file(p) + '.bin', { force: true });
  }
}
