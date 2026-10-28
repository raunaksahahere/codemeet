import { createServer, type Server as HttpServer } from 'node:http';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server as IoServer } from 'socket.io';
import { LIMITS, PROTOCOL_VERSION } from '@codemeet/shared';
import { ConfigError, type ServerConfig } from './config.js';
import { Db, pendingMigrations } from './db.js';
import { Hub } from './hub.js';

export interface RunningServer {
  url: string;
  host: string;
  port: number;
  hub: Hub;
  db: Db;
  http: HttpServer;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Apply pending migrations at startup instead of refusing to start. */
  migrate?: boolean;
  log?: (line: string) => void;
}

export const SERVER_VERSION = '0.1.0';

/**
 * Starts the CodeMeet backend. The database is mandatory: if it is configured but unreachable
 * (or the schema is behind) startup fails loudly instead of silently falling back to memory.
 */
export async function startServer(config: ServerConfig, options: StartOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((l: string) => console.log(l));
  const db = new Db(config);
  try {
    const { version } = await db.check();
    log(`[codemeet] database reachable (PostgreSQL ${version})`);
    const pending = await pendingMigrations(db);
    if (pending.length) {
      if (!options.migrate) {
        throw new ConfigError(`Database schema is behind (${pending.join(', ')} pending). Run \`codemeet db migrate\` or start with --migrate.`);
      }
      const applied = await db.migrate();
      log(`[codemeet] applied migrations: ${applied.join(', ') || 'none'}`);
    }
  } catch (err) {
    await db.close();
    throw err instanceof ConfigError ? err : db.wrap(err);
  }

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }));

  app.get(['/healthz', '/health'], (_req, res) => {
    res.json({ status: 'ok', version: SERVER_VERSION, protocol: PROTOCOL_VERSION, uptime: Math.round(process.uptime()) });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      await db.check();
      const pending = await pendingMigrations(db);
      if (pending.length) return void res.status(503).json({ status: 'unavailable', reason: 'migrations pending' });
      res.json({ status: 'ready' });
    } catch (err) {
      res.status(503).json({ status: 'unavailable', reason: db.redact((err as Error).message) });
    }
  });

  const http = createServer(app);
  const io = new IoServer(http, {
    maxHttpBufferSize: LIMITS.maxFrameBytes,
    serveClient: false,
    cors: config.corsOrigins.length ? { origin: config.corsOrigins } : undefined,
  });
  const hub = new Hub(db, config, io.of('/rooms'));
  hub.start();

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.host, () => resolve());
  }).catch(async (err: NodeJS.ErrnoException) => {
    await hub.stop();
    await db.close();
    throw new Error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use on ${config.host}` : `Could not listen: ${err.message}`);
  });

  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  let closed = false;
  return {
    url: `http://${shown}:${port}`,
    host: config.host,
    port,
    hub,
    db,
    http,
    async close() {
      if (closed) return;
      closed = true;
      await hub.stop();
      await new Promise<void>((resolve) => void io.close(() => resolve()));
      await db.close();
    },
  };
}
