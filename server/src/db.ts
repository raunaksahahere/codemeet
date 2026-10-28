import pg from 'pg';
import { MIGRATIONS } from './migrations.js';
import { redact, type ServerConfig } from './config.js';

export class DbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

/** Builds the pg SSL option. Certificates are always verified unless the user opts out explicitly. */
export function sslOption(config: Pick<ServerConfig, 'databaseUrl' | 'dbSsl'>): pg.PoolConfig['ssl'] {
  const u = new URL(config.databaseUrl);
  const mode = u.searchParams.get('sslmode');
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname);
  if (config.dbSsl === 'disable') return false;
  if (config.dbSsl === 'require') return { rejectUnauthorized: true };
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'verify-full' || mode === 'verify-ca' || mode === 'prefer') return { rejectUnauthorized: true };
  // No explicit mode: hosted databases (Neon, Supabase, ...) need TLS; plain local Postgres does not.
  return local ? false : { rejectUnauthorized: true };
}

export class Db {
  readonly pool: pg.Pool;
  private closed = false;

  constructor(private readonly config: ServerConfig) {
    const u = new URL(config.databaseUrl);
    // sslmode in the URL would override the explicit ssl option in some pg versions.
    u.searchParams.delete('sslmode');
    this.pool = new pg.Pool({
      connectionString: u.toString(),
      ssl: sslOption(config),
      max: 10,
      connectionTimeoutMillis: config.dbConnectTimeoutMs,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
    // An idle client erroring must not crash the process.
    this.pool.on('error', (err) => console.error('[db] idle client error:', this.redact(err.message)));
  }

  redact(text: string): string {
    return redact(text, this.config.databaseUrl);
  }

  /** Converts a driver error into a user-safe, credential-free error. */
  wrap(err: unknown): Error {
    const e = err as { code?: string; message?: string };
    const msg = this.redact(e?.message ?? String(err));
    const hint =
      e?.code === '28P01' || e?.code === '28000'
        ? ' (authentication failed: check the user and password in DATABASE_URL)'
        : e?.code === 'ENOTFOUND'
          ? ' (host not found: check the hostname)'
          : e?.code === 'ECONNREFUSED'
            ? ' (connection refused: is PostgreSQL running and reachable?)'
            : /certificate|self.signed|SSL/i.test(msg)
              ? ' (TLS problem: hosted providers need sslmode=require; do not disable certificate verification)'
              : '';
    return new DbUnavailableError(`Database error: ${msg}${hint}`);
  }

  async query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    if (this.closed) throw new DbUnavailableError('Database connection is closed');
    try {
      return await this.pool.query<R>(text, params as never[]);
    } catch (err) {
      if ((err as { code?: string }).code?.startsWith('23')) throw err; // constraint violations are the caller's business
      throw this.wrap(err);
    }
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch((e) => {
      throw this.wrap(e);
    });
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((err as { code?: string }).code?.startsWith('23') || !(err instanceof Error) || err.name === 'RpcError') throw err;
      throw err instanceof DbUnavailableError ? err : (err as { code?: string }).code ? this.wrap(err) : err;
    } finally {
      client.release();
    }
  }

  /** Verifies connectivity with a timeout and returns the server version. */
  async check(): Promise<{ version: string }> {
    const r = await this.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    return { version: r.rows[0]?.v ?? 'unknown' };
  }

  async appliedMigrations(): Promise<string[]> {
    const exists = await this.query<{ t: string | null }>("SELECT to_regclass('public.schema_migrations') AS t");
    if (!exists.rows[0]?.t) return [];
    const r = await this.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
    return r.rows.map((x) => x.id);
  }

  /** Applies pending migrations under an advisory lock so concurrent starts are safe. */
  async migrate(): Promise<string[]> {
    const client = await this.pool.connect().catch((e) => {
      throw this.wrap(e);
    });
    const applied: string[] = [];
    try {
      await client.query('SELECT pg_advisory_lock(727274)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
      for (const m of MIGRATIONS) {
        if (done.has(m.id)) continue;
        try {
          await client.query('BEGIN');
          await client.query(m.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
          await client.query('COMMIT');
          applied.push(m.id);
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw this.wrap(err);
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
      client.release();
    }
    return applied;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.pool.end().catch(() => undefined);
  }
}

export async function pendingMigrations(db: Db): Promise<string[]> {
  const applied = new Set(await db.appliedMigrations());
  return MIGRATIONS.filter((m) => !applied.has(m.id)).map((m) => m.id);
}
