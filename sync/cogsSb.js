'use strict';
/**
 * Sellerboard-sourced COGS → the brands blob (`brand.cogsSb`), refreshed
 * after every feed ingest. Sellerboard is the source of truth for COGS
 * going forward (Mike, 2026-09-10): the team maintains unit costs there,
 * the dashboard pulls them in — no more parallel manual entry.
 *
 * WHAT THE NUMBERS MEAN
 * - The feed's `product_costs` per (day, marketplace, SKU) is the COGS
 *   Sellerboard charged that day — units sold × the unit cost configured in
 *   Sellerboard, plus occasional non-sales components (missing-from-inbound,
 *   multichannel, cost of missing returns) that land on odd days.
 * - COGS is entered in Sellerboard in the ACCOUNT currency (USD); the feed
 *   ingest already converts every money column to the marketplace's native
 *   currency at that day's rate, so rows here are native (CA→CAD, UK→GBP…).
 * - Inbound transportation (Amazon-purchased shipping) is deliberately NOT
 *   in product_costs: Sellerboard books it from Amazon's Finances as
 *   fbainboundtransportationfee / fbainboundconveniencefee, which the
 *   ingest nets into `amazon_fees`. COGS input stays pure supplier cost;
 *   inbound shipping rides the fee line. Don't add it here — that would
 *   double-count.
 *
 * DERIVATION: per (asin, marketplace) unit cost = MEDIAN of daily
 * product_costs / units over the trailing window, using only days with
 * units > 0 and product_costs > 0. Median (not mean) so a day carrying a
 * lump non-sales cost component can't skew the unit cost.
 *
 * PRECEDENCE (public/mp-scope.js cogsFor): cogsSb wins where present;
 * manual cogsPerMarketplace is the fallback for SKUs/marketplaces
 * Sellerboard doesn't cover; legacy brand.cogs last. Manual entry in the
 * app is now the exception path, not the system.
 */

const MP = require('./marketplaces');

const r4 = v => Math.round(v * 10000) / 10000;

/**
 * Pure derivation. rows: sellerboard_daily-shaped ({ date, mp_id, asin,
 * units, product_costs }, native currency). Returns
 * { [asin]: { [code]: { unit, currency, days, asOf } } }.
 */
function deriveUnitCogs(rows) {
  const samples = {}; // `${asin}|${mp_id}` → { costs: [], lastDate }
  for (const r of rows || []) {
    const units = Number(r.units) || 0;
    const costs = Number(r.product_costs) || 0;
    if (units <= 0 || costs <= 0) continue;
    const key = `${r.asin}|${r.mp_id}`;
    const e = samples[key] || (samples[key] = { perUnit: [], lastDate: r.date });
    e.perUnit.push(costs / units);
    if (r.date > e.lastDate) e.lastDate = r.date;
  }
  const out = {};
  for (const [key, e] of Object.entries(samples)) {
    const [asin, mpId] = key.split('|');
    const mp = MP.byId(mpId);
    if (!mp) continue;
    const sorted = [...e.perUnit].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    (out[asin] = out[asin] || {})[mp.code] = {
      unit: r4(median), currency: mp.currency, days: sorted.length, asOf: e.lastDate,
    };
  }
  return out;
}

/**
 * Refresh brand.cogsSb from the trailing window of sellerboard_daily.
 * Merge semantics: an (asin, code) with fresh data replaces its old entry;
 * entries with no fresh data are KEPT (a SKU that paused selling keeps its
 * last known cost) — the whole map is never wiped by a thin feed day.
 */
async function syncCogsFromSellerboard({ supabase, loadBrands, saveBrands, days = 30, label = 'CogsSb' }) {
  const { pstDateStr, pstSubtractDays } = require('./dateUtils');
  const to = pstSubtractDays(pstDateStr(), 1);
  const from = pstSubtractDays(to, days - 1);

  const rows = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase.from('sellerboard_daily')
      .select('date,mp_id,asin,units,product_costs')
      .gte('date', from).lte('date', to)
      .order('date').order('asin').order('mp_id')
      .range(off, off + 999);
    if (error) throw new Error(`sellerboard_daily read: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const derived = deriveUnitCogs(rows);
  if (!Object.keys(derived).length) {
    console.warn(`[${label}] no derivable COGS in ${from}..${to} — brands untouched`);
    return { updated: 0, asins: 0 };
  }

  const data = await loadBrands();
  let updated = 0, asins = 0;
  for (const brand of data.brands || []) {
    for (const asin of brand.asins || []) {
      const d = derived[asin];
      if (!d) continue;
      brand.cogsSb = brand.cogsSb || {};
      brand.cogsSb[asin] = { ...(brand.cogsSb[asin] || {}), ...d };
      asins++; updated += Object.keys(d).length;
    }
  }
  await saveBrands(data);
  console.log(`[${label}] wrote SB unit COGS for ${asins} ASINs (${updated} marketplace entries, window ${from}..${to})`);
  return { updated, asins };
}

module.exports = { deriveUnitCogs, syncCogsFromSellerboard };
