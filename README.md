<div align="center">

<img src="extension/icon.png" width="96" alt="CodeMeet logo" />

# Code**Meet**

### Pair-program with your team **and your AI agents** — in VS Code or the terminal.

Sam, **Sam's Claude**, Ava and **Ava's Codex** in one project: live edits, reviewable AI diffs, one-click approvals —
on **your own server** with **your own PostgreSQL**.

[![License: MIT](https://img.shields.io/badge/license-MIT-2f8cff?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020.11-3ddc97?style=flat-square)](#requirements)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.85%2B-007acc?style=flat-square)](#-install)
[![Bring your own DB](https://img.shields.io/badge/database-Neon%20%7C%20Supabase%20%7C%20local-336791?style=flat-square)](docs/database.md)
[![Agents](https://img.shields.io/badge/agents-Claude%20%7C%20Codex-8a5cf6?style=flat-square)](docs/agents.md)

[**Watch the demo**](docs/media/codemeet-demo.mp4) · [Quickstart](#-quickstart-two-people-ten-minutes) · [Why CodeMeet](#-why-codemeet) · [AI agents](#-your-ai-agents-in-the-room) · [CLI reference](docs/cli.md) · [Trust model](#-trust-model-read-this-once)

<br />

<a href="docs/media/codemeet-demo.mp4">
  <img src="docs/media/codemeet-demo.gif" width="300" alt="CodeMeet demo: Ava and Sam editing the same file live, with named cursors, then debugging together" />
</a>
<br />
<sub>▶ Click for the full 27-second video (MP4)</sub>

</div>

<br />

---

## ✨ Why CodeMeet

<table>
<tr>
<td width="50%" valign="top">

### 👥 Humans *and* agents, clearly labelled
Every participant is a first-class identity. Your coworkers see **Sam** and **Sam's Claude** — never an anonymous "AI edit".
Attribution comes from the server's authenticated binding, so nobody can pose as someone else's agent.

</td>
<td width="50%" valign="top">

### 🔍 AI proposes, humans decide
Agents work in an **isolated copy** of your project and publish a **diff proposal**. Only the host or the agent's owner
can approve it. Approval applies **exactly once**, and **stale proposals are refused** instead of overwriting newer code.

</td>
</tr>
<tr>
<td valign="top">

### 🤝 Agent-to-agent chat is *off* until both owners say yes
Claude and Codex can talk to each other only with **mutual, scoped, expiring, revocable** consent — enforced on the
server. Revoking cancels queued messages and kills an in-flight reply.

</td>
<td valign="top">

### 🗄️ Your server, your database, your AI accounts
Bring **Neon**, **Supabase** or **local Postgres**. Nothing runs on a CodeMeet cloud. Your Claude/Codex stay logged in on
*your* machine; the database URL never leaves the server owner's laptop.

</td>
</tr>
<tr>
<td valign="top">

### ⚡ Two front-ends, one protocol
Use the **VS Code extension**, the **standalone CLI**, or mix them in the same room. Edits made by editors, shell
commands or AI tools on disk are picked up automatically.

</td>
<td valign="top">

### 🛡️ Safe by default
Secrets (`.env*`, keys, credentials, `.git`, `node_modules`…) are **never shared**. Path traversal and symlink escapes are
blocked, conflicting local files are **backed up, never overwritten**, and deletions go to a recoverable trash.

</td>
</tr>
</table>

### Compared with a generic "share my screen / live share" flow

| | Typical live-share | **CodeMeet** |
|---|:---:|:---:|
| Shows *which AI* changed what, and for whom | ❌ | ✅ **Sam's Claude** / **Ava's Codex** |
| AI changes reviewed as a diff before they land | ❌ | ✅ proposal → review → approve |
| Agents isolated from the real working tree | ❌ | ✅ snapshot per run |
| AI-to-AI messaging with consent controls | ❌ | ✅ mutual · expiring · revocable |
| Works from the terminal *and* VS Code | ⚠️ | ✅ same protocol |
| You own the data (your Postgres, your server) | ❌ | ✅ |
| Resumes after a dropped connection / restart | ⚠️ | ✅ durable identities + CRDT state |

---

## 🧭 How it works

```mermaid
flowchart LR
  subgraph Sam["Sam's machine"]
    SV[VS Code extension<br/>or CLI daemon]
    SC[Sam's Claude<br/>isolated snapshot]
  end
  subgraph Ava["Ava's machine"]
    AV[VS Code extension<br/>or CLI daemon]
    AX[Ava's Codex<br/>isolated snapshot]
  end
  SRV[(CodeMeet server<br/>Socket.IO + Yjs)]
  PG[(Your PostgreSQL<br/>Neon · Supabase · local)]
  SV <-- live edits --> SRV
  AV <-- live edits --> SRV
  SC -. proposal .-> SV
  AX -. proposal .-> AV
  SRV --- PG
```

- The **server** keeps one authoritative [Yjs](https://yjs.dev) document per file, so everyone converges — including
  concurrent edits, late joiners and reconnects — without duplicated text.
- Local changes are detected by **comparing content**, not by timers, so a file CodeMeet itself just wrote never echoes back.
- Everything durable (members, documents, proposals, consent, messages, audit trail) lives in **your PostgreSQL**.

---

## 📦 Install

> [!NOTE]
> Nothing is published to npm or the VS Code Marketplace yet. Install from source or from the release artifacts —
> the commands below are exactly what works today.

**Requirements:** Node.js ≥ 20.11 (developed and tested on 24), pnpm ≥ 9, Docker (only for the local-database path),
VS Code ≥ 1.85 (only for the extension). `claude` and/or `codex` CLIs are **optional** — human collaboration works without them.

```bash
git clone https://github.com/raunaksahahere/codemeet && cd codemeet
npm install -g pnpm@10                 # skip if you already have pnpm >= 9
pnpm install --frozen-lockfile
node scripts/package-all.mjs           # builds release/codemeet-<v>.tgz, .vsix and SHA256SUMS

npm install -g ./release/codemeet-0.1.0.tgz        # the `codemeet` command
code --install-extension release/codemeet-0.1.0.vsix   # optional: VS Code extension
codemeet doctor                        # checks Node, database config, claude/codex
```

---

## 🚀 Quickstart: two people, ten minutes

### 1 · Run a server with your own database *(one person on the team)*

```bash
docker compose up -d postgres                       # local Postgres (or use Neon/Supabase, see below)
export DATABASE_URL='postgresql://codemeet:codemeet-local-dev@127.0.0.1:5432/codemeet?sslmode=disable'
codemeet init --database-url-env DATABASE_URL --migrate   # verifies the connection, saves it privately (mode 0600)
codemeet server start --host 0.0.0.0                # LAN demo; prints the address teammates should use
```

<details>
<summary><b>Using Neon or Supabase instead?</b> (click to expand)</summary>

| Provider | Which string to paste | Notes |
|---|---|---|
| **Neon** | Console → **Connect** → copy the connection string | TLS is required (`sslmode=require`). Use the **direct** (non-pooled) string for `codemeet db migrate`. |
| **Supabase** | Dashboard → **Connect** → *Session pooler* or *Direct* string | This is the **Postgres** string with your database password — **not** the anon/service-role API key. Download the root certificate and set `CODEMEET_DB_SSL_CA_FILE`; certificate verification is never disabled. |
| **Local** | `docker compose up -d postgres` | Included `docker-compose.yml`, bound to `127.0.0.1`. |

Full, step-by-step instructions and troubleshooting: **[docs/database.md](docs/database.md)**.
</details>

### 2 · Sam creates a room

```bash
codemeet room create --name Sam --project ~/code/my-app --server http://SERVER_IP:3001
# asks for a room password (masked), prints the Room ID
```

*(Or in VS Code: **CodeMeet: Create Room**.)*

### 3 · Ava joins, Sam approves

```bash
# Ava
codemeet room join <ROOM_ID> --name Ava --project ~/code/my-app-copy --server http://SERVER_IP:3001

# Sam
codemeet members                       # shows Ava's pending request
codemeet members approve <REQUEST_ID>
```

Files sync both ways immediately. Check in any time:

```bash
codemeet status            # who is here, connection state, file count
codemeet activity --follow # live feed: edits, proposals, approvals
```

> [!TIP]
> If Ava already has files that differ from Sam's, CodeMeet **stops and tells her which ones** — nothing is touched until she runs
> `codemeet baseline accept`, which first backs up her versions under `.codemeet/backups/`.

---

## 🤖 Your AI agents in the room

### Run **Sam's Claude** and **Ava's Codex** in the same project

```bash
# Sam
codemeet agent run claude "add input validation to src/api.ts"

# Ava
codemeet agent run codex  "write unit tests for src/math.ts"
```

Each agent works in an **isolated snapshot** (your working tree is never modified), streams progress, and publishes a proposal.
Everyone sees *who* proposed *what*:

```bash
codemeet proposals               # "Sam's Claude · pending · 1 file(s)"
codemeet diff <PROPOSAL_ID>      # unified diff
codemeet approve <PROPOSAL_ID>   # host or the agent's owner only; applies once, for everyone
codemeet reject  <PROPOSAL_ID>
```

In VS Code: **CodeMeet: Run My Agent**, then **Review / Approve** from the sidebar.

<details>
<summary><b>What actually runs under the hood?</b></summary>

- **Claude:** `claude -p … --output-format stream-json --restricted --permission-mode acceptEdits` inside the snapshot (file tools only, confined to that folder).
- **Codex:** `codex exec --json -s workspace-write` inside the snapshot (`--allow-shell` lets it run commands *inside Codex's own sandbox*).
- Uses **your** locally logged-in CLIs; CodeMeet never reads their credential stores. Check each provider's terms and billing for non-interactive use.
- Native edits made by an independently launched Claude/Codex session are **not** attributed to the agent — they appear as ordinary human/disk changes. Use `agent run` (or the MCP `codemeet_propose_changes` tool) for attributed work.
</details>

### 🔐 Let the agents talk — only with explicit consent

Agent-to-agent messaging is **off by default**. Both owners must opt in, for that specific pair, with a time limit:

```bash
# Sam allows his Claude to message Ava's Codex (and sets a turn cap)
codemeet permissions grant message claude --peer "Ava's Codex" --minutes 30 --max-turns 4
# Ava allows her Codex to receive it, and to answer using her own Codex login — automatically
codemeet permissions grant message codex --peer "Sam's Claude" --minutes 30 --max-turns 4
codemeet permissions grant invoke  codex --peer "Sam's Claude" --minutes 30 --auto
codemeet responder codex auto

codemeet messages send --from claude --to "Ava's Codex" "What should we name the sum helper?"
codemeet messages          # both owners can read the permitted history
codemeet permissions revoke <GRANT_ID>      # instantly blocks queued + in-flight replies
```

| Permission | What it allows | What it does **not** allow |
|---|---|---|
| `publish` | an agent posts proposals to the room | applying code |
| `message` | addressed, size-/rate-limited messages for one agent pair | shell access, code application, private transcripts |
| `invoke` | the recipient's *own* provider answers (review each, or `--auto` within turn limits) | unlimited model calls — every reply is re-checked before it is sent |

Safeguards: consent is rechecked at delivery, before the provider runs, and before the reply is published; threads have a
hard turn cap (loop prevention); received messages are treated as **information, never instructions**.

### Use CodeMeet from Claude Code / Codex (MCP)

```bash
codemeet mcp install --client all --dry-run     # preview exactly what will change
codemeet mcp install --client all               # registers a "codemeet" MCP server; existing entries untouched
codemeet mcp uninstall --client all             # remove only CodeMeet's own entry
```

Tools: `codemeet_participants`, `codemeet_activity`, `codemeet_proposals`, `codemeet_proposal_get`,
`codemeet_propose_changes`, `codemeet_message_send`, `codemeet_messages`.

---

## 🛡️ Trust model (read this once)

| Question | Honest answer |
|---|---|
| Is it peer-to-peer or end-to-end encrypted? | **No.** Code flows through the **server your team runs** (and is stored in its database). Use `https://` (TLS reverse proxy) beyond localhost/trusted LAN. Whoever operates the server and database can read shared files. |
| Who can see my database URL? | Only the server owner's machine (`~/.codemeet/server.env`, mode 0600). It is never sent to collaborators and is stripped from agent child processes. |
| What is never shared? | `.env*` (except `.env.example`), private keys, credential files, `.git`, `node_modules`, build output, `.codemeet`, your `.codeignore` patterns, binaries and non-UTF-8 files, files > 1 MB, and symlinks. |
| What is stored? | Members, document state, proposals, consent grants, approved messages and an audit trail — retained 7 days after a room closes (configurable). **Not** stored: raw passwords (salted scrypt hashes only), private notes, AI credentials, private agent transcripts. |
| Can a coworker delete my files? | Remote deletes move files to `.codemeet/trash/` — recoverable, never an unlink. Agents can only delete through an approved proposal. |

---

## 🧰 Everyday commands

| I want to… | Command |
|---|---|
| Check my setup | `codemeet doctor` |
| See who is here / what happened | `codemeet status` · `codemeet activity --follow` |
| Let someone in | `codemeet members` · `codemeet members approve <id>` |
| Review AI work | `codemeet proposals` · `codemeet diff <id>` · `codemeet approve <id>` |
| Share a file I kept private on join | `codemeet share <path>` |
| Stop but stay in the room | `codemeet leave --keep-open` (host) / `--keep-membership` (guest), then `codemeet resume` |
| Leave for good | `codemeet leave` (host closes the room; your files are never deleted) |

Complete reference: **[docs/cli.md](docs/cli.md)** · Walkthrough script for a demo: **[docs/demo.md](docs/demo.md)**

---

## ✅ What is verified (and what is not)

Run on Linux with Node 24, PostgreSQL 16 (Docker) and VS Code 1.143:

- **Integration:** fresh DB migrations; redacted DB errors; restart persistence; expiry eviction; reconnect convergence; listener-leak and echo-loop checks; access control, spoofing, traversal/symlink/secret rejection.
- **CLI end to end** against the built bundle, a **packed install in a clean directory**, and the **VSIX contents**.
- **Real VS Code extension host:** extension ↔ CLI sync, unsaved buffers vs disk, project-lock single owner, idempotent lifecycle.
- **Live providers:** real `claude` and `codex` runs produced proposals; a real Claude↔Codex exchange ran after mutual consent, and revoking consent cancelled an in-flight reply.

Not yet verified: Windows/macOS, hosted Neon/Supabase databases, extension ↔ extension across two VS Code windows (same code path as the verified cases), and independently launched provider sessions.
See **[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md)** for the full verified / blocked / deferred list.

---

## 🧩 Limitations

- One workspace folder per session (multi-root is not supported). One session per machine user profile for the CLI.
- Text files only; whole-project baseline limited to 2,000 files / 25 MB per room.
- Single server instance (no horizontal scaling). WebRTC, voice/video, SSO and dashboards are deferred.
- `.codeignore` is read when the room is created.
- Shared notes are an ordinary synced file (`CODEMEET_NOTES.md`); **private notes** stay local to VS Code.

## 🩺 Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach CodeMeet server` | Is `codemeet server start` running? Use the LAN address, not `127.0.0.1`, from another machine; check the firewall. |
| `DATABASE_URL is not a valid URL … API key` | You pasted an API key. Use the **Postgres connection string** from the provider's *Connect* dialog. |
| Supabase TLS error | Download the root certificate and set `CODEMEET_DB_SSL_CA_FILE` (see [docs/database.md](docs/database.md)). |
| Supabase connection times out | The direct host can be IPv6-only; use the **Session pooler** string. |
| `This project folder is already being synced by the CodeMeet cli/extension` | Only one process may sync a folder. `codemeet leave` or *CodeMeet: Leave Room* first. |
| `Proposal is stale` | Someone changed the files after the agent started. Re-run the agent; nothing was overwritten. |
| `claude`/`codex` not found | Install and sign in to that CLI; set `CODEMEET_CLAUDE_BIN` / `CODEMEET_CODEX_BIN` for a custom path. |

## 🧹 Uninstall / reset

```bash
codemeet mcp uninstall --client all     # if you registered the MCP server
codemeet leave                          # ends the session; files stay
npm uninstall -g codemeet               # the CLI
code --uninstall-extension raunaksahahere.codemeet
rm -rf ~/.codemeet                      # local state, incl. a saved server.env (this deletes your DB URL file)
rm -rf <project>/.codemeet              # backups, trash and sync state for that project
docker compose down -v                  # local Postgres and its data
```

---

## 🛠️ Development

```bash
pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm lint
pnpm test                                   # unit tests
docker compose up -d postgres               # then:
CODEMEET_TEST_DATABASE_URL='postgresql://codemeet:codemeet-local-dev@127.0.0.1:5432/postgres?sslmode=disable' pnpm test:db
CODEMEET_TEST_DATABASE_URL=… pnpm test:extension-host      # real VS Code extension host
```

| Package | Role |
|---|---|
| [`shared/`](shared) | wire protocol (zod), path rules, one sharing policy |
| [`server/`](server) | Express + Socket.IO, PostgreSQL, authoritative Yjs documents, consent |
| [`core/`](core) | client engine shared by CLI and extension: session, CRDT sync, providers, responder |
| [`cli/`](cli) | the `codemeet` command, local session daemon, MCP server |
| [`extension/`](extension) | VS Code adapter |

More: [docs/protocol.md](docs/protocol.md) · [ROADMAP.md](ROADMAP.md) · [TECH_STACK.md](TECH_STACK.md) · [CHANGELOG.md](CHANGELOG.md)

<div align="center">

<br />

**Built by [Raunak Saha](https://github.com/raunaksahahere)** · [MIT License](LICENSE)

⭐ If CodeMeet helps your team, a star on the repo goes a long way.

</div>
