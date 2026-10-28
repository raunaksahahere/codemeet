import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Root of CodeMeet's per-user state. Override with CODEMEET_HOME (used by tests and for multiple identities). */
export function homeDir(): string {
  const dir = process.env.CODEMEET_HOME ? path.resolve(process.env.CODEMEET_HOME) : path.join(homedir(), '.codemeet');
  ensurePrivateDir(dir);
  return dir;
}

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not supported on this filesystem/OS */
  }
}

/** Writes a file readable only by the current user. */
export function writePrivate(file: string, content: string): void {
  writeFileSync(file, content, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows: relies on the user profile ACLs */
  }
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export const files = {
  serverEnv: () => path.join(homeDir(), 'server.env'),
  session: () => path.join(homeDir(), 'session.json'),
  daemon: () => path.join(homeDir(), 'daemon.json'),
  daemonLog: () => path.join(homeDir(), 'daemon.log'),
  config: () => path.join(homeDir(), 'config.json'),
  socket: () => path.join(homeDir(), 'daemon.sock'),
  agents: () => path.join(homeDir(), 'agents'),
};

export interface SavedSession {
  serverUrl: string;
  roomId: string;
  memberId: string;
  token: string;
  projectRoot: string;
  role: 'host' | 'guest';
  displayName: string;
  /** Baseline is pulled/published by the daemon once; afterwards state comes from the local store. */
  bootstrapped: boolean;
  acceptBaseline: boolean;
  /** Agent ids registered for this session, by provider. */
  agents: Partial<Record<'claude' | 'codex', string>>;
}

export function loadSession(): SavedSession | null {
  return readJson<SavedSession>(files.session());
}

export function saveSession(s: SavedSession): void {
  writePrivate(files.session(), JSON.stringify(s, null, 2));
}

export interface CliConfig {
  serverUrl?: string;
  displayName?: string;
}

export function loadConfig(): CliConfig {
  return readJson<CliConfig>(files.config()) ?? {};
}

export function saveConfig(c: CliConfig): void {
  writePrivate(files.config(), JSON.stringify(c, null, 2));
}

export function fileExists(p: string): boolean {
  return existsSync(p);
}
