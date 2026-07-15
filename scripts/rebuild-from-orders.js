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
const { computeDayFromOrders, brandOrderCounts } = require('../sync/orders');
const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

// Usage: node scripts/rebuild-from-orders.js <start> [end]
// END defaults to yesterday. Pass it to target a specific gap instead of
// re-pulling every day since START — the Orders API is heavily rate-limited,
// so re-doing months that are already correct costs hours for nothing.
const START_DATE = process.argv[2] || '2026-05-01';
const END_DATE   = process.argv[3] || null;

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
  const endDate   = END_DATE && END_DATE < yesterday ? END_DATE : yesterday;
  const dates = daysBetween(START_DATE, endDate);
  console.log(`Rebuilding ${dates.length} days from Orders API: ${endDate} -> ${START_DATE}\n`);

  let done = 0;
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const { byAsin, orderCount, orderContrib } = await computeDayFromOrders(date);

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

      // CRITICAL: refuse to zero when Orders API returned nothing — a rate-limit
      // or transient error must not wipe a populated day. Only zero when we
      // actually have replacement data.
      if (rows.length === 0) {
        console.warn(`${date}: 0 orders from API (rate-limit or no-sales) — SKIPPED, existing data preserved`);
      } else {
        const { error: zeroErr } = await supabase
          .from('daily_metrics')
          .update({ units: 0, units_ca: 0, units_us: 0, revenue_cad: 0, revenue_usd: 0 })
          .eq('date', date);
        if (zeroErr) { console.warn(`${date}: ZERO FAILED — ${zeroErr.message}`); }
        // Fall through to upsert below
        const { error: upErr } = await supabase
          .from('daily_metrics')
          .upsert(rows, { onConflict: 'asin,date' });
        if (upErr) {
          console.warn(`${date}: UPSERT FAILED — ${upErr.message}`);
        } else {
          // Per-brand order counts for AOV. Separate table, separate grain —
          // orders are a brand/day fact, not an asin/day one. Non-fatal: a
          // missing table must not cost us the revenue rebuild above.
          let orderNote = '';
          try {
            const counts = brandOrderCounts(orderContrib, asinBrand);
            const orderRows = Object.entries(counts).map(([brand_id, c]) => ({ brand_id, date, ...c, updated_at: new Date().toISOString() }));
            if (orderRows.length) {
              const { error: oErr } = await supabase
                .from('daily_brand_orders').upsert(orderRows, { onConflict: 'brand_id,date' });
              if (oErr) orderNote = ` | orders NOT stored (${oErr.message.slice(0, 40)})`;
              else      orderNote = ` | ${orderRows.length} brand order-counts`;
            }
          } catch (e) { orderNote = ` | order-count error: ${e.message.slice(0, 40)}`; }

          const secs = ((Date.now() - t0) / 1000).toFixed(0);
          console.log(`${date}: ${rows.length} ASINs | ${totUnits} units | CA$${totCad.toFixed(0)} US$${totUsd.toFixed(0)} | ${orderCount} orders | ${secs}s${orderNote}`);
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
