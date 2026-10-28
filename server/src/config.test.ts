import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadConfig, parseEnvFile, redact } from './config.js';
import { sslOption } from './db.js';
import { hashPassword, hashToken, TokenBucket, verifyPassword, WindowLimiter } from './security.js';

describe('configuration', () => {
  it('parses env files (comments, quotes) without executing anything', () => {
    expect(parseEnvFile('# c\nDATABASE_URL="postgresql://u:p@h/db"\nPORT=3001\n\nbad line\nX=$(rm -rf /)')).toEqual({
      DATABASE_URL: 'postgresql://u:p@h/db', PORT: '3001', X: '$(rm -rf /)',
    });
  });
  it('defaults to loopback and validates ranges', () => {
    const c = loadConfig({ DATABASE_URL: 'postgresql://u:p@h/db' });
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(3001);
    expect(() => loadConfig({ DATABASE_URL: 'postgresql://u:p@h/db', PORT: '99999' })).toThrow(/PORT/);
  });
  it('redacts credentials in any text', () => {
    const url = 'postgresql://app:Sup3rSecret@db.example.com:5432/x';
    expect(redact(`connect failed for ${url}`, url)).not.toContain('Sup3rSecret');
    expect(redact('password authentication failed for user "app" Sup3rSecret', url)).not.toContain('Sup3rSecret');
    expect(redact('postgres://a:b@h/x')).toBe('postgres://***@h/x');
  });
});

describe('TLS settings', () => {
  it('verifies certificates for hosted databases and never silently disables verification', () => {
    expect(sslOption({ databaseUrl: 'postgresql://u:p@ep-1.neon.tech/db?sslmode=require', dbSsl: 'auto' })).toEqual({ rejectUnauthorized: true });
    expect(sslOption({ databaseUrl: 'postgresql://u:p@db.x.supabase.co:5432/postgres', dbSsl: 'auto' })).toEqual({ rejectUnauthorized: true });
    expect(sslOption({ databaseUrl: 'postgresql://u:p@localhost/db', dbSsl: 'auto' })).toBe(false);
    expect(sslOption({ databaseUrl: 'postgresql://u:p@localhost/db?sslmode=require', dbSsl: 'auto' })).toEqual({ rejectUnauthorized: true });
    expect(sslOption({ databaseUrl: 'postgresql://u:p@h/db', dbSsl: 'require' })).toEqual({ rejectUnauthorized: true });
  });
});

describe('TLS with a provider root certificate', () => {
  it('adds the CA but still verifies the server', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cm-ca-'));
    const ca = path.join(dir, 'root.pem');
    writeFileSync(ca, '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n');
    const ssl = sslOption({ databaseUrl: 'postgresql://postgres:p@db.x.supabase.co:5432/postgres?sslmode=require', dbSsl: 'auto', dbSslCaFile: ca }) as { rejectUnauthorized: boolean; ca: string };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain('BEGIN CERTIFICATE');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('credential and rate-limit primitives', () => {
  it('hashes passwords with a salt and verifies in constant time', async () => {
    const a = await hashPassword('hunter22');
    const b = await hashPassword('hunter22');
    expect(a).not.toBe(b);
    expect(a).not.toContain('hunter22');
    expect(await verifyPassword('hunter22', a)).toBe(true);
    expect(await verifyPassword('hunter23', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('stores only a hash of session tokens', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });
  it('token bucket and window limiter bound bursts', () => {
    const bucket = new TokenBucket(3, 0);
    expect([bucket.take(), bucket.take(), bucket.take(), bucket.take()]).toEqual([true, true, true, false]);
    const w = new WindowLimiter();
    expect([1, 2, 3].map(() => w.allow('k', 2, 1000))).toEqual([true, true, false]);
  });
});
