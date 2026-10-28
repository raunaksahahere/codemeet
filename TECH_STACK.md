# CodeMeet — Tech Stack & Technical Decisions

Describes what is **implemented today**. Earlier plans (WebRTC DataChannel, OT patches, bcrypt, archiver) were not shipped
and are listed under *Deferred*.

## Decisions

| Concern | Choice | Notes |
|---|---|---|
| Language / tooling | TypeScript (strict), pnpm workspaces, ESM packages, esbuild bundles, Vitest | Node ≥ 20.11 required; developed and tested on Node 24 (`.nvmrc`). pnpm ≥ 9 (10.18 used). |
| Transport | **Socket.IO (WebSocket) relay** through a server the team runs | Not peer-to-peer and **not end-to-end encrypted**. TLS comes from your reverse proxy (`https://`). |
| Protocol | one acknowledged `rpc` event + one `evt` push event, zod-validated | `shared/src/protocol.ts` |
| Edit sync | **Yjs CRDT**, server-authoritative documents | The server is the only place a file becomes a Y.Doc from text; clients start from server state. |
| Local change detection | content comparison against the CRDT text | No suppression timers; own writes are no-ops. Fine-grained `fast-diff` edits. |
| Persistence | **PostgreSQL** via `pg`, SQL migrations embedded in the server | Neon / Supabase / local. Advisory-locked migrations; no in-memory fallback. |
| Password hashing | salted **scrypt** (`node:crypto`) | No native addon, so the CLI bundles into one file. Raw passwords are never stored. |
| Session tokens | 256-bit random, SHA-256 stored | Durable member identity; resume by token. |
| Sharing policy | `ignore` (gitignore syntax) + built-in secret/dir deny list | One implementation used by server and clients. |
| File watching | `chokidar` (CLI), VS Code events + `FileSystemWatcher` (extension) | Rename detection by content hash in the CLI. |
| Agents | local `claude` / `codex` CLIs (structured JSON events) | Isolated snapshot per run. |
| MCP | `@modelcontextprotocol/sdk`, stdio | stdout reserved for protocol; logs on stderr. |
| Local IPC | Unix socket (0700 dir) / loopback TCP + random token (0600 file) | `cli/src/ipc.ts` |
| Shared notes | an ordinary synced file (`CODEMEET_NOTES.md`) | Conflict-free because it is a normal Yjs document. |
| Private notes | `context.globalState` | Never transmitted. |
| Packaging | CLI: single-file bundle in an npm tarball with a generated manifest. Extension: VSIX from a staged manifest. | `node scripts/package-all.mjs` |
| CI / release | GitHub Actions (`ci.yml`; manual/tag `release.yml`) | Publishing is never automatic. |

## VS Code API surface used

`onDidChangeTextDocument`, `onDidCloseTextDocument`, `createFileSystemWatcher`, `onDidRenameFiles`,
`onDidChangeTextEditorSelection`, `WorkspaceEdit` (minimal diff edits), `TextDocumentContentProvider` (proposal diffs),
`WebviewViewProvider` (nonce CSP, textContent rendering, message whitelist), `SecretStorage` (saved session token).

## Deferred

WebRTC/P2P, end-to-end encryption, voice/video, SSO, dashboards, multi-instance scaling, multi-root workspaces,
automatic (`apply_code`) application of agent output, sharing of file context between agents.

## Risk register

| Risk | State |
|---|---|
| Relay operator can read code | Documented; use your own server, TLS, and a database you trust |
| Provider CLI flags/event formats change | Parsers ignore unknown events; versions recorded; fixtures + a gated live test |
| Hosted Neon/Supabase specifics | Implemented from official docs; **unverified against real projects** |
| Windows / macOS | Code avoids POSIX-only assumptions (loopback TCP IPC) but is **unverified** |
| Race between permission check and TOCTOU file write | Residual: a local attacker with write access inside the project can swap a directory for a symlink between checks |
