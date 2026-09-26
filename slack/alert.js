/**
 * Single choke point for operational Slack alerts.
 *
 * Every ad-hoc alert MUST go through postSlackAlert() — never fetch the
 * webhook directly. Guarantees:
 *   1. Sanitized: HTML stripped, whitespace collapsed. Error messages can be
 *      entire HTML pages (Supabase's Cloudflare 522 page got posted verbatim
 *      into #account-health on 2026-07-24 — never again).
 *   2. Bounded: hard cap per message, so no payload dump ever floods the channel.
 *   3. Non-throwing: alerting must never break the caller.
 */

const MAX_ALERT_CHARS = 600;

// Repeat throttle: a persistent failure (Supabase egress restriction,
// 2026-09-26: the same daily_metrics alert every 15 minutes for hours) fires
// its alert on every cron tick. Identical titles post once per window; when
// the window rolls over, the next post says how many were swallowed.
// In-memory — a restart re-alerts once, which is fine.
const REPEAT_WINDOW_MS = 6 * 60 * 60 * 1000;
const recentAlerts = new Map(); // title → { at, suppressed }

function sanitize(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')   // strip any markup (mrkdwn *bold*/`code` survive)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Post a one-line operational alert to SLACK_WEBHOOK_URL (#account-health).
 * `title` is trusted app-authored mrkdwn (kept as-is, newline-separated);
 * `detail` is untrusted (error messages, API bodies) — sanitized and capped.
 */
async function postSlackAlert(title, detail = null) {
  return postTo(process.env.SLACK_WEBHOOK_URL, title, detail);
}

/**
 * Data-quality alerts (ads accuracy, master-sheet writes, mirror drift) belong
 * in #data-integrity — SLACK_INTEGRITY_WEBHOOK_URL, the same channel the
 * nightly integrity checks and the revenue reconciler post to. Falls back to
 * the health webhook so an alert never silently drops.
 */
async function postDataIntegrityAlert(title, detail = null) {
  return postTo(process.env.SLACK_INTEGRITY_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL, title, detail);
}

async function postTo(webhook, title, detail) {
  if (!webhook) return { posted: false, reason: 'no_webhook' };

  const key = String(title ?? '').trim();
  const seen = recentAlerts.get(key);
  const now = Date.now();
  let repeatNote = '';
  if (seen && now - seen.at < REPEAT_WINDOW_MS) {
    seen.suppressed++;
    return { posted: false, reason: 'throttled', suppressed: seen.suppressed };
  }
  if (seen?.suppressed) repeatNote = `\n_repeated ${seen.suppressed}× in the last ${Math.round((now - seen.at) / 3600000)}h — still failing_`;
  recentAlerts.set(key, { at: now, suppressed: 0 });
  if (recentAlerts.size > 200) recentAlerts.delete(recentAlerts.keys().next().value);

  let text = String(title ?? '').trim() + repeatNote;
  if (detail != null) {
    const clean = sanitize(detail);
    const capped = clean.length > MAX_ALERT_CHARS ? clean.slice(0, MAX_ALERT_CHARS) + '…' : clean;
    if (capped) text += `\n\`${capped}\``;
  }
  // Absolute backstop regardless of how the title was built.
  if (text.length > 3000) text = text.slice(0, 3000) + '…';

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) console.warn('[SlackAlert] webhook HTTP', res.status);
    return { posted: res.ok };
  } catch (e) {
    console.warn('[SlackAlert] post failed:', e.message);
    return { posted: false, reason: 'fetch_error' };
  }
}

module.exports = { postSlackAlert, postDataIntegrityAlert, sanitize, MAX_ALERT_CHARS };
