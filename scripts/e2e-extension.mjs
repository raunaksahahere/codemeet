#!/usr/bin/env node
// Real VS Code extension-host test: launches the installed VS Code with an isolated profile,
// loads this repo's extension from source, and runs extension/test/e2e/index.cjs inside the host.
// Requires: a local VS Code (CODEMEET_VSCODE_BIN or `code` on PATH), a display, Postgres (CODEMEET_TEST_DATABASE_URL).
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const admin = process.env.CODEMEET_TEST_DATABASE_URL;
if (!admin) throw new Error('Set CODEMEET_TEST_DATABASE_URL (admin connection to a throwaway local PostgreSQL).');
const cli = path.join(root, 'cli/dist/codemeet.cjs');
if (!existsSync(cli) || !existsSync(path.join(root, 'extension/dist/extension.js'))) throw new Error('Run `pnpm build` first.');

const codeBin = process.env.CODEMEET_VSCODE_BIN || realpathSync(execFileSync('which', ['code'], { encoding: 'utf8' }).trim());
// The `code` launcher script is a shell wrapper; the Electron binary is next to the resources directory.
const electron = existsSync(path.join(path.dirname(codeBin), '..', 'code')) ? path.join(path.dirname(codeBin), '..', 'code') : codeBin;

const tmp = mkdtempSync(path.join(tmpdir(), 'cm-e2e-ext-'));
const dbName = `cm_e2e_${Date.now().toString(36)}`;
const a = new pg.Client({ connectionString: admin });
await a.connect();
await a.query(`CREATE DATABASE ${dbName}`);
await a.end();
const dbUrl = new URL(admin);
dbUrl.pathname = `/${dbName}`;

const hostDir = path.join(tmp, 'host-project');
const guestDir = path.join(tmp, 'guest-project');
mkdirSync(path.join(hostDir, 'src'), { recursive: true });
mkdirSync(guestDir, { recursive: true });
writeFileSync(path.join(hostDir, 'src/main.ts'), 'export const a = 1;\n');
writeFileSync(path.join(hostDir, '.env'), 'SECRET=1\n');
const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const serverHome = path.join(tmp, 'server-home');
mkdirSync(serverHome, { recursive: true, mode: 0o700 });
const serverLog = openSync(path.join(tmp, 'server.log'), 'a');
const server = spawn(process.execPath, [cli, 'server', 'start', '--migrate', '--port', String(port)], {
  env: { ...process.env, CODEMEET_DEBUG_RPC: '1', CODEMEET_HOME: serverHome, DATABASE_URL: dbUrl.toString() }, stdio: ['ignore', serverLog, serverLog],
});
const out = path.join(tmp, 'result.json');
let code = 1;
try {
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${port}/readyz`).then((r) => r.ok, () => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const args = [
    `--user-data-dir=${path.join(tmp, 'user-data')}`, `--extensions-dir=${path.join(tmp, 'exts')}`,
    `--extensionDevelopmentPath=${path.join(root, 'extension')}`, `--extensionTestsPath=${path.join(root, 'extension/test/e2e/index.cjs')}`,
    '--disable-workspace-trust', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--new-window', hostDir,
  ];
  const child = spawn(electron, args, {
    stdio: 'inherit',
    env: {
      ...process.env, CODEMEET_E2E: '1', CM_E2E_NODE: process.execPath, CM_E2E_CLI: cli, CM_E2E_FAKE: path.join(root, 'tests/fixtures/fake-provider.mjs'),
      CM_E2E_SERVER: `http://127.0.0.1:${port}`, CM_E2E_HOST_DIR: hostDir, CM_E2E_GUEST_DIR: guestDir,
      CM_E2E_GUEST_HOME: path.join(tmp, 'guest-home'), CM_E2E_OTHER_HOME: path.join(tmp, 'other-home'), CM_E2E_TMP: tmp, CM_E2E_OUT: out,
    },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 240_000);
  code = await new Promise((resolve) => child.on('close', (c) => resolve(c ?? 1)));
  clearTimeout(timer);
} finally {
  server.kill('SIGTERM');
  closeSync(serverLog);
  if (existsSync(out)) {
    const r = JSON.parse(readFileSync(out, 'utf8'));
    for (const s of r.results) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}${s.ok ? ` (${s.ms}ms)` : `\n      ${s.error}`}`);
    if (r.failure) code = 1;
  } else console.log('No result file was written: the extension host did not reach the test.');
  const b = new pg.Client({ connectionString: admin });
  await b.connect();
  await b.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await b.end();
  if (code === 0) rmSync(tmp, { recursive: true, force: true });
  else console.log(`Artifacts kept in ${tmp}`);
}
process.exit(code);
