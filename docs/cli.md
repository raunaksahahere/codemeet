# CLI reference

`codemeet --help` and `codemeet <command> --help` are always authoritative. Global: state lives in `~/.codemeet`
(override with `CODEMEET_HOME` to run a second identity on one machine).

## Server owner

| Command | What it does |
|---|---|
| `codemeet init [--database-url-env VAR \| --stdin] [--migrate]` | Validates a Postgres URL (masked prompt by default), tests the connection, saves it to `server.env` (0600). |
| `codemeet doctor` | Checks Node, database, `claude`, `codex`. Missing optional pieces are warnings, not failures. |
| `codemeet db check` | Connectivity + schema state. Exit 2 if migrations are pending. |
| `codemeet db migrate` | Applies pending migrations. |
| `codemeet server start [--host H] [--port P] [--migrate]` | Runs the backend. Default `127.0.0.1:3001`; `--host 0.0.0.0` for LAN. Graceful shutdown on SIGINT/SIGTERM. |

## Rooms and sync

| Command | What it does |
|---|---|
| `codemeet room create --name N [--project DIR] [--server URL] [--scope workspace\|folder\|file --path REL] [--ttl-minutes N]` | Creates a room, publishes the project as the authoritative baseline, starts the session daemon. Password: masked prompt or `CODEMEET_ROOM_PASSWORD`. |
| `codemeet room join ID --name N [--project DIR] [--server URL] [--accept-baseline]` | Requests access, waits for approval, pulls the baseline. Differing local files block the join (exit 3) until `codemeet baseline accept` (or `--accept-baseline`). |
| `codemeet members [approve\|reject ID]` | List participants / pending requests; the host decides. |
| `codemeet status [--json]` | Phase, connection, participants, responder state, recent log. |
| `codemeet activity [--follow] [--limit N]` | The shared audit feed. |
| `codemeet baseline accept` | Back up differing local files to `.codemeet/backups/` and adopt the shared versions. |
| `codemeet share PATH` | Share a local-only file that was kept private at join time. |
| `codemeet leave [--keep-open \| --keep-membership]` | Host closes the room / guest leaves; `--keep-*` only stops syncing. Files are never deleted. |
| `codemeet resume` | Restart the daemon for the saved session (offline edits are merged). |

The session daemon (`codemeet daemon`, started for you) owns the connection, watcher and state. CLI commands reach it over
a Unix socket in a `0700` directory (loopback TCP on Windows), and every connection must present the random token stored in
the `0600` `daemon.json`.

## Proposals

| Command | What it does |
|---|---|
| `codemeet proposals [--status S]` | List proposals with owner/provider. |
| `codemeet diff ID` | Unified diffs; warns if the base changed. |
| `codemeet approve ID` / `codemeet reject ID` | Host or the agent's owner only. Approval is atomic and applies once; stale proposals are refused. |

## Agents and consent

| Command | What it does |
|---|---|
| `codemeet agent run claude\|codex TASK… [--timeout MIN] [--budget USD] [--allow-shell] [--keep]` | Runs your provider CLI in an isolated snapshot and publishes the result as a proposal. |
| `codemeet permissions` | List grants. |
| `codemeet permissions grant publish\|apply\|message\|invoke PROVIDER [--peer "Ava's Codex"] [--minutes N] [--max-turns N] [--auto]` | Grant consent. |
| `codemeet permissions revoke ID` | Revoke; blocks queued messages and cancels running replies. |
| `codemeet messages [--thread ID]` · `codemeet messages send --from P --to AGENT TEXT` | Permitted history / send. |
| `codemeet inbox` · `inbox approve ID` · `inbox dismiss ID` | One-message-at-a-time review mode. |
| `codemeet responder claude\|codex off\|review\|auto` | How your agent answers permitted peers. |
| `codemeet mcp serve` · `mcp install\|uninstall [--client claude\|codex\|all] [--scope user\|local\|project] [--dry-run]` | MCP server (stdio) and client registration. |

`apply` is accepted as a permission name but automatic application of agent code is **not implemented**: every proposal
needs a human decision.

## Exit codes

`0` success · `1` error (message on stderr) · `2` pending migrations (`db check`) · `3` join blocked on a baseline decision.
