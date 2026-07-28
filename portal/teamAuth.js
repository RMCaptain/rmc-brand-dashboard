'use strict';
/**
 * Team Google sign-in — replaces the shared Basic Auth password for humans.
 *
 * Flow: /team-login.html renders a Google Identity Services button →
 * POST /api/team/google with the Google ID token → verified against Google's
 * tokeninfo endpoint (aud must equal GOOGLE_CLIENT_ID, email must be
 * verified) → allowlist check → our own 30-day session cookie (rmc_team;
 * 32 random bytes, SHA-256 hex at rest — same discipline as portal/auth.js).
 *
 * Config (all env):
 *   GOOGLE_CLIENT_ID     — enables Google sign-in; absent = feature dark,
 *                          Basic Auth continues exactly as before.
 *   TEAM_ALLOWED_DOMAIN  — hosted-domain allowlist (default rockymountainco.ca)
 *   TEAM_ALLOWED_EMAILS  — comma-separated extra emails (contractors etc.)
 *   TEAM_BASIC_AUTH=off  — kills the shared-password fallback once the whole
 *                          team is on Google. Until then Basic Auth stays as
 *                          the machine/break-glass path.
 */

const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME    = 'rmc_team';

function newToken() { return crypto.randomBytes(32).toString('base64url'); }
function hashToken(raw) { return crypto.createHash('sha256').update(String(raw)).digest('hex'); }

function googleEnabled() { return !!process.env.GOOGLE_CLIENT_ID; }
function basicAuthEnabled() { return process.env.TEAM_BASIC_AUTH !== 'off'; }

function allowedEmail(email, hd) {
  const domain = (process.env.TEAM_ALLOWED_DOMAIN || 'rockymountainco.ca').toLowerCase();
  const extras = String(process.env.TEAM_ALLOWED_EMAILS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const e = String(email || '').toLowerCase();
  if (!e.includes('@')) return false;
  if (extras.includes(e)) return true;
  if (domain && e.endsWith('@' + domain)) return true;
  // hd claim (Workspace hosted domain) is corroborating, never sufficient alone
  return false;
}

function readCookie(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE_NAME) return decodeURIComponent(v.join('='));
  }
  return null;
}

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

// Server-side verification via Google's tokeninfo endpoint. Google validates
// the signature; we validate the audience, verified-email flag, and expiry.
// Login-time only, so the extra HTTP round-trip costs nothing that matters.
async function verifyGoogleIdToken(idToken) {
  const res = await fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
  if (!res.ok) return null;
  const claims = await res.json().catch(() => null);
  if (!claims) return null;
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) return null;
  if (claims.email_verified !== 'true' && claims.email_verified !== true) return null;
  if (claims.exp && Number(claims.exp) * 1000 < Date.now()) return null;
  return { email: claims.email, name: claims.name || null, picture: claims.picture || null, hd: claims.hd || null };
}

async function createSession(supabase, identity) {
  const raw = newToken();
  const { error } = await supabase.from('team_sessions').insert({
    email: identity.email.toLowerCase(),
    name: identity.name,
    picture: identity.picture,
    token_hash: hashToken(raw),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    last_seen_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return raw;
}

async function getSession(supabase, req) {
  const raw = readCookie(req);
  if (!raw) return null;
  const { data, error } = await supabase
    .from('team_sessions')
    .select('id, email, name, picture, expires_at, revoked_at')
    .eq('token_hash', hashToken(raw))
    .maybeSingle();
  if (error || !data) return null;
  if (data.revoked_at || new Date(data.expires_at) < new Date()) return null;
  return data;
}

async function destroySession(supabase, req) {
  const raw = readCookie(req);
  if (!raw) return;
  await supabase.from('team_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', hashToken(raw));
}

/**
 * Public team-auth endpoints. Mount BEFORE the auth gate.
 */
function mountTeamAuth(app, { supabase, express }) {
  const json = express.json();

  // Login page needs the client id (or to know the feature is dark)
  app.get('/api/team/config', (req, res) => {
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
  });

  app.post('/api/team/google', json, async (req, res) => {
    try {
      if (!googleEnabled()) return res.status(503).json({ error: 'Google sign-in not configured' });
      const idToken = String(req.body?.credential || '');
      if (!idToken) return res.status(400).json({ error: 'Missing credential' });
      const identity = await verifyGoogleIdToken(idToken);
      if (!identity) return res.status(401).json({ error: 'Google token invalid' });
      if (!allowedEmail(identity.email, identity.hd)) {
        console.warn(`[TeamAuth] Denied sign-in for ${identity.email}`);
        return res.status(403).json({ error: 'This Google account is not on the team allowlist.' });
      }
      const raw = await createSession(supabase, identity);
      res.setHeader('Set-Cookie', sessionCookie(raw, req));
      console.log(`[TeamAuth] ${identity.email} signed in`);
      res.json({ ok: true, email: identity.email, name: identity.name });
    } catch (err) {
      console.error('[TeamAuth] google sign-in failed:', err.message);
      res.status(500).json({ error: 'Sign-in failed' });
    }
  });

  app.get('/api/team/me', async (req, res) => {
    const session = await getSession(supabase, req);
    res.json(session
      ? { signedIn: true, email: session.email, name: session.name, picture: session.picture }
      : { signedIn: false });
  });

  app.post('/api/team/logout', async (req, res) => {
    await destroySession(supabase, req);
    res.setHeader('Set-Cookie', sessionCookie('', req, { clear: true }));
    res.json({ ok: true });
  });
}

/**
 * The auth gate replacing bare basicAuth. Accepts, in order:
 *   1. a valid team session cookie (Google sign-in)
 *   2. Basic Auth (unless TEAM_BASIC_AUTH=off) — machines + break-glass
 * Otherwise: browser page loads redirect to /team-login.html; APIs get 401.
 * With neither AUTH_USERNAME nor GOOGLE_CLIENT_ID configured (local dev),
 * everything passes — same as the old behaviour.
 */
function teamAuthGate({ supabase, basicAuthCheck }) {
  return async function teamAuth(req, res, next) {
    const basicConfigured = !!(process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD);
    if (!basicConfigured && !googleEnabled()) return next(); // local dev

    if (googleEnabled()) {
      try {
        const session = await getSession(supabase, req);
        if (session) { req.teamUser = session; return next(); }
      } catch (_) { /* fall through to Basic */ }
    }

    if (basicConfigured && basicAuthEnabled() && basicAuthCheck(req)) return next();

    const wantsHtml = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (googleEnabled() && wantsHtml) return res.redirect('/team-login.html');

    if (basicConfigured && basicAuthEnabled()) {
      res.setHeader('WWW-Authenticate', 'Basic realm="RMC Dashboard"');
      return res.status(401).send('Authentication required');
    }
    return res.status(401).json({ error: 'Sign in required' });
  };
}

module.exports = { mountTeamAuth, teamAuthGate, googleEnabled };
