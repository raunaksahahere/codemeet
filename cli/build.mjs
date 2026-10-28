import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as esbuild from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
mkdirSync('dist', { recursive: true });
await esbuild.build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/codemeet.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  minify: false,
  sourcemap: false,
  banner: { js: '#!/usr/bin/env node' },
  // Optional native/driver extras that the pure-JS paths never need.
  external: ['pg-native', 'bufferutil', 'utf-8-validate', 'fsevents'],
  define: { 'process.env.CODEMEET_VERSION': JSON.stringify(pkg.version) },
  logLevel: 'info',
});
chmodSync('dist/codemeet.cjs', 0o755);
writeFileSync('dist/.built', new Date().toISOString());
