# Changelog

## 0.1.0 — working MVP

Complete rewrite of the collaboration core on top of the original scaffold (`edc484e`).

### Added
- PostgreSQL-backed server (Neon / Supabase / local), embedded migrations, `/healthz` + `/readyz`.
- Shared packages: `shared` (protocol, policy), `core` (session, DocSync, providers, responder).
- `codemeet` CLI: `init`, `doctor`, `db`, `server`, `room`, `members`, `status`, `activity`, `diff`, `approve`, `reject`,
  `agent run`, `permissions`, `messages`, `inbox`, `responder`, `mcp`, `leave`, `resume`, `baseline`, `share`.
- Claude and Codex adapters, isolated runs, proposals with server-side diffs and apply-once approval.
- Consent model and bounded responder; MCP server and client registration helper.
- Docker Compose (Postgres + optional server), Dockerfile, `.env.example`, release scripts and workflows.

### Fixed (from the review of `edc484e`)
- Listener/timer duplication on every membership change; `stop()` now disposes everything; lifecycle is idempotent.
- Independent Y.Doc seeding (duplicated text), missed late-join sync, unopened files, timed edit suppression.
- Ignore rules not enforced on edits; one policy now covers every channel.
- Identity by socket id, in-memory rooms, silent expiry; durable identities, persistence and explicit eviction.
- Unvalidated socket payloads, unauthenticated sync routing, open `/signal` relay (removed).
- HTML injection in the sidebar; webview now uses textContent, a nonce CSP and a message whitelist.
- Shared notes overwrote each other; now an ordinary conflict-free synced file.

### Changed
- bcrypt → scrypt (pure Node); the P2P/WebRTC wording was removed: transport is a server relay.

### Known limitations
See README → Limitations and RELEASE_CHECKLIST.md.
