# CodeMeet — Tech Stack & Technical Decisions

> Reference document covering technology choices, VS Code API surface, and risk register for the CodeMeet project.

---

## Tech Stack Decisions

| Concern                | Choice                        | Notes                                                        |
|------------------------|-------------------------------|--------------------------------------------------------------|
| Edit sync              | `Patch (OT) → Y.js CRDT`     | OT-lite in Phase 3 for speed; upgrade to Y.js CRDT in Phase 5 |
| P2P transport          | `WebRTC DataChannel`          | Reliable, encrypted, low-latency peer-to-peer data channel   |
| Signaling              | `Socket.IO / Express`         | Handles room auth, peer discovery, and WebRTC handshake relay |
| File ignore            | `npm: ignore (gitignore-compat)` | `.codeignore` uses `.gitignore`-compatible syntax          |
| Workspace ZIP          | `npm: archiver`               | Used for workspace file transfer and bundling                |
| Password hash          | `bcrypt, cost=12`             | Passwords never sent in plaintext                            |
| Notes CRDT             | `Y.js Y.Text`                 | Conflict-free shared notes via Y.js text type                |
| WebRTC in Node         | `wrtc (native bindings)`      | Native WebRTC bindings for Node.js runtime inside extension  |
| Private notes storage  | `context.globalState`         | VS Code's local storage; never transmitted over network      |
| Server deploy          | `Fly.io / Railway`            | Signaling server hosting with health checks and TLS          |

---

## API Surface (VS Code Extension Events)

| Feature              | VS Code API                              | Usage                                          |
|----------------------|------------------------------------------|-------------------------------------------------|
| Edit detection       | `onDidChangeTextDocument`                | Capture `ContentChange[]` and convert to patches |
| Cursor sync          | `onDidChangeTextEditorSelection`         | Track cursor position; throttled to 50ms        |
| File renames         | `onDidRenameFiles`                       | Detect file renames and propagate to peers      |
| File deletes         | `onDidDeleteFiles`                       | Detect file deletions and propagate to peers    |
| Workspace root       | `workspaceFolders[0].uri`                | Resolve workspace root for relative paths       |
| Apply edits          | `workspace.applyEdit`                    | Apply incoming remote patches as `WorkspaceEdit`|
| Cursor decoration    | `DecorationRenderOptions`                | Render colored remote cursors with name tags    |
| Open folder          | `vscode.openFolder`                      | Open shared workspace folder on join            |
| Notifications        | `window.showInformationMessage`          | Host approval prompts, room events, errors      |
| Room ID input        | `window.showInputBox`                    | Collect room ID and password from user          |

---

## Risk Register

### 🔴 High

| Risk | Mitigation |
|------|------------|
| **WebRTC NAT traversal failure** | Deploy a `coturn` TURN server as fallback. Configure ICE servers list with both STUN (Google) and your TURN credentials. P2P degrades gracefully to relayed mode. |
| **`wrtc` native bindings on Windows** | Test on Windows CI from day 1. Consider electron-based WebRTC via VS Code's renderer process as an alternative if Node `wrtc` proves too brittle. |

### 🟡 Medium

| Risk | Mitigation |
|------|------------|
| **Edit conflicts causing document corruption** | OT-lite is intentional in Phase 3 (fast to ship). CRDT upgrade in Phase 5 eliminates the class of problem. Keep revision log for rollback during beta. |
| **Large workspace transfer timeout** | Chunk with ACKs, resume on reconnect, enforce a 50 MB soft limit with a warning. Encourage users to `.codeignore` generated files. |

### 🟢 Low

| Risk | Mitigation |
|------|------------|
| **Signaling server SPOF** | Signaling is only needed for connection setup. Once P2P is established, dropping the server doesn't interrupt collaboration. Still add health checks + restart policy. |

---

## Quick Reference

```
extension/          VS Code extension (TypeScript, esbuild)
server/             Signaling server (Express, Socket.IO)
shared/             Shared types (events, patches, room state)
```

**See also:** [ROADMAP.md](./ROADMAP.md) for the phased implementation plan.
