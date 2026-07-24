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

function sanitize(text) {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')   // strip any markup (mrkdwn *bold*/`code` survive)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Post a one-line operational alert to SLACK_WEBHOOK_URL.
 * `title` is trusted app-authored mrkdwn (kept as-is, newline-separated);
 * `detail` is untrusted (error messages, API bodies) — sanitized and capped.
 */
async function postSlackAlert(title, detail = null) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { posted: false, reason: 'no_webhook' };

  let text = String(title ?? '').trim();
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

module.exports = { postSlackAlert, sanitize, MAX_ALERT_CHARS };
