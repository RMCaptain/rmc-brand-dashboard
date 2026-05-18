// Slack daily health digest — posts to SLACK_WEBHOOK_URL (Incoming Webhook).
// No-ops gracefully if the env var is not set.

const TYPE_META = {
  suppressed:    { icon: ':no_entry:',         label: 'Suppressed' },
  buybox_lost:   { icon: ':red_circle:',       label: 'Buy Box Lost' },
  unfulfillable: { icon: ':warning:',          label: 'Stranded' },
  out_of_stock:  { icon: ':package:',          label: 'Out of Stock' },
  low_stock:     { icon: ':hourglass_flowing_sand:', label: 'Low Stock' },
  // Phase 2 / 3 — wired here so future types render correctly:
  content_changed:   { icon: ':pencil2:',  label: 'Content Changed' },
  variation_broken:  { icon: ':link:',     label: 'Variation Broken' },
  general_inactive:  { icon: ':lock:',     label: 'Listing Inactive' },
};

const SEV_META = {
  critical: { label: 'CRITICAL', emoji: ':rotating_light:' },
  warning:  { label: 'WARNINGS', emoji: ':warning:' },
  info:     { label: 'INFO',     emoji: ':information_source:' },
};

// Cap per-severity to keep Slack message under block + char limits
const PER_SEV_CAP = 25;

function fmtAlert(a) {
  const t = TYPE_META[a.type] || { icon: ':bell:', label: a.type };
  const shortTitle = (a.title || '').length > 60 ? a.title.slice(0, 60) + '…' : (a.title || '');
  return `${t.icon} *[${a.brandName}]* \`${a.asin}\` — ${a.message}` + (shortTitle ? `\n_${shortTitle}_` : '');
}

function buildHealthDigestBlocks({ alerts, summary, generatedAt, dashboardUrl }) {
  const date = new Date(generatedAt).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `RMC Brand Health · ${date}` } },
  ];

  if (summary.total === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: ':white_check_mark: *All clear* — no listing issues detected across any brand.' }
    });
  } else {
    const summaryParts = [];
    if (summary.critical > 0) summaryParts.push(`*${summary.critical} critical*`);
    if (summary.warning > 0)  summaryParts.push(`*${summary.warning} warnings*`);
    summaryParts.push(`${summary.brandsAffected} brand${summary.brandsAffected !== 1 ? 's' : ''} affected`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryParts.join(' · ') }
    });

    // Group by severity
    const grouped = {};
    for (const a of alerts) {
      (grouped[a.severity] = grouped[a.severity] || []).push(a);
    }

    for (const sev of ['critical', 'warning', 'info']) {
      const list = grouped[sev];
      if (!list?.length) continue;
      const m = SEV_META[sev];
      blocks.push({ type: 'divider' });
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `${m.emoji} *${m.label}* · ${list.length}` }
      });

      // Group within severity by type so similar issues cluster together
      const byType = {};
      for (const a of list) (byType[a.type] = byType[a.type] || []).push(a);

      let printed = 0;
      const cappedExtra = [];
      for (const [type, ts] of Object.entries(byType)) {
        if (printed >= PER_SEV_CAP) { cappedExtra.push(...ts); continue; }
        const slice = ts.slice(0, PER_SEV_CAP - printed);
        const lines = slice.map(fmtAlert).join('\n\n');
        // Slack section text limit is 3000 chars — chunk if needed
        if (lines.length > 2800) {
          const half = Math.ceil(slice.length / 2);
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slice.slice(0, half).map(fmtAlert).join('\n\n') } });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: slice.slice(half).map(fmtAlert).join('\n\n') } });
        } else {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } });
        }
        printed += slice.length;
        if (ts.length > slice.length) cappedExtra.push(...ts.slice(slice.length));
      }

      if (cappedExtra.length > 0) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `_…and ${cappedExtra.length} more — see the dashboard._` }]
        });
      }
    }
  }

  if (dashboardUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${dashboardUrl}|Open dashboard>` }]
    });
  }

  return blocks;
}

async function postSlackDigest({ alerts, summary, generatedAt, dashboardUrl }) {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.log('[Slack] SLACK_WEBHOOK_URL not set — skipping digest');
    return { posted: false, reason: 'no_webhook' };
  }

  const blocks = buildHealthDigestBlocks({ alerts, summary, generatedAt, dashboardUrl });
  // Plain-text fallback for notifications + clients that can't render blocks
  const fallback = summary.total === 0
    ? `RMC Brand Health: All clear — no issues today.`
    : `RMC Brand Health: ${summary.critical} critical, ${summary.warning} warnings, ${summary.brandsAffected} brands affected.`;

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: fallback, blocks })
    });
    const body = await res.text();
    if (!res.ok || body !== 'ok') {
      console.error('[Slack] webhook response:', res.status, body);
      return { posted: false, reason: 'webhook_error', status: res.status, body };
    }
    console.log('[Slack] Digest posted —', fallback);
    return { posted: true };
  } catch (err) {
    console.error('[Slack] post failed:', err.message);
    return { posted: false, reason: 'fetch_error', error: err.message };
  }
}

module.exports = { buildHealthDigestBlocks, postSlackDigest };
