import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const CLI_DIR = path.resolve(__dirname, '../../cli');

describe('packed CLI artifact', () => {
  it('contains only runtime assets, no workspace references and no secrets, and installs and runs from a clean directory', () => {
    expect(existsSync(path.join(CLI_DIR, 'dist/codemeet.cjs'))).toBe(true);
    const out = mkdtempSync(path.join(tmpdir(), 'cm-pack-'));
    const clean = mkdtempSync(path.join(tmpdir(), 'cm-clean-'));
    try {
      const tarball = execFileSync(process.execPath, [path.resolve(CLI_DIR, '../scripts/package-cli.mjs')], { encoding: 'utf8' }).trim().split('\n').pop()!;
      expect(existsSync(tarball)).toBe(true);
      const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).split('\n').filter(Boolean).map((p) => p.replace(/^package\//, '')).sort();
      expect(listing).toEqual(['LICENSE', 'README.md', 'dist/codemeet.cjs', 'package.json']);
      const packed = [{ filename: tarball }];

      execFileSync('tar', ['-xzf', tarball, '-C', out, 'package/package.json']);
      const manifest = JSON.parse(readFileSync(path.join(out, 'package', 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
      expect(JSON.stringify(manifest)).not.toContain('workspace:');
      expect(manifest.devDependencies).toBeUndefined();
      expect(manifest.dependencies ?? {}).toEqual({}); // fully bundled: nothing to resolve at install time
      expect(manifest.bin).toEqual({ codemeet: './dist/codemeet.cjs' });
      expect((manifest as unknown as { engines: { node: string } }).engines.node).toBe('>=20.11.0');

      const bundle = readFileSync(path.join(CLI_DIR, 'dist/codemeet.cjs'), 'utf8');
      for (const leak of ['codemeet-local-dev', '/home/raunak', 'sk-ant-', 'BEGIN PRIVATE KEY']) expect(bundle).not.toContain(leak);

      writeFileSync(path.join(clean, 'package.json'), '{"name":"clean-room","version":"1.0.0","private":true}');
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', packed[0]!.filename], { cwd: clean, encoding: 'utf8' });
      const bin = path.join(clean, 'node_modules', '.bin', 'codemeet');
      const env = { ...process.env, CODEMEET_HOME: path.join(clean, 'home') };
      expect(execFileSync(bin, ['--version'], { env, encoding: 'utf8' }).trim()).toBe('0.1.0');
      const help = execFileSync(bin, ['--help'], { env, encoding: 'utf8' });
      for (const cmd of ['init', 'doctor', 'room', 'status', 'activity', 'diff', 'approve', 'reject', 'agent', 'permissions', 'mcp', 'leave', 'server', 'db']) expect(help).toContain(cmd);
      const doctor = execFileSync(bin, ['doctor'], { env: { ...env, DATABASE_URL: '' }, encoding: 'utf8' });
      expect(doctor).toContain('Node.js');
      // Actionable error and non-zero exit when no session exists.
      let failed = false;
      try {
        execFileSync(bin, ['status'], { env, encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        failed = true;
        expect(String((e as { stderr: string }).stderr)).toMatch(/No active CodeMeet session/);
      }
      expect(failed).toBe(true);
      expect(readdirSync(path.join(clean, 'node_modules')).filter((d) => !d.startsWith('.'))).toEqual(['codemeet']);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(clean, { recursive: true, force: true });
    }
  }, 120_000);
});
