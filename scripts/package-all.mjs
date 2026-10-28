#!/usr/bin/env node
// Produces release/codemeet-<v>.tgz (CLI), release/codemeet-<v>.vsix (extension) and release/SHA256SUMS.
// Nothing is published or uploaded by this script.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const pnpm = process.env.PNPM || 'pnpm';

execFileSync(pnpm, ['build'], { cwd: root, stdio: 'inherit' });
try {
  for (const f of readdirSync(release)) if (/\.(tgz|vsix)$|^SHA256SUMS$/.test(f)) rmSync(path.join(release, f));
} catch {
  /* first run: release/ does not exist yet */
}
execFileSync(process.execPath, [path.join(root, 'scripts/package-cli.mjs')], { stdio: 'inherit' });
// Stage the extension with a generated manifest (no monorepo devDependencies/scripts), then package it.
const ext = path.join(root, 'extension');
const stage = path.join(release, 'stage', 'extension');
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });
for (const f of ['icon.png', 'README.md', 'CHANGELOG.md']) copyFileSync(path.join(ext, f), path.join(stage, f));
copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
copyFileSync(path.join(ext, 'dist', 'extension.js'), path.join(stage, 'dist', 'extension.js'));
const manifest = JSON.parse(readFileSync(path.join(ext, 'package.json'), 'utf8'));
delete manifest.devDependencies;
delete manifest.scripts;
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(stage, '.vscodeignore'), '**\n!dist/extension.js\n!package.json\n!icon.png\n!README.md\n!LICENSE\n!CHANGELOG.md\n');
execFileSync(path.join(ext, 'node_modules', '.bin', 'vsce'), ['package', '--no-dependencies', '--allow-missing-repository', '--out', release + path.sep], { cwd: stage, stdio: 'inherit' });

const artifacts = readdirSync(release).filter((f) => /\.(tgz|vsix)$/.test(f)).sort();
const sums = artifacts.map((f) => `${createHash('sha256').update(readFileSync(path.join(release, f))).digest('hex')}  ${f}`).join('\n') + '\n';
writeFileSync(path.join(release, 'SHA256SUMS'), sums);
console.log('\nArtifacts:\n' + artifacts.map((f) => '  release/' + f).join('\n') + '\n\nSHA256SUMS:\n' + sums);
