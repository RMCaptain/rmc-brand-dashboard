#!/usr/bin/env node
/**
 * Backfill per-brand daily order counts into daily_brand_orders (for AOV).
 *
 *   node scripts/backfill-order-counts.js 2026-01-01 2026-07-14
 *
 * WHY NOT rebuild-from-orders.js:
 * That script zeroes a day's daily_metrics rows and re-upserts them. If a
 * re-pull comes back partially rate-limited it writes fewer ASINs than it
 * erased — silently destroying good revenue. The Jan-Mar revenue this would
 * run over cost ~10 hours to recover, so this script does not go near
 * daily_metrics. It reads the Orders API and writes ONLY daily_brand_orders.
 *
 * Same Orders API cost either way (~3 min/day); the difference is blast radius.
 *
 * Idempotent and resumable: re-running a date overwrites that date's counts
 * with the same values. Safe to kill and restart.
 *
 * Writes to whatever SUPABASE_URL points at — which is PRODUCTION.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { computeDayFromOrders, brandOrderCounts } = require('../sync/orders');
const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

const START = process.argv[2];
const END   = process.argv[3] || pstSubtractDays(pstDateStr(), 1);

function daysBetween(startStr, endStr) {
  const out = [];
  let d = endStr;
  while (d >= startStr) { out.push(d); d = pstSubtractDays(d, 1); }
  return out;   // newest first
}

(async () => {
  if (!START) { console.error('Usage: backfill-order-counts.js <start> [end]'); process.exit(1); }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const { data, error } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (error) { console.error('Failed to load brands:', error.message); process.exit(1); }
  const brands = data?.data?.brands || [];
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;
  console.log(`Loaded ${brands.length} brands, ${Object.keys(asinBrand).length} mapped ASINs.`);

  const dates = daysBetween(START, END);
  console.log(`Order-count backfill: ${END} -> ${START} (${dates.length} days)\n`);

  let done = 0, wrote = 0, skipped = 0, failed = 0;
  for (const date of dates) {
    const t0 = Date.now();
    try {
      const { orderContrib, orderCount, unrecoveredOrders } = await computeDayFromOrders(date);
      const counts = brandOrderCounts(orderContrib, asinBrand);
      const rows = Object.entries(counts).map(([brand_id, c]) => ({
        brand_id, date, ...c, updated_at: new Date().toISOString(),
      }));

      // Nothing back = rate-limit or a genuinely dead day. Either way, don't
      // write zeros over a day that may already be correct — the same mistake
      // that made "0" and "no data" indistinguishable in daily_metrics.
      if (!rows.length) {
        skipped++;
        console.warn(`${date}: no orders returned — SKIPPED (nothing written)`);
      } else {
        const { error: upErr } = await supabase
          .from('daily_brand_orders').upsert(rows, { onConflict: 'brand_id,date' });
        if (upErr) { failed++; console.warn(`${date}: UPSERT FAILED — ${upErr.message}`); }
        else {
          wrote++;
          const secs = ((Date.now() - t0) / 1000).toFixed(0);
          const warn = unrecoveredOrders > 0 ? ` | ${unrecoveredOrders} orders unrecovered` : '';
          console.log(`${date}: ${rows.length} brands | ${orderCount} orders | ${secs}s${warn}`);
        }
      }
    } catch (e) {
      failed++;
      console.warn(`${date}: ERROR — ${e.message}`);
    }
    done++;
    if (done % 10 === 0) console.log(`  ...${done}/${dates.length} days (${wrote} written, ${skipped} skipped, ${failed} failed)\n`);
  }

  console.log(`\nDone. ${wrote} days written, ${skipped} skipped, ${failed} failed, of ${dates.length}.`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
