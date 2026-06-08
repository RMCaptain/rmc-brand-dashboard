#!/usr/bin/env node
/**
 * Rebuild daily_metrics units & revenue from the Orders API (authoritative,
 * matches Sellerboard). Overwrites any S&T-sourced or partial numbers.
 *
 * Writes ONLY units/revenue columns — S&T traffic (sessions/buy box) already in
 * the table is preserved (Supabase upsert updates only provided columns).
 *
 * Processes newest day first so the most-viewed recent days (and the broken
 * June 7) are corrected soonest. Idempotent — safe to re-run/resume.
 *
 * Usage:
 *   node scripts/rebuild-from-orders.js              # May 1 -> yesterday
 *   node scripts/rebuild-from-orders.js 2026-05-15   # custom start -> yesterday
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { computeDayFromOrders } = require('../sync/orders');
const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

const START_DATE = process.argv[2] || '2026-05-01';

function daysBetween(startStr, endStr) {
  const out = [];
  let d = endStr;
  while (d >= startStr) {
    out.push(d);            // newest first
    d = pstSubtractDays(d, 1);
  }
  return out;
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase
    .from('brands').select('data').eq('id', 'main').single();
  if (error) { console.error('Failed to load brands:', error.message); process.exit(1); }
  const brands = data?.data?.brands || [];
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;
  console.log(`Loaded ${brands.length} brands, ${Object.keys(asinBrand).length} mapped ASINs.`);

  const yesterday = pstSubtractDays(pstDateStr(), 1);
  const dates = daysBetween(START_DATE, yesterday);
  console.log(`Rebuilding ${dates.length} days from Orders API: ${yesterday} -> ${START_DATE}\n`);

  let done = 0;
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const { byAsin, orderCount } = await computeDayFromOrders(date);

      const rows = Object.entries(byAsin).map(([asin, d]) => ({
        asin,
        date,
        brand_id:    asinBrand[asin] || 'unknown-brand',
        units:       d.units      || 0,
        units_ca:    d.unitsCa    || 0,
        units_us:    d.unitsUs    || 0,
        revenue_cad: Math.round((d.revenueCad || 0) * 100) / 100,
        revenue_usd: Math.round((d.revenueUsd || 0) * 100) / 100,
      }));

      const totUnits = rows.reduce((s, r) => s + r.units, 0);
      const totCad   = rows.reduce((s, r) => s + r.revenue_cad, 0);
      const totUsd   = rows.reduce((s, r) => s + r.revenue_usd, 0);

      // Zero out units/revenue for ALL existing rows of this date first, so any
      // phantom units (ASINs with stale non-zero values but no real orders) get
      // cleared. Sessions/buy-box columns are untouched. Then write orders truth.
      const { error: zeroErr } = await supabase
        .from('daily_metrics')
        .update({ units: 0, units_ca: 0, units_us: 0, revenue_cad: 0, revenue_usd: 0 })
        .eq('date', date);
      if (zeroErr) { console.warn(`${date}: ZERO FAILED — ${zeroErr.message}`); }

      if (rows.length === 0) {
        console.log(`${date}: 0 orders — zeroed (genuine no-sales day or API gap)`);
      } else {
        const { error: upErr } = await supabase
          .from('daily_metrics')
          .upsert(rows, { onConflict: 'asin,date' });
        if (upErr) {
          console.warn(`${date}: UPSERT FAILED — ${upErr.message}`);
        } else {
          const secs = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`${date}: ${rows.length} ASINs | ${totUnits} units | CA$${totCad.toFixed(0)} US$${totUsd.toFixed(0)} | ${orderCount} orders | ${secs}s`);
        }
      }
    } catch (e) {
      console.warn(`${date}: ERROR — ${e.message}`);
    }
    done++;
    if (done % 5 === 0) console.log(`  ...${done}/${dates.length} days processed\n`);
  }

  console.log(`\nDone. Rebuilt ${dates.length} days from Orders API.`);
  process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
