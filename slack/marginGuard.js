'use strict';
// Margin guard — the midweek smoke detector between Monday digests (Mike,
// 2026-09-26). Every day after the Sellerboard feeds land, each brand's
// trailing 7 full days is compared against its own 28-day baseline (the four
// weeks BEFORE those 7 days, so the windows never overlap):
//
//   margin drop  — baseline margin − 7d margin ≥ marginDropPts, only when
//                  both windows have Sellerboard-exact profit (no alerting
//                  off component math) and 7d sales clear minSales7.
//   TACOS spike  — 7d TACOS − baseline TACOS ≥ tacosRisePts, only when 7d
//                  ad spend clears minAdSpend7 (a $20 test campaign on a
//                  quiet brand is not a fire).
//
// A clean day posts NOTHING — silence is the normal state, so an alert
// still means something. Thresholds are env-tunable (MG_* in server.js).
// Pure data-in/data-out; unit-tested in scripts/test-marketplace.

const { brandTotals } = require('./weeklyDigest');

const DEFAULTS = {
  minSales7: 500,     // CAD — ignore brands too small for a margin % to mean much
  minAdSpend7: 50,    // CAD — ignore TACOS noise on near-zero spend
  marginDropPts: 5,   // percentage points vs baseline
  tacosRisePts: 3,    // percentage points vs baseline
};

const r1 = v => Math.round(v * 10) / 10;

// cur/base: buildBrandMetricsForRange payloads for the 7d and 28d windows.
function checkAnomalies({ curPayload, basePayload, brands, fx, opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const cur = brandTotals(curPayload, fx);
  const base = brandTotals(basePayload, fx);
  const out = [];
  for (const b of brands || []) {
    if (b.id === 'unknown-brand') continue;
    const c = cur[b.id], p = base[b.id];
    if (!c || !(c.sales >= o.minSales7) || !p || !(p.sales > 0)) continue;

    if (c.netProfit != null && p.netProfit != null) {
      const m7 = c.netProfit / c.sales * 100;
      const mb = p.netProfit / p.sales * 100;
      if (mb - m7 >= o.marginDropPts) {
        out.push({ brandId: b.id, name: b.name, kind: 'margin', cur: r1(m7), base: r1(mb), sales7: Math.round(c.sales) });
      }
    }
    if (c.adSpend >= o.minAdSpend7) {
      const t7 = c.adSpend / c.sales * 100;
      const tb = p.adSpend / p.sales * 100;
      if (t7 - tb >= o.tacosRisePts) {
        out.push({ brandId: b.id, name: b.name, kind: 'tacos', cur: r1(t7), base: r1(tb), sales7: Math.round(c.sales) });
      }
    }
  }
  // Biggest brands first — that's where the dollars are.
  return out.sort((a, b) => b.sales7 - a.sales7);
}

function buildGuardMessage(anomalies, { cur, base }) {
  const line = a => a.kind === 'margin'
    ? `• *${a.name}* — margin ${a.cur}% vs ${a.base}% baseline (7d sales CA$${a.sales7.toLocaleString('en-CA')})`
    : `• *${a.name}* — TACOS ${a.cur}% vs ${a.base}% baseline (7d sales CA$${a.sales7.toLocaleString('en-CA')})`;
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `MARGIN GUARD — ${anomalies.length} brand${anomalies.length > 1 ? 's' : ''} off baseline` } },
    { type: 'section', text: { type: 'mrkdwn', text: anomalies.map(line).join('\n') } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `trailing 7d (${cur.from} – ${cur.to}) vs prior 28d (${base.from} – ${base.to})` }] },
  ];
  const fallback = `Margin guard: ${anomalies.length} brand${anomalies.length > 1 ? 's' : ''} off baseline — ${anomalies.map(a => a.name).join(', ')}.`;
  return { blocks, fallback };
}

module.exports = { checkAnomalies, buildGuardMessage, DEFAULTS };
