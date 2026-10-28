# Release checklist — 0.1.0

Status legend: ✅ verified here · ⚠️ implemented, not verified · ⏳ blocked on something external · ➖ deferred.
Verification environment: Linux (Ubuntu 24.04), Node 24.22.1, pnpm 10.18.0, PostgreSQL 16 (Docker), VS Code 1.143.1,
`claude` 2.1.312, `codex-cli` 0.162.1, 2026-10-28.

## Verified
- ✅ build, typecheck, lint; unit tests; DB integration suite; CLI end-to-end; packed-CLI clean install; VSIX contents
- ✅ fresh Postgres → migrations → ready; invalid/unreachable DB → redacted, actionable failure; stale schema refuses to start
- ✅ durable records survive restart, presence does not; expiry notifies and evicts; reconnect converges without loss/duplication
- ✅ real VS Code extension host: extension ↔ CLI, unsaved buffer vs disk, no echo, single-owner lock, idempotent lifecycle
- ✅ live `claude` and `codex` runs → proposal with correct owner/provider → approve once; stale refused
- ✅ live Claude ↔ Codex exchange after mutual consent; default-deny, one-sided deny, revoke, replay, expiry; revoke cancels an in-flight call
- ✅ `mcp install` / `uninstall` against the real clients in a sandboxed HOME; Claude reports the server connected
- ✅ Docker image builds; `docker compose --profile server` starts, migrates and reports ready

## Not verified
- ⏳ hosted **Neon** and **Supabase** (no credentials). Procedures in docs/database.md; implemented from official docs.
- ⚠️ Windows and macOS (IPC falls back to loopback TCP on Windows; untested)
- ⚠️ extension ↔ extension across two VS Code windows (same code path as the verified cases). Manual steps: open two windows on two copies of a folder, run *Create Room* in one and *Join Room* in the other with the server URL, approve, type in both.
- ⚠️ Node 20 and 22 (CI matrix runs them; only 24 run locally)
- ⚠️ independently launched provider sessions are not observed by design

## Before publishing (owner actions — nothing is published automatically)
- [ ] confirm the LICENSE holder/year (`LICENSE` currently: MIT, Raunak Saha, 2026; matches the extension manifest)
- [ ] review `SHA256SUMS`, tag `v0.1.0`, run the **Release** workflow (it validates and attaches artifacts only)
- [ ] npm: `npm view codemeet` returned 404 on 2026-10-28 (name appeared free). Re-check immediately before publishing; the workflow publishes only if you tick the input *and* provide `NPM_TOKEN`
- [ ] Marketplace/website: supply publisher/domain and publish the VSIX yourself; no download links exist yet
- [ ] extension ID: manifest `raunaksahahere.codemeet`; both the CLI and extension workspace packages are named `codemeet` (different publish targets)

## Deferred
Windows/macOS support claims, WebRTC, E2E encryption, SSO, dashboards, multi-instance scaling, auto-apply, file-context sharing.
