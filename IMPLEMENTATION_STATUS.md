# CodeMeet implementation status

Branch: `feat/codemeet-working-mvp` (baseline: `edc484e`, "Bugged Version"). Updated at milestones; newest first.

## Baseline (verified 2026-10-28 20:29 IST on `edc484e`)
- Node v24.22.1, pnpm 10.18.0 (repo needs >= 9; machine had 8.15 -> pinned user-local pnpm 10), Docker 29.9.2, git 2.43.0
- `claude` 2.1.312 and `codex-cli` 0.162.1 installed locally
- `pnpm install --frozen-lockfile`, typecheck, lint, build: pass. `pnpm test`: 14 unit tests pass (they never exercised live collaboration).
- Review findings re-validated against the cloned HEAD: all confirmed (see git history for the originals).

## Checklist (final)
- [x] shared / server / core / CLI / extension implemented (see CHANGELOG.md)
- [x] Claude + Codex adapters live-verified; consent live-verified; MCP install verified in a sandboxed HOME
- [x] Automated suites: unit (74), DB integration + CLI e2e + packaging (40), real VS Code extension host (9 steps)
- [x] Packaging: CLI tarball, VSIX, SHA256SUMS via `node scripts/package-all.mjs`
- [x] Docs: README (with demo video), docs/*, ROADMAP, TECH_STACK, CHANGELOG, RELEASE_CHECKLIST
- [x] Docker image + compose server profile verified
- [ ] Not verified: hosted Neon/Supabase, Windows/macOS, extension<->extension across two windows, Node 20/22 locally

## Defects found by the new tests and fixed (not in the original review)
1. Files created while offline were not uploaded after a live reconnect; the "kept private" index was not persisted across restarts (could have shared a private file after restart).
2. `doctor` failed for join-only users with no database.
3. Published manifests (CLI and VSIX) carried monorepo `workspace:*` devDependencies -> staged, generated manifests.
4. `statement_timeout` as a startup parameter breaks PgBouncer-style poolers (Neon pooled / Supabase transaction) -> client-side `query_timeout`.
5. Supabase certificates are not in Node's trust store -> `CODEMEET_DB_SSL_CA_FILE` (verification stays on).
6. Unix socket path length limit -> short private fallback directory.
7. `typecheck` failed from a clean checkout (needs declaration builds first).
8. Extension: the server's own `room-closed` echo tore the host session down before the close acknowledgement arrived (15 s hang, flaky) -> intentional-close flag and stale-session guards.

## Commands used for the final run (fresh clone of the branch)
```
pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm build && pnpm test
node scripts/package-all.mjs
CODEMEET_TEST_DATABASE_URL=postgresql://codemeet:codemeet-local-dev@127.0.0.1:54329/postgres?sslmode=disable pnpm test:db
CODEMEET_TEST_DATABASE_URL=... node scripts/e2e-extension.mjs
```
