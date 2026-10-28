import { describe, expect, it } from 'vitest';
import { SharingPolicy, normalizeRelPath } from './index.js';

describe('normalizeRelPath', () => {
  it.each([
    'src/index.ts', 'a/b/c.txt', '.eslintrc.json', 'dir with space/file.txt', 'ünï/çödé.md',
  ])('accepts %s', (p) => expect(normalizeRelPath(p)).toBe(p));

  it.each([
    '', '/etc/passwd', '../x', 'a/../../x', 'a/./b', 'a//b', './a', 'a/', 'C:\\Windows\\win.ini', 'C:/x', 'c:foo',
    '\\\\server\\share\\f', 'a\\b', 'a\0b', 'file.txt:stream', 'trailing.', 'trailing ', '..', '.', 'x'.repeat(600),
  ])('rejects %j', (p) => expect(normalizeRelPath(p)).toBeNull());

  it('rejects non-strings', () => {
    expect(normalizeRelPath(undefined)).toBeNull();
    expect(normalizeRelPath(42 as never)).toBeNull();
  });
});

describe('SharingPolicy', () => {
  const ws = new SharingPolicy({ scope: 'workspace', codeignore: 'generated/\n*.secret.json\n' });

  it('shares ordinary source files', () => {
    expect(ws.allows('src/app.ts')).toBe(true);
    expect(ws.allows('README.md')).toBe(true);
  });

  it.each([
    '.env', '.env.local', '.env.production', 'app/.env', '.npmrc', '.git/config', 'node_modules/x/index.js', 'dist/out.js',
    'id_rsa', 'keys/id_ed25519', 'cert.pem', 'private.key', 'credentials.json', 'secrets.yaml', 'service-account-prod.json',
    '.aws/credentials', '.ssh/config', 'prod.tfvars', 'terraform.tfstate', '.codemeet/state/x', 'db.kdbx',
  ])('never shares secrets and build output: %s', (p) => expect(ws.allows(p)).toBe(false));

  it('allows deliberately safe env templates', () => {
    expect(ws.allows('.env.example')).toBe(true);
    expect(ws.allows('config/.env.sample')).toBe(true);
  });

  it('applies .codeignore', () => {
    expect(ws.allows('generated/a.ts')).toBe(false);
    expect(ws.allows('x/prod.secret.json')).toBe(false);
  });

  it('enforces folder and file scope', () => {
    const folder = new SharingPolicy({ scope: 'folder', scopePath: 'src/lib' });
    expect(folder.allows('src/lib/a.ts')).toBe(true);
    expect(folder.allows('src/other/a.ts')).toBe(false);
    expect(folder.allows('src/library/a.ts')).toBe(false); // prefix lookalike
    const file = new SharingPolicy({ scope: 'file', scopePath: 'src/one.ts' });
    expect(file.allows('src/one.ts')).toBe(true);
    expect(file.allows('src/two.ts')).toBe(false);
    expect(file.check('src/two.ts')).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
  });

  it('prunes only directories that cannot contain shareable files', () => {
    const folder = new SharingPolicy({ scope: 'folder', scopePath: 'src/lib' });
    expect(folder.pruneDir('src')).toBe(false); // ancestor of the scope
    expect(folder.pruneDir('src/lib/deep')).toBe(false);
    expect(folder.pruneDir('docs')).toBe(true);
    expect(ws.pruneDir('node_modules')).toBe(true);
    expect(ws.pruneDir('pkg/node_modules')).toBe(true);
  });
});
