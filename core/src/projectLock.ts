import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

export interface LockInfo {
  pid: number;
  kind: 'cli' | 'extension';
  roomId: string;
}

/**
 * One process at a time may sync a given project folder (the CLI daemon or the VS Code
 * extension). That keeps a single authoritative local event path per project.
 */
export function lockPath(projectRoot: string): string {
  return path.join(projectRoot, '.codemeet', 'owner.lock');
}

export function readLock(projectRoot: string): LockInfo | null {
  try {
    const info = JSON.parse(readFileSync(lockPath(projectRoot), 'utf8')) as LockInfo;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}

export function acquireLock(projectRoot: string, info: LockInfo): void {
  const existing = readLock(projectRoot);
  if (existing && existing.pid !== info.pid) {
    throw new Error(
      `This project folder is already being synced by the CodeMeet ${existing.kind} (pid ${existing.pid}, room ${existing.roomId}). ` +
        `Stop it first (CLI: \`codemeet leave\`; extension: "CodeMeet: Leave Room").`,
    );
  }
  mkdirSync(path.dirname(lockPath(projectRoot)), { recursive: true });
  writeFileSync(lockPath(projectRoot), JSON.stringify(info));
}

export function releaseLock(projectRoot: string, pid: number): void {
  const existing = readLock(projectRoot);
  if (!existing || existing.pid === pid) rmSync(lockPath(projectRoot), { force: true });
}
