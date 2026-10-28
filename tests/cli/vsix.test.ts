import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const RELEASE = path.resolve(__dirname, '../../release');

describe('VSIX artifact', () => {
  it('contains exactly the runtime assets and no secrets, workspace references or source maps', () => {
    const vsix = existsSync(RELEASE) ? readdirSync(RELEASE).find((f) => f.endsWith('.vsix')) : undefined;
    expect(vsix, 'run `node scripts/package-all.mjs` first').toBeTruthy();
    const dir = mkdtempSync(path.join(tmpdir(), 'cm-vsix-'));
    try {
      execFileSync('unzip', ['-q', path.join(RELEASE, vsix!), '-d', dir]);
      const listing = execFileSync('find', ['extension', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).sort();
      expect(listing).toEqual(['extension/LICENSE.txt', 'extension/changelog.md', 'extension/dist/extension.js', 'extension/icon.png', 'extension/package.json', 'extension/readme.md']);
      const pkg = JSON.parse(readFileSync(path.join(dir, 'extension/package.json'), 'utf8')) as Record<string, unknown> & { contributes: { commands: unknown[] } };
      expect(pkg.name).toBe('codemeet');
      expect(pkg.publisher).toBe('raunaksahahere');
      expect(pkg.license).toBe('MIT');
      expect(JSON.stringify(pkg)).not.toContain('workspace:');
      expect(pkg.contributes.commands.length).toBeGreaterThanOrEqual(10);
      const bundle = readFileSync(path.join(dir, 'extension/dist/extension.js'), 'utf8');
      for (const leak of ['codemeet-local-dev', '/home/raunak', 'sk-ant-', 'BEGIN PRIVATE KEY']) expect(bundle).not.toContain(leak);
      expect(bundle).toContain('codemeet.createRoom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
