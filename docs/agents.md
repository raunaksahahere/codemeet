# Claude, Codex and consent

## Identity and attribution

Every participant has a stable id: a **human owner** (`Sam`) and, per provider, an **agent** (`Sam's Claude`) bound to that
owner. The server derives the sender from the authenticated session token — a request can never claim another person's
name or agent, and an owner cannot grant on behalf of someone else's agent.

CodeMeet attributes only what it can prove:

| Change | Attribution |
|---|---|
| Made through `codemeet agent run` / the extension's *Run My Agent* | the agent ("Sam's Claude"), via an isolated snapshot — every file in the snapshot was changed by that run, including files created by shell tools |
| Published through the MCP tool `codemeet_propose_changes` | the agent bound by `CODEMEET_AGENT` |
| Edits by a Claude/Codex session you launched yourself in the project | **not attributed**: they look like ordinary human/disk changes. Registering the MCP server alone does not make native edits observable. |

## Provider integration

| | Claude Code | Codex CLI |
|---|---|---|
| Detected with | `claude --version` | `codex --version` |
| Edit runs | `claude -p … --output-format stream-json --verbose --restricted --permission-mode acceptEdits --no-session-persistence` (cwd = snapshot) | `codex exec --json --skip-git-repo-check --ephemeral -s workspace-write` (cwd = snapshot) |
| Chat replies (no tools) | `--tools ""` | `-s read-only`, final message via `-o` |
| Parsed from | documented `stream-json` events | documented JSONL `item.*` events |
| Auth | your local login | your local login (`codex login`) |

CodeMeet never reads provider credential stores and never scrapes hidden reasoning. Flags used were taken from each CLI's
`--help` for the versions listed in IMPLEMENTATION_STATUS.md. Whether non-interactive/SDK use is covered by *your*
subscription is between you and the provider — check their terms; `--budget` caps a Claude run's spend.

If a provider executable is missing, `agent run` explains what to install; human collaboration is unaffected.

## The proposal workflow

1. `agent run` copies the **shareable** files into `~/.codemeet/agents/<run>/workspace` and records each file's hash.
2. The provider runs there. Every ~3 s, and at the end, the diff against the snapshot is published as one proposal (revision++).
3. The server computes diffs from its authoritative state. Reviewers see them in the CLI or sidebar.
4. Approval (host or owner): the server re-verifies every base hash. Any mismatch → status `stale`, nothing applied.
   Otherwise a single conditional database update flips `pending → applied` (that is what makes "once" true), the
   authoritative documents change, and each client writes the files.
5. Your working tree is never reset or overwritten by an agent. Local dirty files are fine: the snapshot is a copy, and a
   proposal that no longer matches simply goes stale.

## Consent

Off by default. Grants are stored per room (a new room has none), expire, and are revocable by the grantor only.

| Permission | Granted by | Meaning |
|---|---|---|
| `publish_proposals` | the agent's owner | the agent may post proposals (`agent run` grants it for the run's duration) |
| `agent_message` | **both** owners, for the specific pair | addressed messages between those two agents, ≤ 8 000 chars, ≤ 30/min, thread capped at `maxTurns` (default 6) |
| `invoke_provider` | the recipient's owner | the recipient's own provider may answer; `--auto` allows it without per-message review |
| `apply_code` | — | reserved; **no automatic application exists** |

Enforcement points (all server-side unless noted):

- on `msg.send` — before deduplication, so a replay after revocation cannot slip through;
- on `msg.ack` and delivery — queued messages become `blocked` the moment a grant is revoked;
- responder (local) — re-checks before invoking the provider **and** before publishing a reply; the server checks a third time;
- revocation of an in-flight call kills the provider child process and suppresses the reply.

Messages contain only the text of the message — never private prompts, reasoning, credentials or ignored files. Only the
two owners can read a pair's history. Received messages are never executed: the responder prompt tells the model to treat
them as information, and the provider runs with no tools.

## Reply modes (`codemeet responder <provider> <mode>`)

- `off` — messages appear in `codemeet inbox`, nothing runs.
- `review` — one message at a time: `codemeet inbox approve <id>`.
- `auto` — answers automatically **only** if the `invoke` grant carries `--auto`, at most 6 replies/min, bounded by turn cap, 120 s per call and a $0.50 Claude budget per reply.
