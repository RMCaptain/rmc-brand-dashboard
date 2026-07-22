-- Portal slice 2: password logins.
--
-- Flow (Mike, 2026-07-21): team creates the account with a USERNAME when a
-- brand onboards; the brand's first visit (via invite link) forces them to set
-- their own password; thereafter they sign in with username-or-email +
-- password. Magic links remain as the recovery path — "email me a sign-in
-- link" IS forgot-password.
--
-- password_hash is scrypt (node built-in, memory-hard) with per-user salt,
-- format: scrypt$N$r$p$saltB64$hashB64. Never a raw or fast-hashed password.
-- password_set_at NULL = first login not completed → portal forces /portal/setup.
--
-- Additive only — safe on existing rows (Mike's account predates this and
-- simply has no password yet; his next portal visit routes through setup).

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS username        TEXT UNIQUE;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS password_hash   TEXT;
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMPTZ;

-- Sanity check.
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'portal_users'
ORDER BY ordinal_position;
