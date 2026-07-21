-- Brand portal auth — slice 1 of the client portal.
--
-- Brands sign in with a MAGIC LINK (emailed, single-use, 15-min expiry) and get
-- a long-lived session cookie. No passwords: nothing for external users to
-- forget, nothing for us to store or reset, and revoking access is deleting a
-- row rather than a credentials conversation. Team access (Basic Auth) is
-- untouched — this is a parallel identity for external brand users only.
--
-- SECURITY: tokens are never stored raw. Both login tokens and session tokens
-- store a SHA-256 hash; the raw value exists only in the emailed link / the
-- HttpOnly cookie. A database leak therefore leaks no usable credentials.

-- One row per external brand user. brand_id scopes everything they can see.
CREATE TABLE IF NOT EXISTS portal_users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  brand_id      TEXT NOT NULL,
  display_name  TEXT,
  invited_by    TEXT,                        -- who on the team created this
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  -- Soft revoke: kills future logins AND existing sessions (checked on every
  -- request) without losing the record of who had access.
  revoked_at    TIMESTAMPTZ
);

-- Single-use magic-link tokens. Short-lived by design.
CREATE TABLE IF NOT EXISTS portal_login_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,          -- sha256 hex of the raw token
  expires_at  TIMESTAMPTZ NOT NULL,          -- created_at + 15 minutes
  used_at     TIMESTAMPTZ,                   -- set on first (only) use
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Long-lived sessions minted when a magic link is redeemed.
CREATE TABLE IF NOT EXISTS portal_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES portal_users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,        -- sha256 hex of the cookie value
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,        -- created_at + 30 days
  last_seen_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS portal_login_tokens_hash_idx ON portal_login_tokens (token_hash);
CREATE INDEX IF NOT EXISTS portal_sessions_hash_idx     ON portal_sessions (token_hash);
CREATE INDEX IF NOT EXISTS portal_users_brand_idx       ON portal_users (brand_id);

-- Sanity check.
SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_name IN ('portal_users', 'portal_login_tokens', 'portal_sessions')
ORDER BY table_name, ordinal_position;
