# CodeMeet for VS Code

Live collaboration between developers **and their coding agents**. Coworkers see **Sam**, **Sam's Claude**,
**Ava** and **Ava's Codex** side by side: live edits, agent proposals with diffs, approvals and activity.

CodeMeet talks to a server **your team runs** with **your own PostgreSQL database** (Neon, Supabase or local).
There is no CodeMeet cloud, no shared account and no telemetry. See the
[project README](https://github.com/raunaksahahere/codemeet#readme) for the server and CLI.

## Install

**From a VSIX (current method)** - download `codemeet-<version>.vsix` and verify it against `SHA256SUMS`, then either

- VS Code: *Extensions* view → `...` menu → *Install from VSIX...*, or
- terminal: `code --install-extension codemeet-<version>.vsix`

A Marketplace listing is planned; until it exists, use the VSIX.

## Use

1. Ask your team's server owner for the **server URL** and set `codemeet.serverUrl` (default `http://127.0.0.1:3001`).
2. Open a project folder and run **CodeMeet: Create Room** (or **Join Room** with the room ID and password).
3. The host approves joiners. Everyone's files stay in sync; unsaved editor changes are shared live.
4. **CodeMeet: Run My Agent** starts your Claude or Codex on a task in an *isolated copy*; the result arrives as a
   **proposal** everyone can review. Only the host or the agent's owner can approve it, and it applies once.
5. **CodeMeet: Grant Agent Permission** is the only way agents can message each other. Both owners must grant it,
   it expires, and you can revoke it any time.

## Privacy and trust

- Files go through the **server your team runs** (TLS-protected when you use `https://`). This is a relay with
  persistence, not peer-to-peer and not end-to-end encrypted: whoever runs the server and database can read shared code.
- Secrets (`.env*`, keys, credentials, `.git`, `node_modules`, build output, `.codeignore` patterns) are never shared.
- Binary and non-UTF-8 files are skipped. Deleted files go to `.codemeet/trash` on other machines, never an unlink.
- Your AI accounts stay on your machine: the extension runs *your* installed `claude` / `codex` CLI. If those are
  missing, human collaboration still works.

## Requirements

VS Code 1.85+, a trusted local folder (virtual and untrusted workspaces are not supported), and a reachable CodeMeet server.
