#!/usr/bin/env node
// Builds a clean, installable CLI tarball: release/codemeet-<version>.tgz
// The monorepo package.json holds workspace:* devDependencies for bundling; the published
// manifest is generated here with only what an installer needs (the bundle has no runtime deps).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'cli');
const bundle = path.join(cli, 'dist', 'codemeet.cjs');
const releaseDir = path.join(root, 'release');
const stage = path.join(releaseDir, 'stage', 'cli');

const src = JSON.parse(readFileSync(path.join(cli, 'package.json'), 'utf8'));
rmSync(stage, { recursive: true, force: true });
mkdirSync(path.join(stage, 'dist'), { recursive: true });
copyFileSync(bundle, path.join(stage, 'dist', 'codemeet.cjs'));
copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
copyFileSync(path.join(cli, 'README.md'), path.join(stage, 'README.md'));
const manifest = {
  name: src.name,
  version: src.version,
  description: src.description,
  license: src.license,
  author: src.author,
  repository: src.repository,
  homepage: 'https://github.com/raunaksahahere/codemeet#readme',
  bugs: { url: 'https://github.com/raunaksahahere/codemeet/issues' },
  keywords: ['collaboration', 'pair-programming', 'claude', 'codex', 'mcp', 'postgres'],
  bin: src.bin,
  files: src.files,
  engines: src.engines,
};
writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
mkdirSync(releaseDir, { recursive: true });
const out = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', releaseDir], { cwd: stage, encoding: 'utf8' }));
console.log(path.join(releaseDir, out[0].filename));
