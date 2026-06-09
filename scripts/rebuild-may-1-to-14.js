#!/usr/bin/env node
/**
 * Rebuild ONLY May 1-14 from Orders API. These days currently hold inflated
 * S&T-era data (388 units/day, $13K/day blended) while May 15-31 was already
 * rebuilt from Orders (~195 units/day, $6.5K/day). The inconsistency makes
 * "Last Month" total ~$100K too high.
 *
 * Safety: only zeros existing rows when Orders API actually returned data.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { computeDayFromOrders } = require('../sync/orders');

const DATES = [];
for (let i = 0; i < 14; i++) {
  const d = new Date('2026-05-01T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + i);
  DATES.push(d.toISOString().split('T')[0]);
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('brands').select('data').eq('id', 'main').single();
  if (error) { console.error('Failed to load brands:', error.message); process.exit(1); }
  const brands = data?.data?.brands || [];
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;
  console.log(`Loaded ${brands.length} brands. Rebuilding ${DATES.length} days: ${DATES[0]} → ${DATES[DATES.length-1]}\n`);

  for (const date of DATES) {
    const t0 = Date.now();
    try {
      const { byAsin, orderCount } = await computeDayFromOrders(date);
      const asinCount = Object.keys(byAsin).length;

      if (asinCount === 0) {
        console.warn(`${date}: 0 orders from API (rate-limit or no-sales) — SKIPPED, existing data preserved`);
        continue;
      }

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

      // Zero existing financial columns (preserves S&T traffic), then write orders truth
      const { error: zeroErr } = await supabase
        .from('daily_metrics')
        .update({ units: 0, units_ca: 0, units_us: 0, revenue_cad: 0, revenue_usd: 0 })
        .eq('date', date);
      if (zeroErr) { console.warn(`${date}: ZERO FAILED — ${zeroErr.message}`); continue; }

      const { error: upErr } = await supabase
        .from('daily_metrics')
        .upsert(rows, { onConflict: 'asin,date' });
      if (upErr) { console.warn(`${date}: UPSERT FAILED — ${upErr.message}`); continue; }

      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`${date}: ${rows.length} ASINs | ${totUnits} units | CA$${totCad.toFixed(0)} US$${totUsd.toFixed(0)} blended=CA$${(totCad+totUsd*1.38).toFixed(0)} | ${orderCount} orders | ${secs}s`);
    } catch (e) {
      console.warn(`${date}: ERROR — ${e.message}`);
    }
  }
  console.log('\nDone.');
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
