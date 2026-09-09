#!/usr/bin/env node
/**
 * Offline Sellerboard-vs-Amazon reconciliation — no database needed.
 *
 * Amazon side: brand-report JSON files as returned by the RMC App connector's
 * get_brand_report (one file per brand, any window). Sellerboard side: the
 * Settings → Automation Product Dashboard CSV(s). Sums both per brand ×
 * marketplace for the report's period and prints deltas with the standing
 * tolerance (money max($25, 1%), counts max(2, 1%)).
 *
 *   node scripts/reconcile-offline.js --reports <dir-of-json> --feed <csv> [--feed <csv>…] [--json out.json]
 *
 * Each report JSON must carry { brand: { id }, period: { from, to }, summary,
 * products: [{ asin, unitsCad|unitsCa, unitsUsd|unitsUs, revenueCad, revenueUsd,
 * spendCad, spendUsd, feesCad, feesUsd, refundedUnits? }] } — that is the
 * get_brand_report shape. ASIN → brand comes from the reports themselves.
 *
 * Day boundary: Sellerboard days are UTC, the reports are PST days — a 7-day
 * or longer window absorbs most of it; single days will not match.
 */
const fs = require('fs');
const path = require('path');
const sb = require('../sync/sellerboard');
const MP = require('../sync/marketplaces');
const { compare } = require('../sync/reconcileSellerboard');

const args = process.argv.slice(2);
const opt = { reports: null, feeds: [], json: null };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--reports') opt.reports = args[++i];
  else if (args[i] === '--feed') opt.feeds.push(args[++i]);
  else if (args[i] === '--json') opt.json = args[++i];
}
if (!opt.reports || !opt.feeds.length) {
  console.error('usage: node scripts/reconcile-offline.js --reports <dir> --feed <csv> [--feed <csv>] [--json out]');
  process.exit(1);
}

const CA = MP.idByCode('CA'), US = MP.idByCode('US');
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = v => Math.round(v * 100) / 100;

// ── Amazon side from report JSONs ──
const reports = fs.readdirSync(opt.reports).filter(f => f.endsWith('.json') || f.endsWith('.txt')).map(f => {
  const raw = fs.readFileSync(path.join(opt.reports, f), 'utf8');
  try { return JSON.parse(raw); } catch { return null; }
}).filter(r => r && r.brand && r.period && r.products);
if (!reports.length) { console.error('no usable report JSONs in', opt.reports); process.exit(1); }

const asinBrand = {};
const amz = {}; // brand|mp → { units, sales, adSpend, fees, refundAmount }
const periods = new Set();
const slot = (store, brand, mp) => store[`${brand}|${mp}`] || (store[`${brand}|${mp}`] = { units: 0, sales: 0, adSpend: 0, fees: 0, refundAmount: 0 });
for (const r of reports) {
  const brand = r.brand.id;
  periods.add(`${r.period.from}..${r.period.to}`);
  for (const p of r.products) {
    asinBrand[p.asin] = brand;
    if (p.byMp) { // resolved payload (post-deploy) — take the Amazon side only where present
      for (const [mpId, m] of Object.entries(p.byMp)) {
        const s = slot(amz, brand, mpId);
        // amazonSide isn't exposed on skus; use resolved values only when source is 'amazon'
        if (m.source !== 'amazon') continue;
        s.units += num(m.units); s.sales += num(m.sales); s.adSpend += num(m.adSpend); s.fees += num(m.fees); s.refundAmount += num(m.refundAmount);
      }
      continue;
    }
    const ca = slot(amz, brand, CA), us = slot(amz, brand, US);
    ca.units += num(p.unitsCad ?? p.unitsCa); us.units += num(p.unitsUsd ?? p.unitsUs);
    ca.sales += num(p.revenueCad);             us.sales += num(p.revenueUsd);
    ca.adSpend += num(p.spendCad);             us.adSpend += num(p.spendUsd);
    ca.fees += num(p.feesCad);                 us.fees += num(p.feesUsd);
    ca.refundAmount += num(p.refundPostedCad); us.refundAmount += num(p.refundPostedUsd);
  }
}
if (periods.size !== 1) console.warn('WARNING: reports cover different periods:', [...periods].join(' | '));
const [from, to] = [...periods][0].split('..');

// ── Sellerboard side from feed CSVs, same window ──
const sbAgg = {};
let sbRows = 0, sbUnknownAsin = 0, sbSkippedMp = {};
for (const file of opt.feeds) {
  const text = fs.readFileSync(file, 'utf8');
  if (/report not ready/i.test(text.slice(0, 200))) { console.warn(`WARNING: ${file} is a "report not ready" placeholder — skipped`); continue; }
  const { rows, skipped } = sb.parseFeed(text, { asinBrand });
  for (const [k, v] of Object.entries(skipped.unknownMarketplace)) sbSkippedMp[k] = (sbSkippedMp[k] || 0) + v;
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    sbRows++;
    if (!asinBrand[r.asin]) sbUnknownAsin++;
    const s = slot(sbAgg, r.brand_id, r.mp_id);
    s.units += r.units; s.sales += r.sales; s.adSpend += r.ad_spend; s.fees += r.amazon_fees; s.refundAmount += r.refund_amount;
  }
}

// ── Compare ──
const METRICS = [['units', 'units'], ['sales', 'sales'], ['adSpend', 'ad_spend'], ['fees', 'amazon_fees'], ['refundAmount', 'refund_amount']];
const out = [];
const keys = new Set([...Object.keys(amz), ...Object.keys(sbAgg)]);
for (const key of [...keys].sort()) {
  const [brand, mp] = key.split('|');
  for (const [k, metric] of METRICS) {
    const c = compare(metric, amz[key]?.[k], sbAgg[key]?.[k]);
    if (!c) continue;
    out.push({ brand, mp: MP.codeOf(mp) || mp, metric: k, ...c });
  }
}
// account totals per marketplace
const acc = {};
for (const [store, side] of [[amz, 'a'], [sbAgg, 's']]) {
  for (const [key, v] of Object.entries(store)) {
    const mp = key.split('|')[1];
    const t = acc[mp] || (acc[mp] = { a: {}, s: {} });
    for (const [k] of METRICS) t[side][k] = (t[side][k] || 0) + v[k];
  }
}
const accountRows = [];
for (const [mp, t] of Object.entries(acc)) for (const [k, metric] of METRICS) {
  const c = compare(metric, t.a[k], t.s[k]);
  if (c) accountRows.push({ mp: MP.codeOf(mp) || mp, metric: k, ...c });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nOFFLINE RECONCILIATION  ${from} → ${to}   (${reports.length} brand reports, ${sbRows} Sellerboard rows in window)`);
if (Object.keys(sbSkippedMp).length) console.log('Sellerboard marketplaces not in registry:', JSON.stringify(sbSkippedMp));
if (sbUnknownAsin) console.log(`Sellerboard rows on ASINs no report claims: ${sbUnknownAsin} (unknown-brand bucket)`);
console.log('\nACCOUNT (per marketplace)');
console.log(pad('mp', 6) + pad('metric', 14) + pad('amazon', 14) + pad('sellerboard', 14) + pad('delta', 12) + pad('pct', 9) + 'status');
for (const r of accountRows) console.log(pad(r.mp, 6) + pad(r.metric, 14) + pad(r.amazon_value ?? '—', 14) + pad(r.sellerboard_value ?? '—', 14) + pad(r.delta ?? '', 12) + pad(r.delta_pct != null ? r.delta_pct + '%' : '', 9) + r.status);
console.log('\nBRAND × MARKETPLACE — non-matching only');
console.log(pad('brand', 22) + pad('mp', 6) + pad('metric', 14) + pad('amazon', 14) + pad('sellerboard', 14) + pad('delta', 12) + pad('pct', 9) + 'status');
for (const r of out.filter(r => r.status !== 'match')) console.log(pad(r.brand, 22) + pad(r.mp, 6) + pad(r.metric, 14) + pad(r.amazon_value ?? '—', 14) + pad(r.sellerboard_value ?? '—', 14) + pad(r.delta ?? '', 12) + pad(r.delta_pct != null ? r.delta_pct + '%' : '', 9) + r.status);
const counts = out.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
console.log('\nbrand-level rows:', JSON.stringify(counts));
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify({ from, to, account: accountRows, brands: out, sbSkippedMp, sbUnknownAsin }, null, 2));
