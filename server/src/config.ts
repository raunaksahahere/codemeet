import { existsSync, readFileSync } from 'node:fs';

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  /** "auto" follows the URL's sslmode, "require" forces verified TLS, "disable" turns TLS off. */
  dbSsl: 'auto' | 'require' | 'disable';
  /** Optional PEM file with the provider's root CA (needed for Supabase). Verification stays on. */
  dbSslCaFile?: string;
  dbConnectTimeoutMs: number;
  roomTtlMinutes: number;
  retentionDays: number;
  /** Comma-separated allowed browser origins; empty means no CORS headers. */
  corsOrigins: string[];
  trustProxy: boolean;
  /** Per-IP limits for room creation / join attempts per minute. */
  maxCreatesPerMinute: number;
  maxJoinsPerMinute: number;
}

export class ConfigError extends Error {}

/** Parses a dotenv-style file without any dependency; only simple KEY=VALUE lines. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Loads variables from an env file (if present) without overriding the real environment. */
export function envWithFile(file: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!file || !existsSync(file)) return base;
  return { ...parseEnvFile(readFileSync(file, 'utf8')), ...base };
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigError(
      'DATABASE_URL is not set. Run `codemeet init` to configure a PostgreSQL connection string ' +
        '(Neon, Supabase or local), or export DATABASE_URL. See .env.example.',
    );
  }
  validateDatabaseUrl(databaseUrl);
  const dbSsl = (env.CODEMEET_DB_SSL ?? 'auto') as ServerConfig['dbSsl'];
  if (!['auto', 'require', 'disable'].includes(dbSsl)) throw new ConfigError('CODEMEET_DB_SSL must be auto, require or disable');
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: int(env, 'PORT', 3001, 0, 65535),
    databaseUrl,
    dbSsl,
    dbSslCaFile: env.CODEMEET_DB_SSL_CA_FILE?.trim() || undefined,
    dbConnectTimeoutMs: int(env, 'CODEMEET_DB_CONNECT_TIMEOUT_MS', 8000, 500, 60000),
    roomTtlMinutes: int(env, 'CODEMEET_ROOM_TTL_MINUTES', 720, 5, 7 * 24 * 60),
    retentionDays: int(env, 'CODEMEET_RETENTION_DAYS', 7, 1, 365),
    corsOrigins: (env.CODEMEET_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.CODEMEET_TRUST_PROXY === '1',
    maxCreatesPerMinute: int(env, 'CODEMEET_MAX_CREATES_PER_MINUTE', 10, 1, 100_000),
    maxJoinsPerMinute: int(env, 'CODEMEET_MAX_JOINS_PER_MINUTE', 20, 1, 100_000),
  };
}

/** Rejects values that are clearly not a Postgres connection string (e.g. a Supabase API key). */
export function validateDatabaseUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(
      'DATABASE_URL is not a valid URL. Expected postgresql://USER:PASSWORD@HOST:5432/DBNAME. ' +
        'A Supabase anon/service-role key or a Neon API key is not a database connection string.',
    );
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new ConfigError('DATABASE_URL must start with postgresql:// or postgres://');
  }
  if (!u.hostname) throw new ConfigError('DATABASE_URL has no host');
}

/** Removes credentials from any text before it is logged or shown to a user. */
export function redact(text: string, databaseUrl?: string): string {
  let out = text.replace(/(postgres(?:ql)?:\/\/)([^@\s/]*)@/gi, '$1***@');
  if (databaseUrl) {
    try {
      const u = new URL(databaseUrl);
      for (const secret of [decodeURIComponent(u.password), u.password]) {
        if (secret.length >= 4) out = out.split(secret).join('***');
      }
    } catch {
      /* already validated elsewhere */
    }
  }
  return out;
}
