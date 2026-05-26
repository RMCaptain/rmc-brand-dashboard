// Slack daily health digest — posts to SLACK_WEBHOOK_URL (Incoming Webhook).
// No-ops gracefully if the env var is not set.

// Strip Slack mrkdwn link syntax <url|text> → text
function stripLinks(str) {
  return (str || '').replace(/<[^|>]+\|([^>]+)>/g, '$1').replace(/<([^>]+)>/g, '$1');
}

// Shorten a product title: strip leading brand name prefix, truncate
function shortTitle(title, brandName) {
  if (!title) return '';
  let t = title;
  // Strip brand name prefix if present
  const brandRegex = new RegExp('^' + brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[-–,]?\\s*', 'i');
  t = t.replace(brandRegex, '').trim();
  return t.length > 55 ? t.slice(0, 55) + '…' : t;
}

// Extract seller names + FBA status from a buybox_lost message
// Message format: "Won by <url|Name> (FBA), <url|Name2>"
function parseWinners(message) {
  const raw = stripLinks(message || '');
  const body = raw.replace(/^Won by /i, '');
  return body.split(',').map(s => {
    const isFba = /\(FBA\)/i.test(s);
    const name = s.replace(/\s*\(FBA\)/gi, '').trim();
    return { name, isFba };
  }).filter(w => w.name);
}

// Build condensed per-brand bullet lines
function buildBrandLines(brandName, alerts) {
  const lines = [];

  // ── Stranded ──────────────────────────────────────────────────────────────
  const stranded = alerts.filter(a => a.type === 'stranded');
  for (const a of stranded) {
    const qty = a.detail?.qty || parseInt((a.message || '').match(/(\d+)/)?.[1] || '0', 10);
    const reason = a.detail?.reason ? ` (${a.detail.reason})` : '';
    lines.push(`Stranded: ${qty} unit${qty !== 1 ? 's' : ''} — ${shortTitle(a.title, brandName)}${reason}`);
  }

  // ── Suppressed ────────────────────────────────────────────────────────────
  const suppressed = alerts.filter(a => a.type === 'suppressed');
  for (const a of suppressed) {
    lines.push(`Suppressed: ${shortTitle(a.title, brandName)}`);
  }

  // ── Buybox lost ───────────────────────────────────────────────────────────
  const bbAlerts = alerts.filter(a => a.type === 'buybox_lost');
  if (bbAlerts.length) {
    // Count recurring sellers across all buybox losses for this brand
    const sellerCount = {};
    const sellerFba = {};
    for (const a of bbAlerts) {
      for (const w of parseWinners(a.message)) {
        if (!w.name || w.name.match(/^[A-Z0-9]{13,14}$/)) continue;
        sellerCount[w.name] = (sellerCount[w.name] || 0) + 1;
        sellerFba[w.name] = w.isFba;
      }
    }
    const recurring = Object.entries(sellerCount).filter(([, c]) => c >= 3).sort((a, b) => b[1] - a[1]);
    const nonFbaOutliers = bbAlerts
      .flatMap(a => parseWinners(a.message).filter(w => !w.isFba && !w.name.match(/^[A-Z0-9]{13,14}$/)))
      .map(w => w.name)
      .filter((v, i, arr) => arr.indexOf(v) === i);

    if (recurring.length && recurring[0][1] === bbAlerts.length) {
      // One seller sweeping everything
      const [seller, count] = recurring[0];
      const fba = sellerFba[seller] ? ' (FBA)' : ' (non-FBA)';
      lines.push(`All ${count} buybox losses → ${seller}${fba}`);
    } else if (recurring.length) {
      // Mix of recurring + isolated
      const recurringStr = recurring.map(([s, c]) => `${s} (${c} ASINs)`).join(', ');
      lines.push(`Recurring buybox winners: ${recurringStr}`);
      // List isolated losses individually
      const recurringNames = new Set(recurring.map(([s]) => s));
      const isolated = bbAlerts.filter(a => {
        const winners = parseWinners(a.message);
        return winners.every(w => !recurringNames.has(w.name));
      });
      for (const a of isolated) {
        const winners = parseWinners(a.message);
        const sellerStr = winners.map(w => w.name + (w.isFba ? ' (FBA)' : '')).join(', ');
        const price = a.detail?.winners?.[0]?.price ? ` @ $${a.detail.winners[0].price}` : '';
        lines.push(`Buybox lost on ${shortTitle(a.title, brandName)} → ${sellerStr}${price}`);
      }
    } else {
      // No recurring — list each individually
      for (const a of bbAlerts) {
        const winners = parseWinners(a.message);
        const sellerStr = winners.map(w => {
          const rawId = w.name.match(/^[A-Z0-9]{13,14}$/) ? `seller ID ${w.name}` : w.name;
          return rawId + (w.isFba ? ' (FBA)' : '');
        }).join(', ');
        const price = a.detail?.winners?.[0]?.price ? ` @ $${a.detail.winners[0].price}` : '';
        lines.push(`Buybox lost on ${shortTitle(a.title, brandName)} → ${sellerStr}${price}`);
      }
    }

    if (nonFbaOutliers.length) {
      lines.push(`Non-FBA outliers: ${nonFbaOutliers.join(', ')} — likely grey market / dropship`);
    }
  }

  // ── Unfulfillable ─────────────────────────────────────────────────────────
  const unfulfilAlerts = alerts.filter(a => a.type === 'unfulfillable');
  if (unfulfilAlerts.length) {
    const totalQty = unfulfilAlerts.reduce((sum, a) => {
      return sum + (a.detail?.unfulfillable || parseInt((a.message || '').match(/(\d+)/)?.[1] || '0', 10));
    }, 0);
    const qtys = unfulfilAlerts.map(a => a.detail?.unfulfillable || parseInt((a.message || '').match(/(\d+)/)?.[1] || '0', 10));
    const minQ = Math.min(...qtys);
    const maxQ = Math.max(...qtys);
    const qtyRange = minQ === maxQ ? `${minQ} unit${minQ !== 1 ? 's' : ''} each` : `${minQ}–${maxQ} units each`;
    lines.push(`${totalQty} unfulfillable unit${totalQty !== 1 ? 's' : ''} across ${unfulfilAlerts.length} SKU${unfulfilAlerts.length !== 1 ? 's' : ''} (${qtyRange})`);
  }

  // ── Out of stock ──────────────────────────────────────────────────────────
  const oos = alerts.filter(a => a.type === 'out_of_stock');
  for (const a of oos) {
    lines.push(`Out of stock: ${shortTitle(a.title, brandName)}`);
  }

  return lines;
}

// Cross-brand key patterns
function buildPatterns(alerts) {
  const patterns = [];

  // Recurring sellers across brands
  const sellerHits = {};
  for (const a of alerts) {
    if (a.type !== 'buybox_lost') continue;
    for (const w of parseWinners(a.message)) {
      if (!w.name || w.name.match(/^[A-Z0-9]{13,14}$/)) continue;
      if (!sellerHits[w.name]) sellerHits[w.name] = { count: 0, brands: new Set() };
      sellerHits[w.name].count++;
      sellerHits[w.name].brands.add(a.brandName);
    }
  }
  const recurring = Object.entries(sellerHits).filter(([, v]) => v.count >= 3).sort((a, b) => b[1].count - a[1].count);
  for (const [seller, data] of recurring) {
    const brandList = [...data.brands].join(', ');
    const across = data.brands.size > 1 ? `across ${data.brands.size} brands (${brandList})` : `across ${brandList}`;
    patterns.push(`*${seller}* is systematically winning the buybox on ${data.count} ASINs ${across} — worth flagging to the brand`);
  }

  // Unfulfillable noise check
  const unfulfTotal = alerts.filter(a => a.type === 'unfulfillable').reduce((s, a) => {
    return s + (a.detail?.unfulfillable || parseInt((a.message || '').match(/(\d+)/)?.[1] || '0', 10));
  }, 0);
  if (unfulfTotal > 0) {
    patterns.push(`Unfulfillable units are noise — all small quantities, typical FBA returns cycle`);
  }

  // Stranded
  const strandedBrands = [...new Set(alerts.filter(a => a.type === 'stranded').map(a => a.brandName))];
  if (strandedBrands.length) {
    patterns.push(`Stranded inventory flagged for ${strandedBrands.join(', ')} — check Seller Central for listing issue`);
  }

  return patterns;
}

function buildHealthDigestBlocks({ alerts, summary, generatedAt, dashboardUrl }) {
  const date = new Date(generatedAt).toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' });

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `RMC LISTING HEALTH REPORT` } },
  ];

  if (summary.total === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*All clear* — no listing issues detected. ${date}` }
    });
  } else {
    // Summary line
    const parts = [];
    parts.push(`${summary.critical} Critical`);
    parts.push(`${summary.warning} Warnings`);
    parts.push(`${summary.brandsAffected} Brands Affected`);
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: parts.join('  |  ') }
    });

    // Group by brand
    const byBrand = {};
    for (const a of alerts) {
      (byBrand[a.brandName] = byBrand[a.brandName] || { name: a.brandName, color: a.brandColor, alerts: [] }).alerts.push(a);
    }

    const sortedBrands = Object.values(byBrand).sort((a, b) => {
      const ac = a.alerts.some(x => x.severity === 'critical');
      const bc = b.alerts.some(x => x.severity === 'critical');
      if (ac !== bc) return ac ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    blocks.push({ type: 'divider' });

    for (const bg of sortedBrands) {
      const total = bg.alerts.length;
      const crits = bg.alerts.filter(a => a.severity === 'critical').length;
      const count = crits > 0 ? `${crits} critical, ${total - crits} warning` : `${total} warning${total !== 1 ? 's' : ''}`;

      const lines = buildBrandLines(bg.name, bg.alerts);
      const bulletText = lines.map(l => `• ${l}`).join('\n');

      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${bg.name}* — ${count}\n\n${bulletText}` }
      });
    }

    // Key patterns
    const patterns = buildPatterns(alerts);
    if (patterns.length) {
      blocks.push({ type: 'divider' });
      const patternText = '*Key patterns:*\n' + patterns.map(p => `• ${p}`).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: patternText } });
    }
  }

  if (dashboardUrl) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `<${dashboardUrl}|Open dashboard>  ·  ${date}` }]
    });
  }

  // Slack hard-caps at 50 blocks
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
