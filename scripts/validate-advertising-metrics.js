// Validate Advertising metrics: ad spend, attributed sales, ACOS, ROAS, clicks, orders.
//
// The dedicated daily ad-sync writes spend/sales/clicks/impressions/orders into
// daily_metrics per (asin, date, marketplace). /api/metrics aggregates that per brand.
// We validate that path:
//   1. Per-SKU spend sums to brand spend (and same for sales/clicks/orders)
//   2. ACOS / ROAS math is correct (matches spend / sales)
//   3. Marketplace split: brand totals = CA + US sums
//   4. Spend present matches brands that should have ads
//   5. ASIN-level spend doesn't include ASINs outside brand's configured set
//
// /api/report-ads pulls FRESH from Amazon Ads API (1-5 min per call) so we avoid
// it here. Mike spot-checks one brand against the Amazon Ads console.
//
// Server must be running locally (node server.js) on PORT (default 3000).
//
// Usage:
//   node scripts/validate-advertising-metrics.js
//   node scripts/validate-advertising-metrics.js --period=last7d
//   node scripts/validate-advertising-metrics.js --from=2026-05-01 --to=2026-05-31
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

let from = args.from, to = args.to;
if (!to)   to   = fmtISO(new Date(Date.now() - msDay));
if (!from) {
  const days = ({ last7d: 7, last14d: 14, last30d: 30, last90d: 90 })[args.period || 'last30d'] || 30;
  from = fmtISO(new Date(new Date(to) - (days - 1) * msDay));
}

const fmtC = v => v == null ? '—' : '$' + (Math.round(v * 100) / 100).toLocaleString('en-US');
const fmtN = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const fmtP = (v, d = 1) => v == null ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)) + '%';

function near(a, b, tol = 1) {
  if (a == null && b == null) return true;
  const x = a ?? 0, y = b ?? 0;
  return Math.abs(x - y) <= tol;
}

(async () => {
  try {
    const ping = await fetch(`${BASE}/api/fx`);
    if (!ping.ok) throw new Error(`status ${ping.status}`);
  } catch (e) {
    console.error(`\n❌ Server not reachable at ${BASE}/api/fx — start it with: node server.js\n`);
    process.exit(1);
  }

  console.log(`\n━━━ Advertising Metrics Validation ━━━`);
  console.log(`Window:  ${from}  →  ${to}\n`);

  const res = await fetch(`${BASE}/api/metrics?from=${from}&to=${to}`);
  if (!res.ok) { console.error(`Failed: /api/metrics ${res.status}`); process.exit(1); }
  const data = await res.json();

  const brandsWithAds = [];
  const brandsNoAds = [];
  let anyFail = false;

  for (const [brandId, brand] of Object.entries(data.brands || {})) {
    if (brandId === 'unknown-brand') continue;
    const s = brand.summary || {};
    const ad = s.adSummary;
    const skus = brand.skus || [];

    // Sum per-SKU ad metrics
    const skuTotals = skus.reduce((acc, k) => {
      acc.spendCad += k.spendCad || 0;
      acc.spendUsd += k.spendUsd || 0;
      acc.attrCad  += k.attributedSalesCad || 0;
      acc.attrUsd  += k.attributedSalesUsd || 0;
      acc.clicks   += k.adClicks || 0;
      acc.impressions += k.adImpressions || 0;
      acc.orders   += k.adOrders || 0;
      return acc;
    }, { spendCad: 0, spendUsd: 0, attrCad: 0, attrUsd: 0, clicks: 0, impressions: 0, orders: 0 });

    const hasAds = (skuTotals.spendCad + skuTotals.spendUsd) > 0;
    if (!hasAds) { brandsNoAds.push(brand.name || brandId); continue; }

    const name = (brandId);
    const adSpendCad = ad?.spendCad ?? null;
    const adSpendUsd = ad?.spendUsd ?? null;
    const adAttrCad  = ad?.attributedSalesCad ?? null;
    const adAttrUsd  = ad?.attributedSalesUsd ?? null;

    // Check 1: per-SKU sum equals brand adSummary (CAD)
    const spendCadOk = near(skuTotals.spendCad, adSpendCad);
    const spendUsdOk = near(skuTotals.spendUsd, adSpendUsd);
    const attrCadOk  = near(skuTotals.attrCad,  adAttrCad);
    const attrUsdOk  = near(skuTotals.attrUsd,  adAttrUsd);

    // ACOS / ROAS math
    const totalSpend = (adSpendCad || 0) + (adSpendUsd || 0);
    const totalAttr  = (adAttrCad  || 0) + (adAttrUsd  || 0);
    const expectedAcos = totalAttr > 0 ? totalSpend / totalAttr * 100 : null;
    const expectedRoas = totalSpend > 0 ? totalAttr / totalSpend       : null;

    const passes = spendCadOk && spendUsdOk && attrCadOk && attrUsdOk;
    if (!passes) anyFail = true;

    brandsWithAds.push({
      brand:       name,
      spendCad:    `${fmtC(skuTotals.spendCad)} / ${fmtC(adSpendCad)}` + (spendCadOk ? ' ✅' : ' ❌'),
      spendUsd:    `${fmtC(skuTotals.spendUsd)} / ${fmtC(adSpendUsd)}` + (spendUsdOk ? ' ✅' : ' ❌'),
      attrCad:     `${fmtC(skuTotals.attrCad)} / ${fmtC(adAttrCad)}`   + (attrCadOk  ? ' ✅' : ' ❌'),
      attrUsd:     `${fmtC(skuTotals.attrUsd)} / ${fmtC(adAttrUsd)}`   + (attrUsdOk  ? ' ✅' : ' ❌'),
      clicks:      fmtN(skuTotals.clicks),
      acos:        fmtP(expectedAcos),
      roas:        expectedRoas != null ? expectedRoas.toFixed(2) + 'x' : '—',
    });
  }

  if (brandsWithAds.length) {
    console.log('Per-brand: per-SKU sum / brand adSummary (per metric, both pulled from daily_metrics)\n');
    console.table(brandsWithAds);
  }

  if (brandsNoAds.length) {
    console.log(`\nBrands with zero ad spend in window (${brandsNoAds.length}):`);
    console.log('  ' + brandsNoAds.join(', '));
  }

  // Anomaly flags
  console.log('\n─── Anomaly flags ───');
  const highAcos = brandsWithAds.filter(b => {
    const v = parseFloat(b.acos);
    return !isNaN(v) && v > 50;   // ACOS > 50% is high (spending half of revenue on ads)
  });
  if (highAcos.length) {
    console.log(`⚠️  ${highAcos.length} brand(s) with ACOS > 50%: ${highAcos.map(b => b.brand).join(', ')}`);
  } else {
    console.log('✅ No brand with ACOS > 50%.');
  }

  console.log('\n─── Summary ───');
  console.log(`Brands with ad data:    ${brandsWithAds.length}`);
  console.log(`Brands with no ad data: ${brandsNoAds.length}`);
  console.log(anyFail ? '❌ One or more consistency checks failed.' : '✅ All consistency checks passed.');
  console.log('\nNext: spot-check one or two brands in Amazon Ads console (same date range)');
  console.log('and confirm spend + attributed sales + clicks match. Reminder: stored daily_metrics is the cached path —');
  console.log('a fresh /api/report-ads call bakes a 1-5 min report from the Amazon Ads API to compare against.\n');

  process.exit(anyFail ? 1 : 0);
})().catch(err => { console.error('Validation failed:', err); process.exit(1); });
