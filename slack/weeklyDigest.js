// Weekly performance digest — Monday-morning Slack rollup for brand managers:
// last full week (Mon–Sun, PST) vs the week before, per brand. Money figures
// ride the same Sellerboard-first byMp payloads as the dashboard, converted
// to CAD; a brand's profit shows only when every active slice is
// Sellerboard-covered (same honesty rule as the app — no component-math
// approximations in a digest people act on).
//
// buildWeeklyDigest() is pure (payloads in, blocks out) so the regression
// suite can pin the math; posting rides slack/digest.js's webhook helper.

const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

// Last COMPLETE Mon–Sun week in PST, and the week before it.
// end = the latest Sunday on or before yesterday.
function weekRanges(todayPst = pstDateStr()) {
  const yest = pstSubtractDays(todayPst, 1);
  const dow = new Date(yest + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  const end = dow === 0 ? yest : pstSubtractDays(yest, dow);
  const from = pstSubtractDays(end, 6);
  return {
    cur: { from, to: end },
    prev: { from: pstSubtractDays(from, 7), to: pstSubtractDays(end, 7) },
  };
}

// Aggregate one preset-shaped payload per brand → CAD figures. Volumes come
// off the summary byMp rollup; profit is summed per-SKU slice where
// Sellerboard covers it (the brand-summary source label goes 'mixed' on
// zero-activity Amazon traffic slots, so it can't gate profit — same lesson
// as the dashboard cards). Guardrail: tolerate uncovered slices up to
// max(5% of sales, $100) and mark the figure approximate; past that, null.
function brandTotals(payload, fx) {
  const toCad = (v, cur) => (v || 0) * (fx?.toCad?.[cur] ?? (cur === 'USD' ? fx?.usdToCad ?? 1.38 : 1));
  const out = {};
  for (const [id, bm] of Object.entries(payload?.brands || {})) {
    const t = { sales: 0, units: 0, adSpend: 0, refunds: 0, netProfit: null, approx: false };
    for (const m of Object.values(bm.summary?.byMp || {})) {
      t.sales   += toCad(m.sales, m.currency);
      t.units   += m.units || 0;
      t.adSpend += toCad(m.adSpend, m.currency);
      t.refunds += m.refunds || 0;
    }
    let np = 0, missingRev = 0, anyActive = false;
    for (const sku of bm.skus || []) {
      if (!sku.byMp) { missingRev += toCad(sku.revenueCad, 'CAD') + toCad(sku.revenueUsd, 'USD'); continue; }
      for (const m of Object.values(sku.byMp)) {
        // Either-sign activity test (mirror of MpScope.activeSlice): fees go
        // negative on FBA reimbursements, netProfit-only rows carry cost
        // adjustments — a > 0 test dropped their profit.
        const active = (m.units || 0) !== 0 || (m.sales || 0) !== 0 || (m.adSpend || 0) !== 0
          || (m.fees || 0) !== 0 || (m.refundAmount || 0) !== 0 || (m.promo || 0) !== 0 || (m.netProfit || 0) !== 0;
        if (!active) continue;
        anyActive = true;
        if (m.source === 'sellerboard' && m.netProfit != null) np += toCad(m.netProfit, m.currency);
        else missingRev += toCad(m.sales, m.currency);
      }
    }
    if (anyActive && missingRev <= Math.max(t.sales * 0.05, 100)) {
      t.netProfit = np;
      t.approx = missingRev > 0;
    }
    out[id] = t;
  }
  return out;
}

const money = v => 'CA$' + Math.round(v).toLocaleString('en-CA');
function wow(cur, prev) {
  if (!prev) return cur > 0 ? 'new' : '—';
  const pct = ((cur - prev) / prev) * 100;
  return (pct >= 0 ? '+' : '') + pct.toFixed(0) + '% WoW';
}
function fmtRange(from, to) {
  const d = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${d(from)} – ${d(to)}`;
}

// curPayload/prevPayload: buildBrandMetricsForRange outputs for the two weeks.
// brands: loadBrands() list (names + order). fx: fetchFxRate() result.
function buildWeeklyDigest({ curPayload, prevPayload, brands, fx, range, dashboardUrl }) {
  const cur = brandTotals(curPayload, fx);
  const prev = brandTotals(prevPayload, fx);

  const rows = (brands || [])
    .filter(b => b.id !== 'unknown-brand')
    .map(b => ({ brand: b, c: cur[b.id], p: prev[b.id] }))
    .filter(r => (r.c?.sales || 0) > 0 || (r.p?.sales || 0) > 0)
    .sort((a, b) => (b.c?.sales || 0) - (a.c?.sales || 0));

  const tot = { sales: 0, prevSales: 0, units: 0, adSpend: 0, np: 0, npAll: true, approx: false };
  for (const r of rows) {
    tot.sales += r.c?.sales || 0;
    tot.prevSales += r.p?.sales || 0;
    tot.units += r.c?.units || 0;
    tot.adSpend += r.c?.adSpend || 0;
    if (r.c?.netProfit != null) { tot.np += r.c.netProfit; if (r.c.approx) tot.approx = true; }
    else if ((r.c?.sales || 0) > 0) tot.npAll = false;
  }
  const margin = v => v.sales > 0 && v.netProfit != null ? ` (${(v.netProfit / v.sales * 100).toFixed(0)}%)` : '';
  const tacos = v => v.sales > 0 && v.adSpend > 0 ? (v.adSpend / v.sales * 100).toFixed(1) + '%' : '—';

  const lines = rows.map(({ brand, c, p }) => {
    const np = c?.netProfit != null ? `${c.approx ? '~' : ''}${money(c.netProfit)}${margin(c)}` : '—';
    const u = c?.units || 0;
    return `*${brand.name}* — ${money(c?.sales || 0)} (${wow(c?.sales || 0, p?.sales || 0)}) · profit ${np} · TACOS ${tacos(c || {})} · ${u.toLocaleString()} unit${u === 1 ? '' : 's'}`;
  });

  const npStr = (tot.approx || !tot.npAll ? '~' : '') + money(tot.np)
    + (tot.npAll && tot.sales > 0 ? ` (${(tot.np / tot.sales * 100).toFixed(0)}%)` : '')
    + (tot.npAll ? '' : ' (partial — some brands uncovered)');
  const totLine = `*Total:* ${money(tot.sales)} sales (${wow(tot.sales, tot.prevSales)}) · net profit ${npStr} · ad spend ${money(tot.adSpend)} (TACOS ${tot.sales > 0 ? (tot.adSpend / tot.sales * 100).toFixed(1) + '%' : '—'}) · ${tot.units.toLocaleString()} units`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: `RMC WEEKLY PERFORMANCE — ${fmtRange(range.cur.from, range.cur.to)}` } },
    { type: 'section', text: { type: 'mrkdwn', text: totLine } },
    { type: 'divider' },
    // Slack caps a section at 3000 chars — chunk brand lines defensively.
    ...chunk(lines, 3000).map(text => ({ type: 'section', text: { type: 'mrkdwn', text } })),
  ];
  if (dashboardUrl) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `vs ${fmtRange(range.prev.from, range.prev.to)} · <${dashboardUrl}|open dashboard>` }] });

  const fallback = `RMC weekly: ${money(tot.sales)} sales (${wow(tot.sales, tot.prevSales)}), ${rows.length} brands.`;
  return { blocks, fallback, lines, totals: tot };
}

function chunk(lines, max) {
  const out = [];
  let buf = '';
  for (const l of lines) {
    if (buf && buf.length + l.length + 1 > max) { out.push(buf); buf = ''; }
    buf += (buf ? '\n' : '') + l;
  }
  if (buf) out.push(buf);
  return out.length ? out : ['_No brand activity either week._'];
}

module.exports = { weekRanges, brandTotals, buildWeeklyDigest };
