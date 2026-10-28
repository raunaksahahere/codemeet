# CodeMeet — Roadmap

## Shipped in the working MVP (0.1.0)

- Server with **PostgreSQL persistence** (Neon / Supabase / local), migrations, readiness, graceful shutdown.
- Durable identities (member id + token), resume after reconnect/restart, explicit expiry with eviction.
- Server-authoritative **Yjs** documents: late join, concurrent edits, offline edits, create/rename/delete, approved baseline with backups.
- One sharing policy (secrets, scope, `.codeignore`, traversal, symlinks) on server and clients.
- **CLI** (`codemeet`) with a local session daemon, watcher, status/activity, proposals, consent, MCP server.
- **VS Code extension** rebuilt on the shared core: idempotent lifecycle, safe sidebar, proposals and consent UI, run-my-agent.
- **Claude and Codex** adapters; isolated runs; attributed proposals; apply-once approval; stale detection.
- Consent for agent-to-agent messaging (mutual, scoped, expiring, revocable) and a bounded responder worker.

## Next

| Item | Why |
|---|---|
| Verify hosted Neon and Supabase end to end; Windows and macOS runs | listed as unverified |
| Extension ↔ extension automated test across two VS Code instances | currently covered by shared code + CLI↔extension |
| Presence UX: remote selections, "who is in which file" in the tree | cursors exist; richer UI |
| Per-agent context sharing under consent (`context: messages+files`) | schema reserves it; not implemented |
| `apply_code` auto-apply for pre-approved agents (still base-verified) | permission name is reserved |
| Rebase assistance for stale proposals (three-way merge) | today: re-run the agent |
| Server `/metrics`, structured logs | operability |

## Later / deferred

WebRTC peer-to-peer transport and end-to-end encryption · voice/video · enterprise SSO · dashboards · multi-instance scaling
(needs shared pub/sub) · multi-root workspaces · Marketplace publication (owner-run).
