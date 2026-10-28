import ignore, { type Ignore } from 'ignore';
import { basename, normalizeRelPath } from './paths.js';

export type RoomScope = 'file' | 'folder' | 'workspace';

export interface PolicyOptions {
  scope: RoomScope;
  /** Relative path of the shared file/folder for scope "file" / "folder". */
  scopePath?: string;
  /** Contents of the owner's .codeignore (gitignore syntax). */
  codeignore?: string;
}

export type PolicyResult = { ok: true } | { ok: false; reason: string };

/** Directory names that are never shared. */
export const DENIED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git', 'node_modules', '.codemeet', '.ssh', '.aws', '.gnupg', '.azure', '.kube',
  '.docker', '.vscode-test', 'dist', 'build', 'out', '.next', '.nuxt', '.venv', 'venv',
  '__pycache__', '.gradle', '.terraform', 'target',
]);

const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/i;

const DENY_FILE_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^\.(npmrc|pypirc|netrc|htpasswd|git-credentials|pgpass)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx|ppk)$/i,
  /^credentials(\..*)?$/i,
  /^secrets?(\..*)?$/i,
  /^service[-_]account.*\.json$/i,
  /\.tfstate(\..*)?$/i,
  /\.tfvars$/i,
  /^\.DS_Store$/,
];

/**
 * One sharing policy used by the server (authoritative) and by every client
 * (local enforcement). It decides whether a canonical relative path may ever leave
 * or enter a machine. Clients must additionally enforce symlink/realpath boundaries.
 */
export class SharingPolicy {
  private readonly ig: Ignore;

  constructor(private readonly opts: PolicyOptions) {
    this.ig = ignore();
    if (opts.codeignore) this.ig.add(opts.codeignore);
  }

  check(path: string): PolicyResult {
    const p = normalizeRelPath(path);
    if (!p) return { ok: false, reason: 'invalid path' };
    const segments = p.split('/');
    for (const dir of segments.slice(0, -1)) {
      if (DENIED_DIR_NAMES.has(dir)) return { ok: false, reason: `directory "${dir}" is never shared` };
    }
    const name = basename(p);
    if (!ENV_TEMPLATE.test(name)) {
      for (const re of DENY_FILE_PATTERNS) {
        if (re.test(name)) return { ok: false, reason: 'looks like a secret or credential file' };
      }
    }
    if (this.opts.scope === 'file') {
      if (p !== this.opts.scopePath) return { ok: false, reason: 'outside the shared file' };
    } else if (this.opts.scope === 'folder') {
      const base = this.opts.scopePath ?? '';
      if (!(p === base || p.startsWith(base + '/'))) return { ok: false, reason: 'outside the shared folder' };
    }
    if (this.ig.ignores(p)) return { ok: false, reason: 'excluded by .codeignore' };
    return { ok: true };
  }

  allows(path: string): boolean {
    return this.check(path).ok;
  }

  /** Directory pruning hint for walkers: true when nothing below `dir` can be shared. */
  pruneDir(dir: string): boolean {
    const p = normalizeRelPath(dir);
    if (!p) return true;
    if (p.split('/').some((s) => DENIED_DIR_NAMES.has(s))) return true;
    if (this.opts.scope === 'file' && this.opts.scopePath) {
      return !this.opts.scopePath.startsWith(p + '/');
    }
    if (this.opts.scope === 'folder' && this.opts.scopePath) {
      const base = this.opts.scopePath;
      return !(p === base || p.startsWith(base + '/') || base.startsWith(p + '/'));
    }
    return false;
  }
}
