import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Direct import for test (vitest alias resolves workspace packages)
// We test the scanner logic by importing from the source
import { CodeIgnoreScanner } from './CodeIgnoreScanner';

describe('CodeIgnoreScanner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codemeet-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('always ignores node_modules and .git', () => {
    const scanner = new CodeIgnoreScanner(tmpDir);
    expect(scanner.isIgnored('node_modules')).toBe(true);
    expect(scanner.isIgnored('node_modules/pkg/index.js')).toBe(true);
    expect(scanner.isIgnored('.git')).toBe(true);
    expect(scanner.isIgnored('.git/HEAD')).toBe(true);
    expect(scanner.isIgnored('dist')).toBe(true);
  });

  it('does not ignore regular files when no .codeignore exists', () => {
    const scanner = new CodeIgnoreScanner(tmpDir);
    expect(scanner.isIgnored('src/index.ts')).toBe(false);
    expect(scanner.isIgnored('README.md')).toBe(false);
  });

  it('respects .codeignore patterns', () => {
    fs.writeFileSync(path.join(tmpDir, '.codeignore'), '*.log\nsecrets/\n');
    const scanner = new CodeIgnoreScanner(tmpDir);
    expect(scanner.isIgnored('app.log')).toBe(true);
    expect(scanner.isIgnored('secrets/key.pem')).toBe(true);
    expect(scanner.isIgnored('src/main.ts')).toBe(false);
  });

  it('filter() returns only non-ignored paths', () => {
    fs.writeFileSync(path.join(tmpDir, '.codeignore'), '*.env\n');
    const scanner = new CodeIgnoreScanner(tmpDir);
    const result = scanner.filter(['.env', '.env.local', 'src/app.ts', 'node_modules/x']);
    expect(result).toEqual(['.env.local', 'src/app.ts']);
  });

  it('reload() picks up new .codeignore content', () => {
    const scanner = new CodeIgnoreScanner(tmpDir);
    expect(scanner.isIgnored('build/out.js')).toBe(false);

    fs.writeFileSync(path.join(tmpDir, '.codeignore'), 'build/\n');
    scanner.reload();
    expect(scanner.isIgnored('build/out.js')).toBe(true);
  });
});
