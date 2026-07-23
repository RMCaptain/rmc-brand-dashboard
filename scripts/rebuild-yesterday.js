#!/usr/bin/env node
/**
 * Reconstruct daily_metrics for "yesterday" using the Orders API.
 * Useful when the S&T sync ran prematurely and overwrote the day with zeros,
 * or when Orders state was lost to a server restart.
 *
 * Usage: node scripts/rebuild-yesterday.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
process.env.SYNC_ENABLED = 'true'; // orders.js gates on this
const { createClient } = require('@supabase/supabase-js');
const ordersPoller = require('../sync/orders');
const { pstSubtractDays, pstDateStr } = require('../sync/dateUtils');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const yest = pstSubtractDays(pstDateStr(), 1);
  console.log(`Rebuilding orders state for ${yest}...`);

  // computeDayFromOrders: full pull + rate-limit retry pass + Pending-order
  // revenue estimation (byAsinEstimated) — same pipeline as the nightly finalize.
  const result = await ordersPoller.computeDayFromOrders(yest);
  const state = { date: result.date, byAsin: result.byAsinEstimated || result.byAsin };
  state.asinCount = Object.keys(state.byAsin).length;

  console.log(`Computed: ${state.asinCount} ASINs, date=${state.date}, ${result.orderCount} orders`);
  if (!state.date || state.asinCount === 0) {
    console.error('Rebuild returned no data — aborting.');
    process.exit(1);
  }

  // Load brand → asin mapping
  const { data: brandsRow } = await supabase
    .from('brands').select('data').eq('id', 'main').single();
  const brands = brandsRow?.data?.brands || [];
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  const rows = Object.entries(state.byAsin)
    .filter(([, d]) => (d.units || 0) > 0 || (d.revenueCad || 0) > 0 || (d.revenueUsd || 0) > 0)
    .map(([asin, d]) => ({
      asin,
      date:        state.date,
      brand_id:    asinBrand[asin] || 'unknown-brand',
      units:       d.units      || 0,
      units_ca:    d.unitsCa    || 0,
      units_us:    d.unitsUs    || 0,
      revenue_cad: Math.round((d.revenueCad || 0) * 100) / 100,
      revenue_usd: Math.round((d.revenueUsd || 0) * 100) / 100,
    }));

  const totalUnits = rows.reduce((s, r) => s + r.units, 0);
  const totalRev   = rows.reduce((s, r) => s + r.revenue_cad + r.revenue_usd * 1.38, 0);
  console.log(`Writing ${rows.length} rows, ${totalUnits} units, blended CA$${totalRev.toFixed(2)}`);

  const { error } = await supabase.from('daily_metrics').upsert(rows, { onConflict: 'asin,date' });
  if (error) { console.error('Upsert failed:', error.message); process.exit(1); }
  console.log('✓ daily_metrics updated.');
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
