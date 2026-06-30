// Validate Traffic & conversion: sessions, page views, CVR.
//
// Cross-checks two LIVE aggregation paths that should agree (both read daily_metrics):
//   1. /api/metrics?from=X&to=Y         → all-brands aggregation
//   2. /api/report-data/:brandId        → per-brand aggregation
//
// If they diverge for the same brand+period, there's a bug in one of the two
// aggregation paths (filter mismatch, ASIN set drift, math).
//
// Also notes (separate concern):
//   - /api/brands uses preset_metrics (cached) which may be stale; not validated here
//     because the brand report does NOT use the cached path.
//
// Server must be running locally (node server.js) on PORT (default 3000).
//
// Usage:
//   node scripts/validate-traffic-metrics.js                # last 30 days
//   node scripts/validate-traffic-metrics.js --period=last7d
//   node scripts/validate-traffic-metrics.js --from=2026-05-01 --to=2026-05-31
//
// Read-only.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

const msDay = 86400000;
const fmtISO = d => d.toISOString().split('T')[0];

let from = args.from;
let to   = args.to;
if (!to)   to   = fmtISO(new Date(Date.now() - msDay));      // yesterday — matches preset endDate convention
if (!from) {
  const days = ({ last7d: 7, last14d: 14, last30d: 30, last90d: 90 })[args.period || 'last30d'] || 30;
  from = fmtISO(new Date(new Date(to) - (days - 1) * msDay));
}

const fmtN = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const fmtP = (v, d = 1) => v == null ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)) + '%';

// Within $1 / 1 unit / 0.5% — daily_metrics aggregations should agree exactly,
// but rounding (revenue stored to 2 decimal places, summed differently) can drift cents.
function near(a, b) {
  if (a == null && b == null) return true;
  const x = a ?? 0, y = b ?? 0;
  const diff = Math.abs(x - y);
  const pct  = y === 0 ? (x === 0 ? 0 : Infinity) : Math.abs(diff / y) * 100;
  return diff <= 1 || pct <= 0.5;
}

(async () => {
  try {
    const ping = await fetch(`${BASE}/api/fx`);
    if (!ping.ok) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`\n❌ Server not reachable at ${BASE}/api/fx — start it with: node server.js\n`);
    process.exit(1);
  }

  console.log(`\n━━━ Traffic & Conversion Validation ━━━`);
  console.log(`Window:  ${from}  →  ${to}\n`);

  // Pull all-brand metrics (live)
  const metricsRes = await fetch(`${BASE}/api/metrics?from=${from}&to=${to}`);
  if (!metricsRes.ok) { console.error(`Failed: /api/metrics  ${metricsRes.status}`); process.exit(1); }
  const allBrandsLive = await metricsRes.json();

  const allBrandIds = Object.keys(allBrandsLive.brands || {});
  console.log(`Brands present in /api/metrics:  ${allBrandIds.length}\n`);

  const rows = [];
  let drift = 0, noMatch = 0;

  for (const brandId of allBrandIds) {
    if (brandId === 'unknown-brand') continue;   // unknown-brand is a catch-all, not a real brand

    const liveAll = allBrandsLive.brands[brandId].summary || {};
    const liveReport = await fetchReport(brandId, from, to);
    if (!liveReport) { noMatch++; rows.push({ brand: brandId, status: 'no report' }); continue; }

    const reportSum = liveReport.summary || {};

    const checks = [
      { metric: 'sessions',   metrics: liveAll.sessions,   report: reportSum.sessions   },
      { metric: 'pageViews',  metrics: liveAll.pageViews,  report: reportSum.pageViews  },
      { metric: 'units',      metrics: liveAll.units,      report: reportSum.units      },
      { metric: 'revenueCad', metrics: liveAll.revenueCad, report: reportSum.revenueCad },
      { metric: 'revenueUsd', metrics: liveAll.revenueUsd, report: reportSum.revenueUsd },
      { metric: 'buyBox',     metrics: liveAll.buyBox,     report: computeReportBuyBox(liveReport) },
    ];

    const failed = checks.filter(c => !near(c.metrics, c.report));
    if (failed.length) drift++;

    rows.push({
      brand:        liveReport.brand.name,
      sessions:     `${fmtN(liveAll.sessions)} / ${fmtN(reportSum.sessions)}`     + (near(liveAll.sessions,   reportSum.sessions)   ? ' ✅' : ' ❌'),
      pageViews:    `${fmtN(liveAll.pageViews)} / ${fmtN(reportSum.pageViews)}`   + (near(liveAll.pageViews,  reportSum.pageViews)  ? ' ✅' : ' ❌'),
      units:        `${fmtN(liveAll.units)} / ${fmtN(reportSum.units)}`            + (near(liveAll.units,      reportSum.units)      ? ' ✅' : ' ❌'),
      revCad:       `${fmtN(liveAll.revenueCad)} / ${fmtN(reportSum.revenueCad)}`  + (near(liveAll.revenueCad, reportSum.revenueCad) ? ' ✅' : ' ❌'),
      revUsd:       `${fmtN(liveAll.revenueUsd)} / ${fmtN(reportSum.revenueUsd)}`  + (near(liveAll.revenueUsd, reportSum.revenueUsd) ? ' ✅' : ' ❌'),
      cvr:          fmtP(reportSum.sessions ? reportSum.units / reportSum.sessions * 100 : null),
    });
  }

  console.log('Per-brand: /api/metrics (live, all-brands) / /api/report-data (live, per-brand)\n');
  console.table(rows);
  console.log(`\nResults: ${rows.length - drift - noMatch} ✅  /  ${drift} drift  /  ${noMatch} no-match`);

  if (drift === 0 && noMatch === 0) {
    console.log('✅ Both live aggregation paths agree across all brands. Traffic + sessions verified consistent.');
  } else {
    console.log('⚠️  Investigate divergence: aggregation logic differs between /api/metrics and /api/report-data.');
  }

  // Separate finding — flag stale cache
  console.log('\n─── Stale cache check (informational) ───');
  const cachedRes = await fetch(`${BASE}/api/brands?preset=last30d`);
  const cachedData = await cachedRes.json();
  let stale = 0;
  for (const b of (cachedData.brands || [])) {
    const cached = b.metrics?.summary;
    if (!cached) continue;
    const live = allBrandsLive.brands[b.id]?.summary;
    if (!live) continue;
    if (live.revenueCad > 100 && (cached.revenueCad ?? 0) === 0) stale++;
  }
  if (stale > 0) {
    console.log(`⚠️  ${stale} brand(s) have zero revenue in cached preset_metrics but non-zero in live daily_metrics.`);
    console.log('    → preset_metrics is stale or its sync didn\'t pull from daily_metrics. Brand cards may show wrong totals.');
    console.log('    → Separate bug; not blocking Phase 1 since reports use live path.');
  } else {
    console.log('✅ No stale cache detected.');
  }

  console.log('');
  process.exit(drift === 0 ? 0 : 1);
})().catch(err => { console.error('Validation failed:', err); process.exit(1); });

async function fetchReport(brandId, fromS, toS) {
  const url = `${BASE}/api/report-data/${brandId}?from=${fromS}&to=${toS}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function computeReportBuyBox(r) {
  let sum = 0, n = 0;
  for (const p of r.products || []) {
    if (p.buyBox == null) continue;
    sum += p.buyBox; n++;
  }
  return n ? Math.round(sum / n * 100) / 100 : null;
}
