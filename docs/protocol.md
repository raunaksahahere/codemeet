# Protocol, identity and storage notes

Transport: Socket.IO (WebSocket) on namespace `/rooms`. One request event, `rpc`, with an acknowledgement:
`{op, input} → {ok:true,data} | {ok:false,error:{code,message}}`. One push event, `evt`. Every input is validated with
zod on the server (`shared/src/protocol.ts` is the single source of truth); unknown operations and malformed input are rejected.
Error codes: `invalid unauthorized forbidden not_found conflict rate_limited too_large stale consent_required expired locked unavailable internal`.

## Identity

- `room.create` returns a durable **member id + token**. Only the SHA-256 of the token is stored.
- `room.join` (password) creates a pending **join request** (expires in 5 min) and returns a one-time **claim secret**; the
  host decides with `room.decide`; the guest collects credentials with `room.claim`. Credentials are never broadcast.
- `room.resume {roomId, token}` rebinds a new socket to the same member after a reconnect or server restart. Presence is
  derived from live sockets and never persisted.
- Failed passwords are limited per IP+room and per room; every socket has a token-bucket request budget.

## Documents

The server holds one Yjs document per file; clients start from server state and never seed text themselves. A file is
created from plain text exactly once (`doc.seed`); a second seed returns the existing state. Sync is the standard
state-vector exchange (`doc.sync` / `doc.update`), also used for reconnect. Limits: 1 MB per file, 2 000 files and 25 MB
per room, 2 MB per update. Every path is checked by the same policy on server and client, and clients additionally
refuse symlink escapes.

## Lifecycle

| Event | Behaviour |
|---|---|
| Client disconnect | presence flips to offline; client retries and resumes by token |
| Server restart | rooms, documents, proposals, consent survive; clients auto-resume; stale presence is gone |
| Idle expiry | members receive `room-closed`, sockets are evicted, tokens stop working, status `closed`; data purged after the retention period |
| Host disconnects | the room stays open (join requests queue); the host resumes later |
| Host `leave` | closes the room (or `--keep-open` to stop syncing only) |

## Not in the MVP

WebRTC / P2P (the old `/signal` namespace was removed), end-to-end encryption, multi-instance scaling, SSO.
