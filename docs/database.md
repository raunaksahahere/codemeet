# Bring your own PostgreSQL

CodeMeet stores rooms, documents, proposals, consent and messages in **a PostgreSQL database that you own**.
It needs a **Postgres connection string** (`postgresql://USER:PASSWORD@HOST:PORT/DBNAME`). It does **not** accept
HTTP API keys: a Supabase anon/publishable key, a Supabase service-role key or a Neon API key is *not* a database
password, and `codemeet init` rejects them with an explanation.

The database sits **behind the server**. Collaborators never receive it: they only need the **server URL** and a
room password. If the database is configured but unreachable, the server refuses to start — there is no silent fallback
to in-memory storage.

All three options use the same persistence layer and the same migrations.

## Where the secret lives

| What | Where | Protection |
|---|---|---|
| `DATABASE_URL` | environment, or `~/.codemeet/server.env` written by `codemeet init` | file mode `0600`, directory `0700`; never sent over the network; stripped from agent child processes; redacted from every error message |

## Local PostgreSQL (Docker)

```bash
docker compose up -d postgres                 # CODEMEET_PG_PORT=5433 docker compose up -d postgres  if 5432 is taken
export DATABASE_URL='postgresql://codemeet:codemeet-local-dev@127.0.0.1:5432/codemeet?sslmode=disable'
codemeet init --database-url-env DATABASE_URL --migrate
codemeet server start --host 0.0.0.0          # or: docker compose --profile server up -d
```

Change the example password for anything beyond a laptop (`CODEMEET_PG_PASSWORD=… docker compose up -d postgres`).

## Neon

Checked against Neon's *Connect from any app* documentation.

1. In the Neon Console choose your project/branch and click **Connect**.
2. Copy the connection string. Neon requires TLS, so it ends with `sslmode=require` (it may also include `channel_binding=require`).
3. Pooled connections add `-pooler` to the hostname (PgBouncer, transaction mode). Prefer the **direct** string (turn the
   *Connection pooling* toggle off) — at least for `codemeet db migrate`, which takes a session-level advisory lock.
4. ```bash
   export DATABASE_URL='postgresql://USER:PASSWORD@ep-xxxx.REGION.aws.neon.tech/DBNAME?sslmode=require'
   codemeet init --database-url-env DATABASE_URL --migrate
   ```

TLS certificates are verified against Node's trust store; Neon's are publicly trusted, so nothing else is needed.

## Supabase

Checked against Supabase's *Connect to your database* documentation.

1. Dashboard → **Connect** → choose a method and copy the string. Replace the password placeholder and percent-encode
   reserved characters (`& # ? @ /` and spaces) in the password.
   - **Direct** `db.<ref>.supabase.co:5432`, user `postgres` — **IPv6 only** unless your project has the IPv4 add-on.
   - **Session pooler** `aws-…pooler.supabase.com:5432`, user `postgres.<ref>` — IPv4 on all plans. **Recommended** for CodeMeet.
   - **Transaction pooler** (port 6543) works for the running server, but run migrations over direct or session mode.
2. Supabase's server certificate is signed by its own CA, which Node does not trust by default. Download the root
   certificate from **Database settings** and point CodeMeet at it (verification stays on):
   ```bash
   export DATABASE_URL='postgresql://postgres.PROJECT_REF:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres?sslmode=require'
   export CODEMEET_DB_SSL_CA_FILE=$HOME/supabase-root.crt
   codemeet init --database-url-env DATABASE_URL --migrate
   ```
   Put `CODEMEET_DB_SSL_CA_FILE=…` in `~/.codemeet/server.env` to make it permanent.

> **Status:** the hosted Neon and Supabase paths are implemented against the providers' documentation but **have not been
> verified against real hosted projects** (no credentials were available). Local PostgreSQL is verified. If a hosted
> connection fails, `codemeet db check` prints a redacted, actionable error — please report what it says.

## Operations

| Task | Command |
|---|---|
| Check connectivity + schema | `codemeet db check` (exit 2 if migrations are pending) |
| Apply migrations | `codemeet db migrate` (advisory-locked; safe to run concurrently) |
| Start and migrate in one go | `codemeet server start --migrate` |
| Liveness / readiness | `GET /healthz` · `GET /readyz` (503 while the DB is unreachable or the schema is behind) |
| Retention | closed rooms are purged after `CODEMEET_RETENTION_DAYS` (default 7) |
| Idle expiry | rooms close after `CODEMEET_ROOM_TTL_MINUTES` (default 720) of inactivity; members are notified and evicted |

Presence is **never persisted**: after a restart everyone shows offline until their client reconnects (clients resume
automatically with their durable token).

## Troubleshooting

| Error | Meaning |
|---|---|
| `DATABASE_URL is not a valid URL … API key` | You pasted an API key. Use the Postgres string. |
| `authentication failed: check the user and password` | Wrong role/password (check percent-encoding). |
| `host not found` / timeout on Supabase | Direct host is IPv6-only: use the **Session pooler** string. |
| `TLS problem: hosted providers need sslmode=require` | Self-signed chain: supply `CODEMEET_DB_SSL_CA_FILE`; do not disable verification. |
| `Database schema is behind` | Run `codemeet db migrate` (or start with `--migrate`). |
