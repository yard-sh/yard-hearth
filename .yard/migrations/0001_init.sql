-- Hearth schema. Every statement is idempotent: migration files are not
-- transactional, so a mid-file failure leaves the earlier statements applied
-- and the file unrecorded in _yard_migrations, which re-runs it from the top
-- on the next deploy. IF NOT EXISTS makes that re-run harmless.
--
-- Messages are not here. Each channel's messages live inside that channel's
-- object, which also holds its live connections; the database only knows the
-- structure: who exists, which servers there are, who belongs to them with
-- what role, and which channels each server has.

-- One row per person who has opened Hearth. username is the editable profile
-- field; the first visit derives one from the email the edge reports.
CREATE TABLE IF NOT EXISTS users (
  id       TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email    TEXT NOT NULL DEFAULT '',
  seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A server is what Discord calls a guild. Its id doubles as the join code, so
-- "share the ID to invite someone" needs no second concept.
CREATE TABLE IF NOT EXISTS servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers (owner_id);

-- Membership and the whole roles system: role is 'admin' or 'user'. The
-- creator is inserted as admin; everyone who joins by code starts as a user.
-- This table is the only authority on what someone may do in a server.
CREATE TABLE IF NOT EXISTS server_members (
  server_id TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'user',
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_user ON server_members (user_id);

CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_channels_server ON channels (server_id, created_at);
