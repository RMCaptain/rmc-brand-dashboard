/**
 * Trailing realized ASIN prices, derived from finalized daily_metrics days.
 *
 * Used as the last rung of the Pending-order price-estimation ladder (see
 * estimateDay in sync/orders.js): when an item has no live listing price and
 * no same-day realized average, we price it at what the ASIN actually sold
 * for over the trailing two weeks. Window excludes today and yesterday —
 * those rows may themselves contain estimates.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { pstDateStr, pstSubtractDays } = require('./dateUtils');

const TTL_MS = 6 * 60 * 60 * 1000;
let cache = { at: 0, prices: {} };
let supabase = null;

function client() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

// { [asin]: { ca: <avg CAD price|null>, us: <avg USD price|null> } }
// On query failure returns the previous cache (stale beats empty — an empty
// map would silently disable the trailing fallback for every ASIN).
async function getTrailingPrices(force = false) {
  if (!force && cache.at && Date.now() - cache.at < TTL_MS) return cache.prices;

  const to   = pstSubtractDays(pstDateStr(), 2);
  const from = pstSubtractDays(to, 14);

  // Supabase caps selects at 1000 rows — page through the window.
  const rows = [];
  for (let page = 0; ; page++) {
    const { data, error } = await client()
      .from('daily_metrics')
      .select('asin,units_ca,units_us,revenue_cad,revenue_usd')
      .gte('date', from).lte('date', to)
      .range(page * 1000, page * 1000 + 999);
    if (error) {
      console.warn('[PriceCache] trailing-price query failed:', error.message);
      return cache.prices;
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }

  const agg = {};
  for (const r of rows) {
    const a = agg[r.asin] || (agg[r.asin] = { uCa: 0, uUs: 0, rCa: 0, rUs: 0 });
    a.uCa += r.units_ca || 0;
    a.uUs += r.units_us || 0;
    a.rCa += r.revenue_cad || 0;
    a.rUs += r.revenue_usd || 0;
  }

  const prices = {};
  for (const [asin, a] of Object.entries(agg)) {
    const ca = a.uCa > 0 && a.rCa > 0 ? a.rCa / a.uCa : null;
    const us = a.uUs > 0 && a.rUs > 0 ? a.rUs / a.uUs : null;
    if (ca || us) prices[asin] = { ca, us };
  }

  cache = { at: Date.now(), prices };
  console.log(`[PriceCache] Trailing prices refreshed: ${Object.keys(prices).length} ASINs (${from}..${to})`);
  return prices;
}

module.exports = { getTrailingPrices };
