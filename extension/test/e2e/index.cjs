// Runs INSIDE a real VS Code extension host (see scripts/e2e-extension.mjs).
// Scenario: this extension hosts a room; the CodeMeet CLI joins as a guest. Plain Node asserts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const vscode = require('vscode');

const env = process.env;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, what, ms = 15000) {
  const t = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(60);
  }
}
function cli(home, args, extra = {}, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(env.CM_E2E_NODE, [env.CM_E2E_CLI, ...args], { env: { ...process.env, CODEMEET_E2E: '', CODEMEET_HOME: home, CODEMEET_CLAUDE_BIN: env.CM_E2E_FAKE, CODEMEET_CODEX_BIN: env.CM_E2E_FAKE, ...extra }, timeout }, (err, stdout, stderr) =>
      resolve({ code: err ? (err.code || 1) : 0, stdout, stderr }));
  });
}
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); }
  catch (e) { results.push({ name, ok: false, error: String(e && e.stack || e) }); throw e; }
}

async function run() {
  const ext = vscode.extensions.getExtension('raunaksahahere.codemeet');
  assert.ok(ext, 'extension is installed in the development host');
  const api = (await ext.activate()).e2e;
  assert.ok(api, 'e2e seam exposed with CODEMEET_E2E=1');
  const hostDir = env.CM_E2E_HOST_DIR, guestDir = env.CM_E2E_GUEST_DIR;
  const read = (d, rel) => (fs.existsSync(path.join(d, rel)) ? fs.readFileSync(path.join(d, rel), 'utf8') : null);
  const wsRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.equal(fs.realpathSync(wsRoot), fs.realpathSync(hostDir), 'host project is the open workspace folder');

  let roomId;
  await step('extension creates a room and publishes the baseline', async () => {
    await api.host({ name: 'Sam', password: 'pw-secret', scope: 'workspace', serverUrl: env.CM_E2E_SERVER });
    roomId = api.state().roomId;
    assert.ok(roomId);
    assert.equal(api.state().phase, 'syncing');
  });

  let guestJoin;
  await step('CLI guest joins; extension host approves; baseline arrives, secrets do not', async () => {
    guestJoin = cli(env.CM_E2E_GUEST_HOME, ['room', 'join', roomId, '--name', 'Ava', '--project', guestDir, '--server', env.CM_E2E_SERVER], { CODEMEET_ROOM_PASSWORD: 'pw-secret' });
    const req = await waitFor(() => api.state().pending[0], 'join request in the extension');
    await api.decideJoin(req.id, true);
    const r = await guestJoin;
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(read(guestDir, 'src/main.ts'), 'export const a = 1;\n');
    assert.equal(read(guestDir, '.env'), null, '.env never leaves the host');
  });

  const mainUri = vscode.Uri.file(path.join(hostDir, 'src/main.ts'));
  let doc;
  await step('unsaved editor buffer is shared without saving, and the disk file is left alone', async () => {
    doc = await vscode.workspace.openTextDocument(mainUri);
    await vscode.window.showTextDocument(doc);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(mainUri, new vscode.Position(0, 0), '// typed in the editor\n');
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.equal(doc.isDirty, true);
    await waitFor(() => (read(guestDir, 'src/main.ts') || '').startsWith('// typed in the editor\n'), 'guest receives the unsaved edit');
    assert.equal(read(hostDir, 'src/main.ts'), 'export const a = 1;\n', 'host disk still has the saved version');
  });

  await step('a remote disk edit lands in the open, dirty buffer once; saving does not duplicate or echo', async () => {
    const guestFile = path.join(guestDir, 'src/main.ts');
    fs.writeFileSync(guestFile, fs.readFileSync(guestFile, 'utf8') + 'export const b = 2;\n');
    await waitFor(() => doc.getText().includes('export const b = 2;'), 'buffer receives the guest edit');
    assert.equal(doc.getText().split('typed in the editor').length - 1, 1, 'local edit not duplicated');
    assert.equal(doc.getText().split('export const b = 2;').length - 1, 1, 'remote edit applied exactly once');
    await doc.save();
    await sleep(1500); // a feedback loop would keep growing the files
    const expected = '// typed in the editor\nexport const a = 1;\nexport const b = 2;\n';
    assert.equal(doc.getText(), expected);
    assert.equal(read(hostDir, 'src/main.ts'), expected);
    assert.equal(read(guestDir, 'src/main.ts'), expected);
  });

  await step('closed files follow disk changes; new files appear on both sides', async () => {
    fs.writeFileSync(path.join(hostDir, 'created-on-disk.txt'), 'hello');
    await waitFor(() => read(guestDir, 'created-on-disk.txt') === 'hello', 'file created on host disk reaches guest');
    fs.writeFileSync(path.join(guestDir, 'from-guest.txt'), 'hi host');
    await waitFor(() => read(hostDir, 'from-guest.txt') === 'hi host', 'guest file reaches host');
  });

  await step("the CLI guest's Codex proposal shows up in the extension attributed to the guest and applies once on approval", async () => {
    const r = await cli(env.CM_E2E_GUEST_HOME, ['agent', 'run', 'codex', 'add', 'util'], { FAKE_EDIT: 'src/util.ts::export const util = true;\n' });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const p = await waitFor(() => api.state().proposals.find((x) => x.status === 'pending'), 'proposal in extension state');
    assert.equal(p.agentLabel, "Ava's Codex");
    assert.equal(p.provider, 'codex');
    assert.equal(read(hostDir, 'src/util.ts'), null, 'nothing applied before approval');
    await api.decideProposalRaw(p.id, true);
    await waitFor(() => read(hostDir, 'src/util.ts') === 'export const util = true;\n' && read(guestDir, 'src/util.ts') === 'export const util = true;\n', 'applied on both sides');
    await assert.rejects(() => api.decideProposalRaw(p.id, true), /already applied/);
  });

  await step('one authoritative local path: a CLI daemon refuses to serve a project the extension already syncs', async () => {
    const other = env.CM_E2E_OTHER_HOME;
    const created = await cli(other, ['room', 'create', '--name', 'Dup', '--project', hostDir, '--server', env.CM_E2E_SERVER], { CODEMEET_ROOM_PASSWORD: 'pw-secret' });
    assert.notEqual(created.code, 0);
    const log = fs.readFileSync(path.join(other, 'daemon.log'), 'utf8');
    assert.match(log, /already being synced by the CodeMeet extension/);
  });

  await step('membership changes do not restart or multiply services', async () => {
    const before = api.listenerCounts();
    for (let i = 0; i < 3; i++) {
      const home = path.join(env.CM_E2E_TMP, `churn-${i}`); const dir = path.join(env.CM_E2E_TMP, `churn-proj-${i}`);
      fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(dir, { recursive: true });
      const j = cli(home, ['room', 'join', roomId, '--name', `Churn${i}`, '--project', dir, '--server', env.CM_E2E_SERVER], { CODEMEET_ROOM_PASSWORD: 'pw-secret' });
      const req = await waitFor(() => api.state().pending[0], 'churn request');
      await api.decideJoin(req.id, true);
      assert.equal((await j).code, 0);
      assert.equal((await cli(home, ['leave'])).code, 0);
    }
    await sleep(500);
    assert.deepEqual(api.listenerCounts(), before, 'listener/disposable counts unchanged after repeated joins and leaves');
    fs.appendFileSync(path.join(guestDir, 'created-on-disk.txt'), '!');
    await waitFor(() => read(hostDir, 'created-on-disk.txt') === 'hello!', 'sync still works');
    await sleep(800);
    assert.equal(read(hostDir, 'created-on-disk.txt'), 'hello!', 'no duplicated edits');
  });

  await step('closing the room tears everything down; the guest is told; a second room can start (idempotent lifecycle)', async () => {
    await api.closeRoom();
    assert.equal(api.state().phase, 'idle');
    assert.deepEqual(api.listenerCounts(), { evt: 0, state: 0, disposables: 0 });
    const st = JSON.parse((await cli(env.CM_E2E_GUEST_HOME, ['status', '--json'])).stdout);
    assert.equal(st.phase, 'closed');
    assert.ok(fs.existsSync(path.join(hostDir, 'src/main.ts')), 'files are never deleted');
    await api.host({ name: 'Sam', password: 'pw-secret', scope: 'workspace', serverUrl: env.CM_E2E_SERVER });
    assert.equal(api.state().phase, 'syncing');
    assert.notEqual(api.state().roomId, roomId);
    await api.closeRoom();
  });
}

exports.run = async function () {
  let failure = null;
  try { await run(); } catch (e) { failure = e; }
  fs.writeFileSync(env.CM_E2E_OUT, JSON.stringify({ results, failure: failure ? String(failure.stack || failure) : null }, null, 2));
  if (failure) throw failure;
};
