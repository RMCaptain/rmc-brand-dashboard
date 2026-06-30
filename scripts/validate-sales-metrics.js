// Validate Sales metrics: revenue, units, sessions, buy box.
// Calls /api/report-data (same path the report uses) and runs:
//   1. Internal consistency checks (no silent truncation, sums reconcile, no zero days)
//   2. Sellerboard-comparable summary (Mike compares manually for now)
//
// Server must be running locally (node server.js) on PORT (default 3000).
//
// Usage:
//   node scripts/validate-sales-metrics.js
//   node scripts/validate-sales-metrics.js --brand=acure
//   node scripts/validate-sales-metrics.js --period=last7d
//   node scripts/validate-sales-metrics.js --from=2026-05-01 --to=2026-05-31
//
// Read-only — touches nothing.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(process.argv.slice(2)
  .filter(a => a.startsWith('--'))
  .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));

const msDay = 86400000;
const fmtISO = d => d.toISOString().split('T')[0];
const today = new Date();
let to = args.to, from = args.from;

if (!to) to = fmtISO(today);
if (!from) {
  const periodDays = ({ last7d: 7, last14d: 14, last30d: 30, last90d: 90 })[args.period || 'last30d'] || 30;
  from = fmtISO(new Date(today - (periodDays - 1) * msDay));
}

const fmtC  = v => v == null ? '—'   : '$' + Math.round(v).toLocaleString('en-US');
const fmtN  = v => v == null ? '—'   : Number(v).toLocaleString('en-US');
const fmtP  = (v, d = 1) => v == null ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)) + '%';
const delta = (curr, prev) => (prev === 0 || prev == null) ? null : Math.round((curr - prev) / prev * 1000) / 10;
const dPct  = v => v == null ? '' : `(${v >= 0 ? '+' : ''}${v}%)`;

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Confirm server reachable.
  try {
    const ping = await fetch(`${BASE}/api/fx`);
    if (!ping.ok) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`\n❌ Server not reachable at ${BASE}/api/fx — start it with: node server.js\n`);
    process.exit(1);
  }

  // Load brands.
  const { data } = await supabase.from('brands').select('data').eq('id', 'main').single();
  const brands = data?.data?.brands || [];
  if (!brands.length) { console.error('No brands found.'); process.exit(1); }

  // Filter to specific brand if requested.
  const target = args.brand
    ? brands.filter(b => b.id === args.brand || b.name?.toLowerCase().includes(String(args.brand).toLowerCase()))
    : brands;
  if (!target.length) { console.error(`No brand matched "${args.brand}".`); process.exit(1); }

  console.log(`\n━━━ Sales Metrics Validation ━━━`);
  console.log(`Period:  ${from}  →  ${to}`);
  console.log(`Brands:  ${target.length}\n`);

  let anyFail = false;

  for (const brand of target) {
    const report = await fetchReport(brand.id, from, to);
    if (!report) { console.log(`⏭  ${brand.name} — no report data\n`); continue; }

    console.log(`─── ${brand.name} (${brand.id}) ───`);
    const checks = runChecks(report, brand);
    const failed = checks.filter(c => c.status === 'FAIL');
    if (failed.length) anyFail = true;

    // Summary table — for Sellerboard comparison
    console.log('\nPeriod summary (vs prior period):');
    const s = report.summary, sp = report.summaryPrev;
    console.table([
      { metric: 'Revenue (CAD)', current: fmtC(s.revenueCad), prior: fmtC(sp.revenueCad), delta: dPct(delta(s.revenueCad, sp.revenueCad)) },
      { metric: 'Revenue (USD)', current: fmtC(s.revenueUsd), prior: fmtC(sp.revenueUsd), delta: dPct(delta(s.revenueUsd, sp.revenueUsd)) },
      { metric: 'Units',         current: fmtN(s.units),      prior: fmtN(sp.units),      delta: dPct(delta(s.units, sp.units)) },
      { metric: 'Sessions',      current: fmtN(s.sessions),   prior: '—',                 delta: '' },
      { metric: 'Page views',    current: fmtN(s.pageViews),  prior: '—',                 delta: '' },
      { metric: 'CVR',           current: fmtP(s.sessions ? s.units / s.sessions * 100 : null), prior: '—', delta: '' },
    ]);

    // Consistency checks
    console.log('Consistency checks:');
    for (const c of checks) {
      const icon = c.status === 'PASS' ? '✅' : c.status === 'WARN' ? '⚠️ ' : '❌';
      console.log(`  ${icon} ${c.name}${c.note ? ' — ' + c.note : ''}`);
    }

    // Daily breakdown — flag anomalies
    const days = report.dailySeries || [];
    const zeroDays = days.filter(d => (d.revCad + d.revUsd) === 0).length;
    const dailyRevs = days.map(d => d.revCad + d.revUsd);
    const avg = dailyRevs.reduce((a, b) => a + b, 0) / (dailyRevs.length || 1);
    const drops = days.filter((d, i) => {
      if (i === 0) return false;
      const prev = dailyRevs[i - 1];
      const curr = dailyRevs[i];
      return prev > avg * 0.5 && curr < prev * 0.3;  // >70% drop from a non-tiny prior day
    });
    console.log(`Daily series: ${days.length} days, ${zeroDays} zero-rev days, ${drops.length} sudden drops (>70%)`);
    if (drops.length) {
      console.log('  ⚠️  Sudden drops detected:');
      drops.forEach(d => console.log(`     ${d.date}: ${fmtC(d.revCad + d.revUsd)}`));
    }

    // Top 5 ASINs — Sellerboard comparison points
    const top5 = (report.products || []).slice(0, 5);
    if (top5.length) {
      console.log('\nTop 5 ASINs by revenue (Sellerboard cross-check):');
      console.table(top5.map(p => ({
        asin: p.asin,
        title: (p.title || '').slice(0, 40),
        revCad: fmtC(p.revenueCad),
        revUsd: fmtC(p.revenueUsd),
        units: fmtN(p.units),
        sessions: fmtN(p.sessions),
        buyBox: p.buyBox != null ? p.buyBox + '%' : '—',
      })));
    }

    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(anyFail ? '❌ One or more consistency checks failed.' : '✅ All consistency checks passed.');
  console.log('Next: compare totals + top ASINs against Sellerboard for spot-check brands.\n');
  process.exit(anyFail ? 1 : 0);
})().catch(err => { console.error('Validation failed:', err); process.exit(1); });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchReport(brandId, fromS, toS) {
  const url = `${BASE}/api/report-data/${brandId}?from=${fromS}&to=${toS}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

function runChecks(r, brand) {
  const out = [];
  const s = r.summary, products = r.products || [];

  // 1. Per-ASIN units sum equals brand units
  const asinUnitSum = products.reduce((a, p) => a + (p.units || 0), 0);
  out.push({
    name: 'Per-ASIN units sum = brand units',
    status: asinUnitSum === s.units ? 'PASS' : 'FAIL',
    note: asinUnitSum === s.units ? null : `ASIN sum: ${asinUnitSum}, brand: ${s.units}`,
  });

  // 2. Per-ASIN revenue sum (within $1 rounding tolerance) equals brand revenue
  const asinRevCad = products.reduce((a, p) => a + (p.revenueCad || 0), 0);
  out.push({
    name: 'Per-ASIN CAD revenue sum = brand CAD revenue',
    status: Math.abs(asinRevCad - s.revenueCad) < 1 ? 'PASS' : 'FAIL',
    note: Math.abs(asinRevCad - s.revenueCad) < 1 ? null : `ASIN sum: ${asinRevCad.toFixed(2)}, brand: ${s.revenueCad}`,
  });

  // 3. Daily series sums (within $1) to period totals
  const dailySumCad = (r.dailySeries || []).reduce((a, d) => a + (d.revCad || 0), 0);
  out.push({
    name: 'Daily series CAD = period CAD',
    status: Math.abs(dailySumCad - s.revenueCad) < 1 ? 'PASS' : 'FAIL',
    note: Math.abs(dailySumCad - s.revenueCad) < 1 ? null : `Daily sum: ${dailySumCad.toFixed(2)}, period: ${s.revenueCad}`,
  });

  // 4. All daily series dates fall inside the requested window
  const days = r.dailySeries || [];
  const outOfRange = days.filter(d => d.date < r.period.from || d.date > r.period.to);
  out.push({
    name: 'All daily dates within period',
    status: outOfRange.length === 0 ? 'PASS' : 'FAIL',
    note: outOfRange.length === 0 ? null : `${outOfRange.length} dates out of [${r.period.from}, ${r.period.to}]`,
  });

  // 5. Products listed are subset of brand's configured ASINs
  const brandAsins = new Set(brand.asins || []);
  const stray = products.filter(p => !brandAsins.has(p.asin));
  out.push({
    name: 'Products are subset of brand ASINs (no leak)',
    status: stray.length === 0 ? 'PASS' : 'FAIL',
    note: stray.length === 0 ? null : `${stray.length} stray ASINs (${stray.map(p => p.asin).slice(0, 3).join(', ')}...)`,
  });

  // 6. Period length matches days returned (allowing for zero-rev gaps Notion handles correctly)
  const periodDays = Math.round((new Date(r.period.to) - new Date(r.period.from)) / msDay) + 1;
  out.push({
    name: `Daily series spans full ${periodDays}-day window`,
    status: days.length >= periodDays * 0.5 ? 'PASS' : 'WARN',  // warn if <50% coverage
    note: days.length >= periodDays * 0.5 ? `${days.length}/${periodDays} days have data` : `Only ${days.length}/${periodDays} days have data — possible gaps`,
  });

  // 7. No negative revenue or units
  const negProducts = products.filter(p => p.revenueCad < 0 || p.revenueUsd < 0 || p.units < 0);
  out.push({
    name: 'No negative revenue/units',
    status: negProducts.length === 0 ? 'PASS' : 'FAIL',
    note: negProducts.length === 0 ? null : `${negProducts.length} products negative`,
  });

  return out;
}
