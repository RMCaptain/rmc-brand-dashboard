// Slack daily health digest — posts to SLACK_WEBHOOK_URL (Incoming Webhook).
// No-ops gracefully if the env var is not set.

const TYPE_META = {
  suppressed:       { label: 'Suppressed' },
  buybox_lost:      { label: 'Buy Box Lost' },
  unfulfillable:    { label: 'Stranded' },
  out_of_stock:     { label: 'Out of Stock' },
  low_stock:        { label: 'Low Stock' },
  content_changed:  { label: 'Content Changed' },
  variation_broken: { label: 'Variation Broken' },
  general_inactive: { label: 'Listing Inactive' },
};

const SEV_META = {
  critical: { label: 'CRITICAL' },
  warning:  { label: 'WARNINGS' },
  info:     { label: 'INFO' },
};

// Per-type top-N cap inside each severity section. Keeps the digest scannable when
// any one type explodes (e.g. 70 suppressed wouldn't drown out 47 buy box losses).
const PER_TYPE_CAP = 8;

// Ordering of types within a severity — most actionable first
const TYPE_PRIORITY = [
  'buybox_lost',     // active revenue loss to competitors
  'out_of_stock',    // active revenue loss to nothing
  'suppressed',      // listing dead
  'general_inactive',
  'unfulfillable',
  'variation_broken',
  'content_changed',
];

// Score alerts within a type so the most impactful surface first
function scoreAlert(a) {
  const d = a.detail || {};
  switch (a.type) {
    case 'buybox_lost':   return d.snapshots || 0;       // more snapshots = lost more consistently
    case 'out_of_stock':  return d.dailyVelocity || 0;
    case 'unfulfillable': return d.unfulfillable || 0;
    case 'low_stock':     return -(d.daysOfStock || 0);  // fewer days = worse
    case 'suppressed':    return 1;
    default:              return 0;
  }
}

function fmtAlert(a) {
  const shortTitle = (a.title || '').length > 70 ? a.title.slice(0, 70) + '…' : (a.title || '');
  return `*[${a.brandName}]* \`${a.asin}\` — ${a.message}` + (shortTitle ? `\n_${shortTitle}_` : '');
}

function buildHealthDigestBlocks({ alerts, summary, generatedAt, dashboardUrl }) {
  const date = new Date(generatedAt).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `RMC Brand Health · ${date}` } },
  ];

  if (summary.total === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '*All clear* — no listing issues detected across any brand.' }
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

    // Group by severity then by type
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
        text: { type: 'mrkdwn', text: `*${m.label}* · ${list.length}` }
      });

      // Bucket by type
      const byType = {};
      for (const a of list) (byType[a.type] = byType[a.type] || []).push(a);

      // Iterate types in priority order, fallback to any leftover types alphabetically
      const orderedTypes = [
        ...TYPE_PRIORITY.filter(t => byType[t]),
        ...Object.keys(byType).filter(t => !TYPE_PRIORITY.includes(t)).sort(),
      ];

      for (const type of orderedTypes) {
        const ts = byType[type];
        // Sort by impact, take top N
        ts.sort((a, b) => scoreAlert(b) - scoreAlert(a));
        const top = ts.slice(0, PER_TYPE_CAP);
        const extra = ts.length - top.length;
        const meta = TYPE_META[type] || { label: type };

        // Type subheader with count + breakdown of top brands
        const brandCounts = ts.reduce((m, a) => { m[a.brandName] = (m[a.brandName] || 0) + 1; return m; }, {});
        const brandStr = Object.entries(brandCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([b, c]) => `${b} ${c}`).join(', ');
        blocks.push({
          type: 'section',
          text: { type: 'mrkdwn', text: `*${meta.label}* · ${ts.length}${brandStr ? `  _(${brandStr}${Object.keys(brandCounts).length > 3 ? '…' : ''})_` : ''}` }
        });

        const lines = top.map(fmtAlert).join('\n\n');
        if (lines.length > 2800) {
          const half = Math.ceil(top.length / 2);
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: top.slice(0, half).map(fmtAlert).join('\n\n') } });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: top.slice(half).map(fmtAlert).join('\n\n') } });
        } else if (lines.length > 0) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } });
        }

        if (extra > 0) {
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_…and ${extra} more ${meta.label.toLowerCase()} on the dashboard._` }]
          });
        }
      }
    }
  }

  if (dashboardUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${dashboardUrl}|Open dashboard>` }]
    });
  }

  // Slack hard-caps a single message at 50 blocks — truncate gracefully if we exceed
  if (blocks.length > 50) {
    const overflow = blocks.length - 49;
    blocks.length = 49;
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_Truncated — ${overflow} more block${overflow !== 1 ? 's' : ''} cut. See dashboard._` }]
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
