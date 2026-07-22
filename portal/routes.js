'use strict';
/**
 * Brand portal routes — slice 1: auth + login + minimal landing.
 *
 * Two mounts, and the split is the security model:
 * - mountPublic(app, deps)  → registered BEFORE Basic Auth. The login page,
 *   magic-link endpoints, and session-guarded portal surface. A brand session
 *   grants access ONLY to these routes — never to the team dashboard. Every
 *   data route here derives brand_id from the SESSION, not from a parameter,
 *   so there is nothing to tamper with.
 * - mountAdmin(app, deps)   → registered after Basic Auth like every team
 *   route. Create/list/revoke portal users, mint invite links.
 *
 * Until an email provider is configured (portal/email.js), the delivery path
 * is: team creates the user → gets a one-time invite link → sends it to the
 * brand themselves. Same tokens, same flow — just manual delivery.
 */

const path = require('path');
const auth = require('./auth');
const email = require('./email');

const EXPIRES_MINUTES = Math.round(auth.LOGIN_TOKEN_TTL_MS / 60000);

// Periods a brand may request a PDF for. Mirrors the report UI's presets.
const PORTAL_PERIODS = new Set(['lastMonth', 'mtd', 'last7d', 'last30d', 'last90d']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function baseUrl(req) {
  if (process.env.PORTAL_BASE_URL) return process.env.PORTAL_BASE_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  return `${proto}://${req.get('host')}`;
}

function mountPublic(app, { supabase, loadBrands, generateBrandReportPdf, buildBrandReportDataset, trySelectSummary, express }) {
  const json = express.json();

  // Session middleware for portal-only routes. Never falls through to team
  // auth — a missing/invalid session on an API is a 401, on a page a redirect.
  async function requireSession(req, res, next) {
    try {
      const s = await auth.getSession(supabase, auth.readSessionCookie(req));
      if (!s) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
        return res.redirect('/portal/login');
      }
      req.portalUser = s.user;
      next();
    } catch (err) {
      console.error('[Portal] session check failed:', err.message);
      res.status(500).json({ error: 'Session check failed' });
    }
  }

  // ── Pages + assets (public) ────────────────────────────────────────────────
  app.get('/portal/login', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'portal-login.html')));
  // Logo without Basic Auth — the login page renders before any identity exists.
  app.get('/portal/logo.png', (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'rmc-logo.png')));

  app.get('/portal', requireSession, (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'portal.html')));

  // First-login password setup (also reachable later = change password).
  app.get('/portal/setup', requireSession, (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'portal-setup.html')));

  // The live report — slice 2's headline. Read-only, scoped by session.
  app.get('/portal/report', requireSession, (req, res) =>
    res.sendFile(path.join(__dirname, '..', 'public', 'portal-report.html')));

  // ── Password sign-in (public, rate-limited) ────────────────────────────────
  // Identifier = username OR email. One generic failure message for every
  // failure mode — wrong user, wrong password, revoked, or no password set yet.
  app.post('/api/portal/login', json, async (req, res) => {
    try {
      const ident = String(req.body?.identifier || '').trim().toLowerCase();
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      if (auth.rateLimited(`pw:${ident}`, 10, 15 * 60 * 1000) ||
          auth.rateLimited(`pwip:${ip}`, 30, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
      }
      const result = await auth.passwordLogin(supabase, ident, String(req.body?.password || ''));
      if (!result) return res.status(401).json({ error: 'Invalid username or password.' });
      res.setHeader('Set-Cookie', auth.sessionCookie(result.rawSession, req));
      res.json({ ok: true });
    } catch (err) {
      console.error('[Portal] login failed:', err.message);
      res.status(500).json({ error: 'Sign-in failed — please try again.' });
    }
  });

  // Set (or change) password. Requires a live session — reached either from an
  // invite-link session (first login) or an existing signed-in session.
  app.post('/api/portal/set-password', json, requireSession, async (req, res) => {
    try {
      const pw = String(req.body?.password || '');
      if (pw.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      const hash = await auth.hashPassword(pw);
      const { error } = await supabase.from('portal_users')
        .update({ password_hash: hash, password_set_at: new Date().toISOString() })
        .eq('id', req.portalUser.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Portal] set-password failed:', err.message);
      res.status(500).json({ error: 'Could not save the password — please try again.' });
    }
  });

  // Live report dataset — the EXACT same builder the team report uses, with the
  // brand forced from the session and the saved summary bundled in so the
  // portal renders in one fetch. Read-only by construction: this route only
  // reads, and no portal route writes report data.
  app.get('/api/portal/report-dataset', requireSession, async (req, res) => {
    try {
      const q = {};
      const { from, to, period } = req.query;
      if (from && to && ISO_DATE.test(from) && ISO_DATE.test(to)) { q.from = from; q.to = to; }
      else q.period = PORTAL_PERIODS.has(period) ? period : 'lastMonth';

      const dataset = await buildBrandReportDataset(req.portalUser.brand_id, q);
      let summaryText = null;
      try {
        const row = await trySelectSummary(req.portalUser.brand_id, dataset.period.from, dataset.period.to);
        summaryText = row?.summary_text || null;
      } catch {}
      res.json({ ...dataset, portalSummaryText: summaryText });
    } catch (err) {
      console.error('[Portal] report-dataset failed:', err.message);
      res.status(err.status || 500).json({ error: 'Could not load the report.' });
    }
  });

  // ── Magic-link request (public, rate-limited, no user enumeration) ─────────
  app.post('/api/portal/request-link', json, async (req, res) => {
    // The response is IDENTICAL whether or not the email exists — a probe
    // learns nothing about which addresses have portal access.
    const generic = { ok: true, message: 'If that email has portal access, a sign-in link is on its way.' };
    try {
      const reqEmail = String(req.body?.email || '').trim().toLowerCase();
      if (!reqEmail || !reqEmail.includes('@')) return res.json(generic);

      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
      if (auth.rateLimited(`email:${reqEmail}`, 5, 15 * 60 * 1000) ||
          auth.rateLimited(`ip:${ip}`, 20, 15 * 60 * 1000)) {
        return res.status(429).json({ error: 'Too many requests — try again in a few minutes.' });
      }

      const { data: user, error } = await supabase
        .from('portal_users')
        .select('id, email, brand_id, revoked_at')
        .eq('email', reqEmail)
        .maybeSingle();
      if (error) {
        // Table missing or query failure: still answer generically. The page
        // must not reveal server internals to an unauthenticated caller.
        if (!auth.isMigrationError(error)) console.error('[Portal] request-link lookup:', error.message);
        return res.json(generic);
      }
      if (!user || user.revoked_at) return res.json(generic);

      const raw = await auth.createLoginToken(supabase, user.id);
      const link = `${baseUrl(req)}/api/portal/auth?token=${raw}`;

      let brandName = user.brand_id;
      try {
        const { brands } = await loadBrands();
        brandName = brands.find(b => b.id === user.brand_id)?.name || user.brand_id;
      } catch {}

      await email.sendLoginLink({ to: user.email, brandName, link, expiresMinutes: EXPIRES_MINUTES });
      res.json(generic);
    } catch (err) {
      console.error('[Portal] request-link failed:', err.message);
      res.json(generic);
    }
  });

  // ── Magic-link redemption ──────────────────────────────────────────────────
  app.get('/api/portal/auth', async (req, res) => {
    try {
      const result = await auth.redeemLoginToken(supabase, String(req.query.token || ''));
      if (!result) return res.redirect('/portal/login?error=expired');
      res.setHeader('Set-Cookie', auth.sessionCookie(result.rawSession, req));
      res.redirect('/portal');
    } catch (err) {
      if (err.migration) return res.redirect('/portal/login?error=setup');
      console.error('[Portal] auth failed:', err.message);
      res.redirect('/portal/login?error=expired');
    }
  });

  // ── Session APIs (brand-scoped BY SESSION — no brand parameter exists) ─────
  app.get('/api/portal/me', requireSession, async (req, res) => {
    let brandName = req.portalUser.brand_id;
    try {
      const { brands } = await loadBrands();
      brandName = brands.find(b => b.id === req.portalUser.brand_id)?.name || brandName;
    } catch {}
    res.json({
      email: req.portalUser.email,
      username: req.portalUser.username || null,
      displayName: req.portalUser.display_name || null,
      brandId: req.portalUser.brand_id,
      brandName,
      // false → portal front-end forces /portal/setup before anything else.
      passwordSet: !!req.portalUser.password_set_at,
    });
  });

  app.post('/api/portal/logout', async (req, res) => {
    try { await auth.revokeSession(supabase, auth.readSessionCookie(req)); } catch {}
    res.setHeader('Set-Cookie', auth.sessionCookie('', req, { clear: true }));
    res.json({ ok: true });
  });

  // Saved reports for THEIR brand only. Snapshot metadata, not content — the
  // deliverable is the PDF below.
  app.get('/api/portal/archives', requireSession, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('brand_report_archives')
        .select('id, period_from, period_to, period_label, generated_at')
        .eq('brand_id', req.portalUser.brand_id)
        .eq('is_saved_report', true)
        .order('period_to', { ascending: false })
        .limit(24);
      if (error) return res.json({ archives: [] });
      res.json({ archives: data || [] });
    } catch { res.json({ archives: [] }); }
  });

  // PDF of THEIR report. brandId comes from the session; period/dates are the
  // only caller inputs and are whitelisted/shape-checked here (deep validation
  // happens in the report pipeline).
  app.get('/api/portal/report.pdf', requireSession, async (req, res) => {
    try {
      const q = { brandId: req.portalUser.brand_id };
      const { from, to, period } = req.query;
      if (from && to) {
        if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
          return res.status(400).json({ error: 'Dates must be YYYY-MM-DD' });
        }
        q.from = from; q.to = to;
      } else {
        q.period = PORTAL_PERIODS.has(period) ? period : 'lastMonth';
      }
      const { pdfData, filename } = await generateBrandReportPdf(q);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(pdfData);
    } catch (err) {
      console.error('[Portal] report.pdf failed:', err.message);
      res.status(500).json({ error: 'Could not generate the report PDF. Please try again.' });
    }
  });
}

function mountAdmin(app, { supabase, loadBrands }) {
  // Everything here sits behind team Basic Auth (mounted after it in server.js).

  const dupUsernameMsg = (error) =>
    /username/i.test(String(error.message)) && /duplicate|unique/i.test(String(error.message))
      ? 'That username is taken — pick another.'
      : error.message;

  async function freshInviteLink(req, userId) {
    const raw = await auth.createLoginToken(supabase, userId);
    return `${baseUrl(req)}/api/portal/auth?token=${raw}`;
  }

  // Create a portal user for a brand → returns a one-time invite link.
  // Recreating a revoked user restores them instead of erroring.
  app.post('/api/portal/users', async (req, res) => {
    try {
      const emailAddr = String(req.body?.email || '').trim().toLowerCase();
      const brandId = String(req.body?.brand_id || '').trim();
      const displayName = String(req.body?.display_name || '').trim() || null;
      if (!emailAddr.includes('@')) return res.status(400).json({ error: 'Valid email required' });
      // Username the team hands the brand ("I generate a username for them").
      // Defaults to the brand id. Stored lowercase; login accepts it or email.
      const username = (String(req.body?.username || '').trim() || brandId).toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 2-31 chars: letters, numbers, dots, dashes.' });
      }

      const { brands } = await loadBrands();
      if (!brands.find(b => b.id === brandId)) {
        return res.status(404).json({ error: `Brand '${brandId}' not found` });
      }

      const { data: existing, error: exErr } = await supabase
        .from('portal_users').select('id, brand_id, revoked_at').eq('email', emailAddr).maybeSingle();
      if (exErr) throw auth.isMigrationError(exErr) ? auth.migrationError() : new Error(exErr.message);

      let userId;
      if (existing) {
        if (!existing.revoked_at) {
          return res.status(409).json({ error: 'That email already has portal access. Use invite-link to resend, or revoke first.' });
        }
        const { error } = await supabase.from('portal_users')
          .update({ revoked_at: null, brand_id: brandId, display_name: displayName, username })
          .eq('id', existing.id);
        if (error) throw new Error(dupUsernameMsg(error));
        userId = existing.id;
      } else {
        const { data, error } = await supabase.from('portal_users')
          .insert({ email: emailAddr, brand_id: brandId, display_name: displayName, username, invited_by: 'team' })
          .select('id').single();
        if (error) throw new Error(dupUsernameMsg(error));
        userId = data.id;
      }

      const invite_link = await freshInviteLink(req, userId);
      res.json({
        ok: true, user_id: userId, email: emailAddr, username, brand_id: brandId, invite_link,
        note: email.isConfigured()
          ? 'Link also usable directly; brand can self-serve via the login page.'
          : `Email sending is not configured — copy this link and send it to the brand. It expires in ${EXPIRES_MINUTES} minutes; mint a fresh one anytime with invite-link.`,
      });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.get('/api/portal/users', async (req, res) => {
    try {
      const { data, error } = await supabase
        .from('portal_users')
        .select('id, email, username, brand_id, display_name, created_at, last_login_at, revoked_at, password_set_at')
        .order('created_at', { ascending: false });
      if (error) throw auth.isMigrationError(error) ? auth.migrationError() : new Error(error.message);
      const { brands } = await loadBrands();
      const nameOf = Object.fromEntries(brands.map(b => [b.id, b.name]));
      res.json({ users: (data || []).map(u => ({ ...u, brand_name: nameOf[u.brand_id] || u.brand_id })) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/portal/users/:id/invite-link', async (req, res) => {
    try {
      const { data: user, error } = await supabase
        .from('portal_users').select('id, revoked_at').eq('id', req.params.id).maybeSingle();
      if (error) throw auth.isMigrationError(error) ? auth.migrationError() : new Error(error.message);
      if (!user) return res.status(404).json({ error: 'Portal user not found' });
      if (user.revoked_at) return res.status(409).json({ error: 'User is revoked — restore first' });
      res.json({ ok: true, invite_link: await freshInviteLink(req, user.id), expires_minutes: EXPIRES_MINUTES });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Revoke = kill the account AND every live session, immediately.
  app.post('/api/portal/users/:id/revoke', async (req, res) => {
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabase.from('portal_users')
        .update({ revoked_at: now }).eq('id', req.params.id).select('id');
      if (error) throw auth.isMigrationError(error) ? auth.migrationError() : new Error(error.message);
      if (!data?.length) return res.status(404).json({ error: 'Portal user not found' });
      await supabase.from('portal_sessions').update({ revoked_at: now }).eq('user_id', req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  app.post('/api/portal/users/:id/restore', async (req, res) => {
    try {
      const { data, error } = await supabase.from('portal_users')
        .update({ revoked_at: null }).eq('id', req.params.id).select('id');
      if (error) throw auth.isMigrationError(error) ? auth.migrationError() : new Error(error.message);
      if (!data?.length) return res.status(404).json({ error: 'Portal user not found' });
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });
}

module.exports = { mountPublic, mountAdmin };
