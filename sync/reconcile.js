// Monthly revenue reconcile — the dashboard vs Amazon's own Sales & Traffic
// report. The nightly integrity checks prove the database is SELF-consistent;
// this proves it matches AMAZON. daily_metrics revenue is built from the
// Orders API, while S&T is Amazon's independent aggregation (what Seller
// Central business reports show) — so a partial orders sync surfaces as a
// delta here even when every internal invariant passes.
//
// Posts to Slack ALWAYS, pass or fail — silence must never mean "unchecked".
// One S&T report per marketplace (SUMMARY granularity over the whole range),
// so a monthly run costs 2 report requests.

const { getAccessToken, getMarketplaceIds, createReport, waitForReport, downloadReport, sleep } = require('./amazon');
const { pstMidnightAsUTC, pstEndOfDayAsUTC } = require('./dateUtils');

const MARKETPLACE_CURRENCY = require('./marketplaces').currencyMap();
// Tolerance is asymmetric because the two sources measure differently: S&T
// "ordered product sales" counts orders at placement and is never restated
// when they cancel, while daily_metrics deliberately excludes cancelled
// orders (to match Sellerboard / actual payouts). The dashboard therefore
// normally sits a few percent BELOW S&T — that gap is the cancellation rate,
// not a sync failure. ABOVE S&T has no such excuse: the dashboard counting
// revenue Amazon itself doesn't see is a real problem.
const TOLERANCE_ABOVE_PCT = 1.5; // dashboard > Amazon — strict
const TOLERANCE_BELOW_PCT = 5;   // dashboard < Amazon — cancellations live here
const MIN_ABS_DELTA = 50;    // dollars — a 40% miss on a $20 brand isn't a sync failure

const r2 = v => Math.round(v * 100) / 100;
const money = v => v.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One SUMMARY-granularity S&T report per marketplace over [from, to].
// Returns { CAD: { asin: {units, revenue} }, USD: { ... } }.
async function fetchStRange(from, to) {
  const token = await getAccessToken();
  const byCurrency = { CAD: {}, USD: {} };
  for (const mpId of getMarketplaceIds()) {
    const currency = MARKETPLACE_CURRENCY[mpId];
    if (!currency) continue;
    const reportId = await createReport(
      'GET_SALES_AND_TRAFFIC_REPORT',
      [mpId],
      { dateGranularity: 'SUMMARY', asinGranularity: 'CHILD' },
      { start: pstMidnightAsUTC(from), end: pstEndOfDayAsUTC(to) },
      token
    );
    const docId = await waitForReport(reportId, token);
    const raw = JSON.parse(await downloadReport(docId, token));
    for (const item of (raw.salesAndTrafficByAsin || [])) {
      const asin = item.childAsin || item.parentAsin;
      if (!asin) continue;
      const sales = item.salesByAsin || {};
      byCurrency[currency][asin] = {
        units:   sales.unitsOrdered || 0,
        revenue: sales.orderedProductSales?.amount || 0,
      };
    }
    await sleep(2000);
  }
  return byCurrency;
}

async function fetchDashRange(supabase, from, to) {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('daily_metrics')
      .select('date,asin,brand_id,units_ca,units_us,revenue_cad,revenue_usd')
      .gte('date', from).lte('date', to)
      .order('date', { ascending: true }).order('asin', { ascending: true })
      .range(start, start + 999);
    if (error) throw new Error(`daily_metrics read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function runRevenueReconcile({ supabase, loadBrands, from, to }) {
  const { brands } = await loadBrands();
  const owner = {};
  for (const b of brands || []) for (const a of (b.asins || [])) owner[a] = b.id;

  const [st, dashRows] = await Promise.all([fetchStRange(from, to), fetchDashRange(supabase, from, to)]);

  // Dashboard side uses its own stored brand_id (what reports display);
  // the S&T side maps ASIN -> current owner. A stale attribution therefore
  // shows up as a per-brand delta even when totals agree.
  const cell = () => ({ dashRev: 0, dashUnits: 0, stRev: 0, stUnits: 0 });
  const grid = {}; // brandId -> { CAD: cell, USD: cell }
  const at = (brand, cur) => ((grid[brand] = grid[brand] || {})[cur] = grid[brand][cur] || cell());

  for (const r of dashRows) {
    if (r.revenue_cad || r.units_ca) { const c = at(r.brand_id, 'CAD'); c.dashRev += r.revenue_cad || 0; c.dashUnits += r.units_ca || 0; }
    if (r.revenue_usd || r.units_us) { const c = at(r.brand_id, 'USD'); c.dashRev += r.revenue_usd || 0; c.dashUnits += r.units_us || 0; }
  }
  for (const cur of ['CAD', 'USD']) {
    for (const [asin, v] of Object.entries(st[cur])) {
      if (!v.revenue && !v.units) continue;
      const c = at(owner[asin] || 'unknown-brand', cur);
      c.stRev += v.revenue; c.stUnits += v.units;
    }
  }

  const failures = [];
  const totals = { CAD: cell(), USD: cell() };
  for (const [brand, curs] of Object.entries(grid)) {
    for (const [cur, c] of Object.entries(curs)) {
      totals[cur].dashRev += c.dashRev; totals[cur].stRev += c.stRev;
      totals[cur].dashUnits += c.dashUnits; totals[cur].stUnits += c.stUnits;
      const delta = c.dashRev - c.stRev;
      const pct = c.stRev > 0 ? (delta / c.stRev) * 100 : (c.dashRev > 0 ? 100 : 0);
      if (Math.abs(delta) > MIN_ABS_DELTA && (pct > TOLERANCE_ABOVE_PCT || pct < -TOLERANCE_BELOW_PCT)) {
        failures.push({ brand, currency: cur,
          dashRev: r2(c.dashRev), stRev: r2(c.stRev), deltaPct: r2(pct),
          dashUnits: c.dashUnits, stUnits: c.stUnits });
      }
    }
  }
  failures.sort((a, b) => Math.abs(b.dashRev - b.stRev) - Math.abs(a.dashRev - a.stRev));

  const brandCount = Object.keys(grid).length;
  return {
    from, to, checkedAt: new Date().toISOString(),
    pass: failures.length === 0,
    brandCount, failures,
    totals: {
      CAD: { dashboard: r2(totals.CAD.dashRev), amazonSt: r2(totals.CAD.stRev) },
      USD: { dashboard: r2(totals.USD.dashRev), amazonSt: r2(totals.USD.stRev) },
    },
  };
}

function buildReconcileSlackText(result) {
  const head = `RMC REVENUE RECONCILE — ${result.from} → ${result.to} vs Amazon S&T`;
  const tot = `Totals: dashboard CA$${money(result.totals.CAD.dashboard)} / US$${money(result.totals.USD.dashboard)}  ·  Amazon CA$${money(result.totals.CAD.amazonSt)} / US$${money(result.totals.USD.amazonSt)}`;
  if (result.pass) {
    return [head, '', `PASS — all ${result.brandCount} brands within tolerance (+${TOLERANCE_ABOVE_PCT}% / −${TOLERANCE_BELOW_PCT}%)`, tot].join('\n');
  }
  const lines = result.failures.map(f =>
    `• ${f.brand} ${f.currency}: dashboard $${money(f.dashRev)} vs Amazon $${money(f.stRev)} (${f.deltaPct > 0 ? '+' : ''}${f.deltaPct}%, units ${f.dashUnits} vs ${f.stUnits})`);
  return [head, '', `FAIL — ${result.failures.length} brand/currency pair(s) outside tolerance (+${TOLERANCE_ABOVE_PCT}% above / −${TOLERANCE_BELOW_PCT}% below Amazon; below = cancellations are normal, above = we count revenue Amazon doesn't)`, ...lines, tot].join('\n');
}

async function postReconcile(result) {
  const webhook = process.env.SLACK_INTEGRITY_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { posted: false, reason: 'no_webhook' };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: buildReconcileSlackText(result) }),
  });
  if (!res.ok) return { posted: false, reason: 'webhook_error', status: res.status };
  return { posted: true };
}

module.exports = { runRevenueReconcile, buildReconcileSlackText, postReconcile, TOLERANCE_ABOVE_PCT, TOLERANCE_BELOW_PCT };
