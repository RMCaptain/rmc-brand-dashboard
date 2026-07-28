-- Team Google sign-in sessions.
--
-- Replaces the shared Basic Auth password for humans: team members sign in
-- with their Google account (verified server-side, allowlisted by domain
-- and/or explicit email list), and we mint our own session — same token
-- discipline as the brand portal (32 random bytes, only the SHA-256 hex at
-- rest, raw value lives in the HttpOnly cookie).
--
-- Basic Auth stays accepted as a machine/break-glass fallback until
-- TEAM_BASIC_AUTH=off is set (external tooling authenticates with it).

CREATE TABLE IF NOT EXISTS team_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL,
  name         text,
  picture      text,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS team_sessions_email_idx ON team_sessions (email);

SELECT COUNT(*) AS team_session_rows FROM team_sessions;
