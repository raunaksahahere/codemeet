import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { ConfigError, Db, envWithFile, loadConfig, pendingMigrations, redact, startServer, validateDatabaseUrl, type ServerConfig } from '@codemeet/server';
import { CliError, files, writePrivate } from './home.js';
import { detectProvider } from './providers.js';
import { promptLine, promptSecret } from './util.js';

/** Server configuration comes from the environment, then from the owner's private server.env. */
export function serverConfig(overrides: Partial<Record<string, string>> = {}): ServerConfig {
  const env = { ...envWithFile(files.serverEnv()), ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as NodeJS.ProcessEnv;
  try {
    return loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) throw new CliError(err.message);
    throw err;
  }
}

export async function cmdInit(opts: { databaseUrlEnv?: string; stdin?: boolean; migrate?: boolean }): Promise<void> {
  let url = '';
  if (opts.databaseUrlEnv) {
    url = process.env[opts.databaseUrlEnv] ?? '';
    if (!url) throw new CliError(`Environment variable ${opts.databaseUrlEnv} is empty or not set.`);
  } else if (opts.stdin) {
    url = readFileSync(0, 'utf8').trim();
  } else {
    console.error('CodeMeet stores room data in YOUR PostgreSQL database (Neon, Supabase, or local).');
    console.error('Paste the Postgres connection string (postgresql://USER:PASSWORD@HOST:5432/DB). It stays on this machine.');
    url = (await promptSecret('DATABASE_URL: ')).trim();
  }
  try {
    validateDatabaseUrl(url);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const u = new URL(url);
  if (/supabase\.co$/.test(u.hostname) && u.hostname.startsWith('db.')) {
    console.error('Note: Supabase direct connections (db.<ref>.supabase.co) may be IPv6-only; if the check below times out, use the Session pooler string from the Supabase dashboard.');
  }
  const config = loadConfig({ DATABASE_URL: url });
  const db = new Db(config);
  try {
    const { version } = await db.check();
    console.error(`Connected to PostgreSQL ${version}.`);
    if (opts.migrate) console.error(`Applied migrations: ${(await db.migrate()).join(', ') || 'none (already up to date)'}`);
  } catch (e) {
    throw new CliError(redact((e as Error).message, url));
  } finally {
    await db.close();
  }
  const existing = existsSync(files.serverEnv()) ? readFileSync(files.serverEnv(), 'utf8') : '';
  const kept = existing.split('\n').filter((l) => l && !l.startsWith('DATABASE_URL=') && !l.startsWith('#'));
  writePrivate(files.serverEnv(), ['# Written by `codemeet init`. Keep private: never commit or share this file.', `DATABASE_URL=${url}`, ...kept, ''].join('\n'));
  try {
    chmodSync(files.serverEnv(), 0o600);
  } catch {
    /* ignore */
  }
  console.log(`Saved database settings to ${files.serverEnv()} (owner-only permissions).`);
  if (!opts.migrate) console.log('Next: `codemeet db migrate`, then `codemeet server start`.');
}

export async function cmdDbCheck(): Promise<void> {
  const config = serverConfig();
  const db = new Db(config);
  try {
    const { version } = await db.check();
    const pending = await pendingMigrations(db);
    console.log(`Database reachable (PostgreSQL ${version}).`);
    console.log(pending.length ? `Schema is behind: ${pending.join(', ')} pending. Run \`codemeet db migrate\`.` : 'Schema is up to date.');
    if (pending.length) process.exitCode = 2;
  } catch (e) {
    throw new CliError(redact((e as Error).message, config.databaseUrl));
  } finally {
    await db.close();
  }
}

export async function cmdDbMigrate(): Promise<void> {
  const config = serverConfig();
  const db = new Db(config);
  try {
    const applied = await db.migrate();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  } catch (e) {
    throw new CliError(redact((e as Error).message, config.databaseUrl));
  } finally {
    await db.close();
  }
}

function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

export async function cmdServerStart(opts: { host?: string; port?: string; migrate?: boolean }): Promise<void> {
  const config = serverConfig({ HOST: opts.host, PORT: opts.port });
  let server;
  try {
    server = await startServer(config, { migrate: opts.migrate });
  } catch (e) {
    throw new CliError(redact((e as Error).message, config.databaseUrl));
  }
  console.log(`CodeMeet server listening on ${server.url}`);
  if (config.host === '0.0.0.0' || config.host === '::') {
    for (const ip of lanAddresses()) console.log(`  LAN:  http://${ip}:${server.port}`);
    console.log('  Anyone who can reach this address and knows a room password can ask to join. Use a TLS reverse proxy for anything beyond a trusted LAN.');
  } else if (config.host === '127.0.0.1') {
    console.log('  Bound to loopback only. Use --host 0.0.0.0 to accept LAN connections.');
  }
  console.log('  Health: /healthz   Readiness: /readyz');
  await new Promise<void>((resolve) => {
    const stop = (sig: string) => {
      console.log(`\nReceived ${sig}; shutting down...`);
      void server.close().then(resolve);
      setTimeout(() => process.exit(1), 8000).unref();
    };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  });
}

export async function cmdDoctor(): Promise<void> {
  const rows: Array<[string, boolean | null, string]> = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  rows.push(['Node.js', nodeMajor >= 20, `${process.versions.node} (need >= 20.11)`]);
  rows.push(['CodeMeet home', true, files.session().replace(/session\.json$/, '')]);
  rows.push(['Database configured', existsSync(files.serverEnv()) || !!process.env.DATABASE_URL, existsSync(files.serverEnv()) ? 'server.env present' : process.env.DATABASE_URL ? 'DATABASE_URL in environment' : 'run `codemeet init` if you will host the server']);
  if (existsSync(files.serverEnv()) || process.env.DATABASE_URL) {
    try {
      const config = serverConfig();
      const db = new Db(config);
      try {
        const { version } = await db.check();
        const pending = await pendingMigrations(db);
        rows.push(['Database reachable', true, `PostgreSQL ${version}`]);
        rows.push(['Schema', pending.length === 0, pending.length ? `pending: ${pending.join(', ')}` : 'up to date']);
      } catch (e) {
        rows.push(['Database reachable', false, redact((e as Error).message, config.databaseUrl)]);
      } finally {
        await db.close();
      }
    } catch (e) {
      rows.push(['Database config', false, (e as Error).message]);
    }
  }
  for (const p of ['claude', 'codex'] as const) {
    const info = await detectProvider(p);
    rows.push([`${p} CLI`, info.found ? true : null, info.found ? (info.version ?? 'found') : `not found (optional). ${info.hint}`]);
  }
  for (const [name, ok, detail] of rows) console.log(`${ok === true ? ' ok ' : ok === false ? 'FAIL' : 'warn'}  ${name.padEnd(22)} ${detail}`);
  if (rows.some((r) => r[1] === false)) process.exitCode = 1;
  void promptLine;
}
