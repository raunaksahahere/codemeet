import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { DENIED_DIR_NAMES, sha256, type SharingPolicy } from '@codemeet/shared';
import type { DocSync } from '@codemeet/core';

/**
 * Feeds on-disk changes (editors, AI tools, shell commands) into DocSync. The sync engine
 * compares content, so events caused by CodeMeet's own writes are harmless no-ops.
 */
export function watchProject(root: string, _policy: SharingPolicy, sync: DocSync, onError: (e: Error) => void): { close(): Promise<void> } {
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const watcher: FSWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    persistent: true,
    followSymlinks: false,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
    // Pruning is only a performance hint; DocSync re-checks the full policy on every event.
    ignored: (abs: string) => {
      const r = rel(abs);
      return r.startsWith('..') || r.split('/').some((seg) => DENIED_DIR_NAMES.has(seg));
    },
  });

  /** A deletion is held back briefly so a matching creation can be recognized as a rename. */
  const pendingDeletes = new Map<string, { hash: string | null; timer: ReturnType<typeof setTimeout> }>();

  watcher.on('add', (abs) => {
    const p = rel(abs);
    void (async () => {
      for (const [from, d] of pendingDeletes) {
        if (!d.hash) continue;
        const text = await readText(abs);
        if (text !== null && sha256(text) === d.hash) {
          clearTimeout(d.timer);
          pendingDeletes.delete(from);
          await sync.localRenamed(from, p);
          return;
        }
      }
      await sync.localChanged(p);
    })().catch(onError);
  });
  watcher.on('change', (abs) => void sync.localChanged(rel(abs)).catch(onError));
  watcher.on('unlink', (abs) => {
    const p = rel(abs);
    const text = sync.text(p);
    const timer = setTimeout(() => {
      pendingDeletes.delete(p);
      void sync.localChanged(p).catch(onError);
    }, 400);
    pendingDeletes.set(p, { hash: text === null ? null : sha256(text), timer });
  });
  watcher.on('error', (e) => onError(e as Error));

  return {
    async close() {
      for (const d of pendingDeletes.values()) clearTimeout(d.timer);
      pendingDeletes.clear();
      await watcher.close();
    },
  };
}

async function readText(abs: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(abs, 'utf8');
  } catch {
    return null;
  }
}
