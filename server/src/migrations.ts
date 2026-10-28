/** Ordered, append-only schema migrations. Never edit an applied migration; add a new one. */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE rooms (
  id            text PRIMARY KEY,
  password_hash text NOT NULL,
  scope         text NOT NULL CHECK (scope IN ('file','folder','workspace')),
  scope_path    text,
  codeignore    text NOT NULL DEFAULT '',
  project_name  text NOT NULL DEFAULT '',
  host_member_id text,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  close_reason  text,
  ttl_minutes   integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_activity timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  closed_at     timestamptz
);
CREATE INDEX rooms_active_expiry ON rooms (status, expires_at);

CREATE TABLE members (
  id              text PRIMARY KEY,
  room_id         text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('human','agent')),
  display_name    text NOT NULL,
  owner_member_id text,
  provider        text CHECK (provider IN ('claude','codex')),
  role            text NOT NULL CHECK (role IN ('host','member','agent')),
  token_hash      text,
  color           text NOT NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz
);
CREATE INDEX members_room ON members (room_id);

CREATE TABLE join_requests (
  id           text PRIMARY KEY,
  room_id      text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  claim_hash   text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','claimed')),
  member_id    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  decided_at   timestamptz
);
CREATE INDEX join_requests_room ON join_requests (room_id, status);

CREATE TABLE docs (
  room_id    text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  path       text NOT NULL,
  state      bytea NOT NULL,
  text_hash  text NOT NULL,
  size_bytes integer NOT NULL,
  deleted    boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, path)
);

CREATE TABLE proposals (
  id           text PRIMARY KEY,
  room_id      text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id     text NOT NULL,
  owner_id     text NOT NULL,
  provider     text NOT NULL,
  run_id       text NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','stale','superseded')),
  revision     integer NOT NULL DEFAULT 1,
  changes      jsonb NOT NULL,
  stale_reason text,
  decided_by   text,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, agent_id, run_id)
);

CREATE TABLE grants (
  id                text PRIMARY KEY,
  room_id           text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  grantor_member_id text NOT NULL,
  agent_id          text NOT NULL,
  peer_agent_id     text,
  permission        text NOT NULL,
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grants_room ON grants (room_id, permission);

CREATE TABLE messages (
  id            text PRIMARY KEY,
  seq           bigserial,
  room_id       text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  thread_id     text NOT NULL,
  in_reply_to   text,
  from_agent_id text NOT NULL,
  to_agent_id   text NOT NULL,
  client_msg_id text NOT NULL,
  body          text NOT NULL,
  state         text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','delivered','read','blocked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, from_agent_id, client_msg_id)
);
CREATE INDEX messages_thread ON messages (room_id, thread_id);

CREATE TABLE audit_events (
  seq         bigserial PRIMARY KEY,
  room_id     text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    text,
  actor_label text NOT NULL,
  kind        text NOT NULL,
  path        text,
  summary     text NOT NULL
);
CREATE INDEX audit_room ON audit_events (room_id, seq);
`,
  },
];
