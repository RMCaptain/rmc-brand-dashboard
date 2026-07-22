'use strict';
/**
 * Brand portal auth — magic-link tokens + session cookies.
 *
 * Design (see sql/portal-auth.sql for the schema rationale):
 * - Tokens are 32 random bytes, base64url. Only their SHA-256 hex is stored;
 *   the raw value lives in the emailed link / the HttpOnly cookie. Lookup is
 *   by hash, so no timing-sensitive string comparison ever happens on rows.
 * - Login links: single-use, 15-minute expiry.
 * - Sessions: 30 days, revocable per-session or by revoking the user.
 *
 * Every DB helper degrades cleanly when the migration hasn't run yet
 * (returns null / throws {status:503, migration:true}) so the app boots and
 * team routes keep working before sql/portal-auth.sql is applied.
 */

const crypto = require('crypto');

const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;          // 15 minutes
const SESSION_TTL_MS     = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME        = 'rmc_portal_session';

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function isMigrationError(error) {
  return /portal_users|portal_login_tokens|portal_sessions|relation .* does not exist/i
    .test(String(error?.message || ''));
}
function migrationError() {
  const e = new Error('Portal tables missing — run sql/portal-auth.sql first.');
  e.status = 503; e.migration = true;
  return e;
}

/** Minimal single-cookie parser — we only ever read our own cookie. */
function readSessionCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * Set-Cookie value for a session. HttpOnly always; Secure whenever the request
 * came over TLS (Render terminates TLS and sets x-forwarded-proto; localhost
 * dev stays non-secure so the cookie still works there). SameSite=Lax blocks
 * cross-site POSTs while letting the emailed link log you in on first click.
 */
function sessionCookie(rawToken, req, { clear = false } = {}) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const bits = [
    `${COOKIE_NAME}=${clear ? '' : encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** Create (or reuse) a login token for a user. Returns the RAW token. */
async function createLoginToken(supabase, userId) {
  const raw = newToken();
  const { error } = await supabase.from('portal_login_tokens').insert({
    user_id: userId,
    token_hash: hashToken(raw),
    expires_at: new Date(Date.now() + LOGIN_TOKEN_TTL_MS).toISOString(),
  });
  if (error) throw isMigrationError(error) ? migrationError() : new Error(error.message);
  return raw;
}

/**
 * Redeem a magic link: valid + unexpired + unused → mark used, mint a session.
 * The used_at guard is applied IN the update's WHERE, so two racing clicks on
 * the same link can't both mint sessions — only the row that transitions
 * used_at null→now wins.
 * Returns { rawSession, user } or null when the link is bad/expired/used.
 */
async function redeemLoginToken(supabase, rawToken) {
  const now = new Date().toISOString();
  const { data: rows, error } = await supabase
    .from('portal_login_tokens')
    .update({ used_at: now })
    .eq('token_hash', hashToken(rawToken))
    .is('used_at', null)
    .gt('expires_at', now)
    .select('user_id');
  if (error) throw isMigrationError(error) ? migrationError() : new Error(error.message);
  if (!rows || !rows.length) return null;

  const { data: user, error: uErr } = await supabase
    .from('portal_users')
    .select('id, email, brand_id, display_name, revoked_at')
    .eq('id', rows[0].user_id)
    .maybeSingle();
  if (uErr) throw new Error(uErr.message);
  if (!user || user.revoked_at) return null;

  const rawSession = newToken();
  const { error: sErr } = await supabase.from('portal_sessions').insert({
    user_id: user.id,
    token_hash: hashToken(rawSession),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    last_seen_at: now,
  });
  if (sErr) throw new Error(sErr.message);

  await supabase.from('portal_users').update({ last_login_at: now }).eq('id', user.id);
  return { rawSession, user };
}

/**
 * Resolve a session cookie to its user, or null. Checks session expiry AND
 * both revocation switches (session-level and user-level) on every request,
 * so revoking a brand takes effect immediately, not at cookie expiry.
 */
async function getSession(supabase, rawSession) {
  if (!rawSession) return null;
  const now = new Date().toISOString();
  const { data: s, error } = await supabase
    .from('portal_sessions')
    .select('id, user_id, expires_at, revoked_at')
    .eq('token_hash', hashToken(rawSession))
    .maybeSingle();
  if (error) { if (isMigrationError(error)) return null; throw new Error(error.message); }
  if (!s || s.revoked_at || s.expires_at <= now) return null;

  const { data: user, error: uErr } = await supabase
    .from('portal_users')
    .select('id, email, username, brand_id, display_name, revoked_at, password_set_at')
    .eq('id', s.user_id)
    .maybeSingle();
  if (uErr) throw new Error(uErr.message);
  if (!user || user.revoked_at) return null;

  // Fire-and-forget freshness stamp; a failed write must not fail the request.
  supabase.from('portal_sessions').update({ last_seen_at: now }).eq('id', s.id)
    .then(() => {}, () => {});
  return { sessionId: s.id, user };
}

/** Revoke one session (logout). */
async function revokeSession(supabase, rawSession) {
  if (!rawSession) return;
  await supabase.from('portal_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', hashToken(rawSession));
}

/**
 * In-memory rate limiter for the public request-link endpoint. Single-instance
 * deploy (Render), so memory is fine. Caps both per-email and per-IP.
 */
const _buckets = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const hits = (_buckets.get(key) || []).filter(t => now - t < windowMs);
  if (hits.length >= max) { _buckets.set(key, hits); return true; }
  hits.push(now);
  _buckets.set(key, hits);
  return false;
}

// ── Passwords (slice 2) ───────────────────────────────────────────────────────
// scrypt: built into node, memory-hard (unlike sha/bcrypt-less setups), zero
// new dependencies. Per-user random salt; parameters recorded in the stored
// string so they can be raised later without breaking existing hashes.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, dk) => {
      if (err) return reject(err);
      resolve(`scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    try {
      const [scheme, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
      if (scheme !== 'scrypt') return resolve(false);
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(hashB64, 'base64');
      crypto.scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p }, (err, dk) => {
        if (err) return resolve(false);
        resolve(crypto.timingSafeEqual(dk, expected));
      });
    } catch { resolve(false); }
  });
}

/**
 * Password sign-in: identifier is username OR email (both stored lowercase).
 * Returns { rawSession, user } or null — one null for every failure mode, so
 * the endpoint can only ever say "invalid credentials" (no probing which part
 * was wrong, no revealing that an account exists but has no password yet).
 */
async function passwordLogin(supabase, identifier, password) {
  const ident = String(identifier || '').trim().toLowerCase();
  if (!ident || !password) return null;
  const field = ident.includes('@') ? 'email' : 'username';
  const { data: user, error } = await supabase
    .from('portal_users')
    .select('id, email, username, brand_id, display_name, password_hash, revoked_at')
    .eq(field, ident)
    .maybeSingle();
  if (error) { if (isMigrationError(error)) return null; throw new Error(error.message); }
  if (!user || user.revoked_at || !user.password_hash) return null;
  if (!(await verifyPassword(password, user.password_hash))) return null;

  const now = new Date().toISOString();
  const rawSession = newToken();
  const { error: sErr } = await supabase.from('portal_sessions').insert({
    user_id: user.id,
    token_hash: hashToken(rawSession),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    last_seen_at: now,
  });
  if (sErr) throw new Error(sErr.message);
  await supabase.from('portal_users').update({ last_login_at: now }).eq('id', user.id);
  return { rawSession, user };
}

module.exports = {
  COOKIE_NAME, LOGIN_TOKEN_TTL_MS, SESSION_TTL_MS,
  newToken, hashToken, readSessionCookie, sessionCookie,
  createLoginToken, redeemLoginToken, getSession, revokeSession,
  rateLimited, isMigrationError, migrationError,
  hashPassword, verifyPassword, passwordLogin,
};
