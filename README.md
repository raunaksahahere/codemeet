# CodeMeet

> Real-time collaborative coding in VS Code over peer-to-peer connections.

CodeMeet is a VS Code extension that lets multiple developers edit the same files simultaneously, see each other's cursors, share notes, and track who's working on what — all through a lightweight signaling server.

---

## ✨ Features

- **Room-based sessions** — Create or join password-protected rooms
- **Real-time editing** — See remote edits appear as you type (50ms latency)
- **Live cursors** — Colored cursor indicators with display names
- **Workspace sync** — Host shares file tree with guests
- **File activity tracking** — See which files your peers have open
- **Shared notes** — Live collaborative notepad with typing indicators
- **Private notes** — Local-only notepad (🔒 never sent over network)
- **`.codeignore`** — Control which files are shared (gitignore syntax)

---

## 🚀 Quick Start

### 1. Start the signaling server

```bash
# Clone and install
git clone https://github.com/raunaksahahere/codemeet.git
cd codemeet
pnpm install

# Build and run
pnpm build
cd server && node dist/index.js
```

The server starts on `http://localhost:3001`. Verify with:

```bash
curl http://localhost:3001/health
```

### 2. Install the extension in VS Code

You do **NOT** need a Marketplace publisher account. Install the `.vsix` file directly:

#### Option A: Build it yourself

```bash
cd codemeet

# Install all deps & build everything
pnpm install
pnpm build

# Package the .vsix
cd extension
npx @vscode/vsce package --no-dependencies --skip-license
```

This creates a file like `codemeet-0.1.0.vsix`.

#### Option B: Download from CI

Every push to `main` builds a `.vsix` artifact. Go to the **Actions** tab on GitHub → latest successful run → download the `codemeet-vsix` artifact.

#### Install the .vsix

**From the terminal:**

```bash
code --install-extension codemeet-0.1.0.vsix
```

**From the VS Code UI:**

1. Open VS Code
2. Press `Ctrl+Shift+P` → type **"Install from VSIX"**
3. Select `Extensions: Install from VSIX...`
4. Browse to the `.vsix` file and select it
5. Reload VS Code when prompted

### 3. Start collaborating

1. Open the **CodeMeet** sidebar (activity bar icon)
2. Click **Start Room** to host, or **Join Room** to connect
3. Share the room ID and password with your team
4. Start editing!

---

## 📋 Commands

Open the Command Palette (`Ctrl+Shift+P`) and type "CodeMeet":

| Command | Description |
|---|---|
| `CodeMeet: Start Room` | Create a new collaboration room |
| `CodeMeet: Join Room` | Join an existing room by ID |
| `CodeMeet: Leave Room` | Disconnect from the current room |
| `CodeMeet: Open Shared Notes` | Open the live shared notepad |
| `CodeMeet: Open Private Notes` | Open your local-only notepad |

---

## 📁 `.codeignore`

Create a `.codeignore` file in your workspace root to control which files are visible to peers. It uses **gitignore syntax**:

```gitignore
# Example .codeignore
*.env
secrets/
build/
*.key
*.pem
private-notes/
```

**Always ignored** (regardless of `.codeignore`):
- `node_modules/`
- `.git/`
- `dist/`
- `.DS_Store`
- `.vscode-test/`

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| `codemeet.serverUrl` | `http://localhost:3001` | URL of the signaling server |

Change via **Settings** → search "CodeMeet", or in `settings.json`:

```json
{
  "codemeet.serverUrl": "http://your-server:3001"
}
```

---

## 🏗️ Project Structure

```
codemeet/
├── shared/          # Shared TypeScript types (events, patches, room)
├── server/          # Express + Socket.IO signaling server
├── extension/       # VS Code extension (esbuild bundled)
├── ROADMAP.md       # Development phases
└── TECH_STACK.md    # Architecture decisions
```

---

## 🛠️ Development

```bash
# Install dependencies
pnpm install

# Build everything (shared must build first)
pnpm build

# Run in dev mode
cd server && pnpm dev          # Server with hot-reload
cd extension && pnpm watch     # Extension with watch mode

# Quality checks
pnpm typecheck                 # TypeScript strict mode
pnpm lint                      # ESLint
pnpm test                      # Vitest (14 tests)
```

---

## 📄 License

MIT
