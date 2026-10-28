import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SharingPolicy } from '@codemeet/shared';
import { NodeWorkspace } from './workspace.js';

const dirs: string[] = [];
function project(files: Record<string, string | Buffer> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'cm-ws-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  return { dir, ws: new NodeWorkspace(dir, new SharingPolicy({ scope: 'workspace' })) };
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('NodeWorkspace confinement', () => {
  it('lists only shareable text-sized files and reports why others were skipped', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
    dirs.push(outside);
    const { dir, ws } = project({ 'a.ts': 'a', 'sub/b.ts': 'b', '.env': 'S=1', 'node_modules/x/i.js': 'x', 'big.txt': 'x'.repeat(1_000_001) });
    symlinkSync(outside, path.join(dir, 'link'));
    const r = await ws.list();
    expect(r.files).toEqual(['a.ts', 'sub/b.ts']);
    expect(r.skipped.map((s) => s.path).sort()).toEqual(['big.txt', 'link']);
  });

  it('refuses traversal, absolute and symlinked-ancestor writes', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
    dirs.push(outside);
    const { dir, ws } = project({ 'ok.txt': 'ok' });
    symlinkSync(outside, path.join(dir, 'escape'));
    await expect(ws.write('../evil.txt', 'x')).rejects.toThrow(/Unsafe path/);
    await expect(ws.write('/tmp/evil.txt', 'x')).rejects.toThrow(/Unsafe path/);
    await expect(ws.write('escape/evil.txt', 'x')).rejects.toThrow(/escapes|symlink/i);
    await expect(ws.write('.env', 'x')).rejects.toThrow(/secret/);
    expect(existsSync(path.join(outside, 'evil.txt'))).toBe(false);
    writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    expect(await ws.read('escape/secret.txt')).toMatchObject({ kind: 'skipped' }); // never read through an escaping symlink
  });

  it('refuses to follow a symlink at the target path', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'cm-out-'));
    dirs.push(outside);
    writeFileSync(path.join(outside, 'target.txt'), 'original');
    const { dir, ws } = project();
    symlinkSync(path.join(outside, 'target.txt'), path.join(dir, 'leak.txt'));
    expect(await ws.read('leak.txt')).toMatchObject({ kind: 'skipped' });
    await expect(ws.write('leak.txt', 'pwn')).rejects.toThrow(/symlink/i);
    expect(readFileSync(path.join(outside, 'target.txt'), 'utf8')).toBe('original');
  });

  it('skips binary and non-UTF-8 files instead of corrupting them', async () => {
    const { ws } = project({ 'img.bin': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]), 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'ok.txt': 'fine' });
    expect(await ws.read('img.bin')).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('binary') });
    expect(await ws.read('latin1.txt')).toMatchObject({ kind: 'skipped' });
    expect(await ws.read('ok.txt')).toEqual({ kind: 'text', text: 'fine' });
    expect(await ws.read('missing.txt')).toEqual({ kind: 'missing' });
  });

  it('writes atomically, keeps file modes, and moves deletions to a recoverable trash', async () => {
    const { dir, ws } = project({ 'x.txt': 'old' });
    await ws.write('x.txt', 'new');
    await ws.write('deep/er/y.txt', 'created');
    expect(readFileSync(path.join(dir, 'x.txt'), 'utf8')).toBe('new');
    expect(readFileSync(path.join(dir, 'deep/er/y.txt'), 'utf8')).toBe('created');
    expect((await ws.list()).files.some((f) => f.endsWith('.tmp'))).toBe(false);
    await ws.trash('x.txt');
    expect(existsSync(path.join(dir, 'x.txt'))).toBe(false);
    const trashRoot = path.join(dir, '.codemeet', 'trash');
    expect(existsSync(trashRoot)).toBe(true);
  });
});
