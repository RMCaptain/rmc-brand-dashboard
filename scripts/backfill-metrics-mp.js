#!/usr/bin/env node
/**
 * Backfill daily_metrics_mp from daily_metrics' currency columns.
 *
 * Splits each wide row into per-marketplace long rows:
 *   units_ca / revenue_cad / spend_cad / attributed_sales_cad / refund_amount_cad → amazon.ca (A2EUQ1WTGCTBG2)
 *   units_us / revenue_usd / spend_usd / attributed_sales_usd / refund_amount_usd → amazon.com (ATVPDKIKX0DER)
 *
 * NOT splittable from the wide table (blended at sync time, stay NULL here):
 * sessions, page_views, buy_box_pct, ad_clicks/impressions/orders,
 * refunded_units, refund_count. Forward syncs fill what they can.
 *
 * Idempotent — re-run any time to re-sync history from the wide table
 * (e.g. after a wide-table repair script that predates the double-writes).
 *
 * Usage: node scripts/backfill-metrics-mp.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { MP_CA, MP_US, upsertMpRows } = require('../sync/metricsMp');

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const all = [];
  for (let fromRow = 0; ; fromRow += 1000) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('date,asin,brand_id,units_ca,units_us,revenue_cad,revenue_usd,spend_cad,spend_usd,attributed_sales_cad,attributed_sales_usd,refund_amount_cad,refund_amount_usd')
      .order('date', { ascending: true }).order('asin', { ascending: true })
      .range(fromRow, fromRow + 999);
    if (error) { console.error('Read failed:', error.message); process.exit(1); }
    all.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  console.log(`Read ${all.length} wide rows.`);

  // Preserve NULL-vs-0 from the source: only copy fields the wide row has,
  // and only emit a marketplace row when something on that side is > 0.
  const side = (r, suffix) => {
    const f = {};
    const map = {
      units:               suffix === 'ca' ? r.units_ca : r.units_us,
      revenue:             suffix === 'ca' ? r.revenue_cad : r.revenue_usd,
      ad_spend:            suffix === 'ca' ? r.spend_cad : r.spend_usd,
      ad_attributed_sales: suffix === 'ca' ? r.attributed_sales_cad : r.attributed_sales_usd,
      refund_amount:       suffix === 'ca' ? r.refund_amount_cad : r.refund_amount_usd,
    };
    let hasData = false;
    for (const [col, v] of Object.entries(map)) {
      if (v == null) continue;
      f[col] = v;
      if (v > 0) hasData = true;
    }
    return hasData ? f : null;
  };

  const rows = [];
  for (const r of all) {
    const ca = side(r, 'ca');
    const us = side(r, 'us');
    if (ca) rows.push({ date: r.date, asin: r.asin, mp_id: MP_CA, currency: 'CAD', brand_id: r.brand_id, ...ca });
    if (us) rows.push({ date: r.date, asin: r.asin, mp_id: MP_US, currency: 'USD', brand_id: r.brand_id, ...us });
  }
  console.log(`Prepared ${rows.length} long rows (${rows.filter(r => r.mp_id === MP_CA).length} CA, ${rows.filter(r => r.mp_id === MP_US).length} US).`);

  const written = await upsertMpRows(supabase, rows, 'backfill');
  if (written !== rows.length) { console.error(`Only ${written}/${rows.length} written — inspect warnings above.`); process.exit(1); }
  console.log(`✓ ${written} rows upserted into daily_metrics_mp.`);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
