# CodeMeet — Development Roadmap

> A VS Code extension for real-time collaborative coding over peer-to-peer WebRTC connections.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     IDE Extension Layer                         │
│   VS Code API · TypeScript · onDidChangeTextDocument            │
│                  · onDidChangeTextEditorSelection                │
│                                                                 │
│  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ ┌────────┐│
│  │File change   │ │Cursor tracker│ │.codeignore    │ │Notes   ││
│  │detector      │ │              │ │scanner        │ │panel UI││
│  └──────────────┘ └──────────────┘ └───────────────┘ └────────┘│
└────────────────────┬──────────────────────┬────────────────────┘
                     │                      │
          ┌──────────▼──────────┐ ┌─────────▼──────────┐
          │  Signaling Server   │ │ Peer-to-Peer Layer  │
          │ Node.js · Express   │◄│ WebRTC · encrypted  │
          │ · Socket.IO         │►│ · low latency       │
          │                     │ │                     │
          │ ┌────────┐┌───────┐ │ │ ┌──────┐┌────────┐ │
          │ │Room    ││Peer   │ │ │ │Edit  ││Workspace│ │
          │ │auth    ││discov.│ │ │ │patches││sync    │ │
          │ └────────┘└───────┘ │ │ └──────┘└────────┘ │
          └──────────┬──────────┘ └─────────┬──────────┘
                     │                      │
          ┌──────────▼──────────┐ ┌─────────▼──────────┐
          │ Session Management  │ │ Real-time Collab    │
          │ Rooms · passwords   │ │ Live edits · cursors│
          │ · host approval     │ │ · shared notes      │
          └──────────┬──────────┘ └─────────┬──────────┘
                     │                      │
                     └──────────┬───────────┘
                     ┌──────────▼──────────┐
                     │  CodeMeet Session   │
                     └─────────────────────┘
```

---

## Phase 1 — Foundation & Scaffolding (Weeks 1–2)

**Goal:** Set up the monorepo, VS Code extension skeleton, signaling server, and local dev environment. Nothing collaborative yet — just a working, deployable skeleton.

### Tasks

- [ ] **Monorepo setup**
  - pnpm workspaces with three packages: `extension/`, `server/`, `shared/`
  - `shared/` holds TypeScript types for events, patches, and room state

- [ ] **VS Code extension skeleton**
  - Register commands: `codemeet.startRoom` and `codemeet.joinRoom`
  - Add sidebar webview
  - Get it to show "Hello World" in the panel

- [ ] **Signaling server scaffold**
  - Express + Socket.IO server
  - Two namespaces: `/rooms` for session management, `/signal` for WebRTC exchange
  - No auth yet, just structure

- [ ] **CI pipeline**
  - GitHub Actions: lint + typecheck on PR, package the `.vsix`, run unit tests
  - Fail fast on broken builds

### Tech Choices

| Choice              | Tool               |
|---------------------|--------------------|
| Package manager     | pnpm workspaces    |
| Language            | TypeScript (strict)|
| Linting / Formatting| ESLint + Prettier |
| Testing             | Vitest             |
| Bundler             | esbuild            |

### Deliverable

A `.vsix` installable in VS Code that registers commands and shows the empty sidebar. Server runs locally on port 3001.

---

## Phase 2 — Room Creation, Auth & Peer Connection (Weeks 3–4)

**Goal:** Implement the full room lifecycle — host creates, guest joins, server validates, peers connect. WebRTC handshake via the signaling server. Host-approval flow.

### Tasks

- [ ] **Room creation command**
  - QuickPick UI collects Room ID, password, and scope (file / folder / workspace)
  - Hashes password with bcrypt before sending to server
  - Server creates room entry with TTL

- [ ] **Join flow + host approval**
  - Guest enters Room ID + password
  - Server validates hash, emits `join-request` to host
  - Host sees Accept/Reject notification in VS Code
  - On accept, server relays connection info

- [ ] **WebRTC peer connection**
  - Use `node-webrtc` or `wrtc` inside the extension's Node.js runtime
  - Signaling server relays offer/answer/ICE candidates
  - Establish a reliable DataChannel labeled `codemeet-main`

- [ ] **Presence sidebar**
  - Webview shows room ID, list of connected members with colored dots, and disconnect button
  - Updates on `user-joined` and `user-left` events

- [ ] **Room teardown**
  - When host disconnects, server emits `room-closed` to all guests
  - Extension shows notification and clears state
  - Rooms auto-expire after 10 min of inactivity

### Key Decisions

- Passwords are **bcrypt-hashed** — never sent in plaintext
- Room IDs are randomly generated (`nanoid`) even if user chooses a custom label
- All signaling traffic goes over Socket.IO (TLS in prod)

### Deliverable

Two devs can open a room, one joins, both see each other's name in the sidebar. Console confirms P2P DataChannel open.

---

## Phase 3 — Real-time Editing & Cursor Tracking (Weeks 5–7)

**Goal:** The core of CodeMeet. Detect edits, convert to patches, send over P2P DataChannel, apply remotely. Track cursor positions per user with colored decorations.

### Tasks

- [ ] **Edit detection → patch creation**
  - Listen on `onDidChangeTextDocument`
  - Convert `ContentChange[]` events into a minimal patch: `{file, range, text, rev}`
  - Include a monotonic revision counter per file to order patches

- [ ] **Patch application on remote**
  - Receive patch over DataChannel
  - Convert range back to VS Code `WorkspaceEdit`
  - Apply with `workspace.applyEdit`
  - Skip if local rev > patch rev (stale patch)
  - Queue if file is being edited simultaneously

- [ ] **Conflict handling (MVP)**
  - Operational Transformation lite: last-writer-wins with optimistic local apply
  - Log conflicts to output channel
  - Plan CRDT upgrade in Phase 5

- [ ] **Cursor & selection sync**
  - Listen on `onDidChangeTextEditorSelection`
  - Throttle to 50ms
  - Send `{file, line, character, userId}`
  - Remote renders colored `DecorationRenderOptions` with user name tag and blinking caret SVG

- [ ] **Color assignment**
  - Assign each user a color from a fixed palette on room join
  - Color is deterministic from socket ID hash so it survives reconnects

### Performance Targets

| Metric                  | Target              |
|-------------------------|---------------------|
| Patch round-trip (LAN)  | < 100ms             |
| Patch round-trip (WAN)  | < 300ms             |
| Cursor update rate      | Throttled to 20/s   |
| Keystroke batching      | 50ms debounce       |

### Deliverable

Two devs editing the same file see each other's changes and colored cursors live. No full-file retransmit — only deltas.

---

## Phase 4 — Workspace Sync (Weeks 8–10)

**Goal:** Extend collaboration beyond single-file editing to full workspace awareness — file tree sync, `.codeignore` support, and shared workspace state.

### Tasks

- [ ] **Workspace file tree sync**
  - Share the file tree structure with connected peers
  - Respect `.codeignore` patterns to exclude sensitive files

- [ ] **`.codeignore` scanner**
  - Parse `.codeignore` file (similar to `.gitignore` syntax)
  - Filter files/folders from sync and sharing

- [ ] **Multi-file editing**
  - Track and sync edits across multiple open files simultaneously
  - Maintain per-file revision counters

- [ ] **File open/close awareness**
  - Notify peers when a user opens or closes a file
  - Show which files each peer is currently viewing

### Deliverable

Peers can collaborate across multiple files in a workspace with proper file filtering via `.codeignore`.

---

## Phase 5 — Notes, CRDT Upgrade, Telemetry & Packaging (Weeks 11–14)

**Goal:** Shared notes panel, private notes storage, CRDT-based conflict resolution, extension marketplace packaging, and operational readiness for the signaling server.

### Tasks

- [x] **Shared notes panel**
  - Webview with a live textarea
  - Changes broadcast via DataChannel to all peers
  - Merge using Y.js `Y.Text` CRDT — no manual conflict resolution
  - Presence indicators show who's typing

- [x] **Private notes**
  - Separate textarea stored in `context.globalState` (VS Code's local storage)
  - Never sent over network
  - Clear distinction in the UI: private panel has a lock icon in the header

- [ ] **CRDT for code editing**
  - Replace OT-lite with `yjs` + `y-webrtc` provider
  - Each file gets a `Y.Doc`
  - The WebRTC DataChannel becomes the transport
  - Eliminates the conflict edge cases from Phase 3

- [x] **Signaling server productionization**
  - Deploy to Railway or Fly.io
  - Add rate limiting (10 rooms/IP/hour)
  - Add Redis adapter for Socket.IO if scaling to multiple instances
  - TLS termination
  - Health check endpoint

- [x] **Marketplace packaging**
  - Write `package.json` manifest with proper categories, keywords, icon
  - Run `vsce package`
  - Publish to VS Code Marketplace
  - Add README with GIF demo and quick-start guide

### Risks to Track

- **WebRTC in Node.js** (not browser) — `wrtc` native bindings may have build issues on Windows. Test early.
- **NAT traversal** may fail without a TURN server — add `coturn` fallback.

### Deliverable

A published VS Code extension. Signaling server live. Full end-to-end flow works across different networks with TURN fallback.

---
