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

// ── SKU listing-price snapshot ───────────────────────────────────────────────
// The Pricing API can't price a SKU whose last unit just sold (no active
// offer). The snapshot captures listing prices while items ARE in stock —
// daily sweep over every brand SKU on both marketplaces — so a sold-out
// Pending item still gets priced at this morning's listing price.

const MP_CA = 'A2EUQ1WTGCTBG2';
const MP_US = 'ATVPDKIKX0DER';
const SNAP_TTL_MS = 30 * 60 * 1000;
let snapCache = { at: 0, prices: null };

// { "CA|<sku>": { asin, price }, "US|<sku>": ... } — entries fresher than maxAgeDays.
async function loadSkuPrices(maxAgeDays = 7) {
  if (snapCache.prices && Date.now() - snapCache.at < SNAP_TTL_MS) return snapCache.prices;
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = [];
  for (let page = 0; ; page++) {
    const { data, error } = await client()
      .from('sku_prices')
      .select('sku,mp_id,asin,price')
      .gte('fetched_at', cutoff)
      .range(page * 1000, page * 1000 + 999);
    if (error) { console.warn('[PriceCache] sku_prices load failed:', error.message); return snapCache.prices || {}; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const prices = {};
  for (const r of rows) {
    if (!(r.price > 0)) continue;
    prices[`${r.mp_id === MP_CA ? 'CA' : 'US'}|${r.sku}`] = { asin: r.asin, price: Number(r.price) };
  }
  snapCache = { at: Date.now(), prices };
  return prices;
}

// rows: [{ sku, mpId, asin, price, currency }]
async function saveSkuPrices(rows) {
  const clean = (rows || []).filter(r => r.sku && r.mpId && Number.isFinite(r.price) && r.price > 0);
  if (clean.length === 0) return 0;
  const payload = clean.map(r => ({
    sku: r.sku, mp_id: r.mpId, asin: r.asin || null,
    price: r.price, currency: r.currency || null,
    fetched_at: new Date().toISOString(),
  }));
  const { error } = await client().from('sku_prices').upsert(payload, { onConflict: 'sku,mp_id' });
  if (error) { console.warn('[PriceCache] sku_prices save failed:', error.message); return 0; }
  snapCache = { at: 0, prices: null }; // invalidate
  return payload.length;
}

// Daily sweep: price every known SKU on both marketplaces while in stock.
// Universe = brands' primary SKU per ASIN (listings report) ∪ every SKU ever
// stored here (order items add multi-SKU ASINs' non-primary SKUs over time).
async function refreshSkuPriceSnapshot(token) {
  const { fetchListingPrices, getAccessToken } = require('./amazon');
  token = token || await getAccessToken();

  const skuAsin = {}; // sku -> asin (for storage; a SKU maps to one ASIN)
  const { data: brandsRow, error: bErr } = await client().from('brands').select('data').eq('id', 'main').single();
  if (bErr) console.warn('[PriceCache] brands load failed:', bErr.message);
  for (const b of (brandsRow?.data?.brands || [])) {
    for (const [asin, sku] of Object.entries(b.asinSkus || {})) {
      if (sku) skuAsin[sku] = asin;
    }
  }
  const { data: existing } = await client().from('sku_prices').select('sku,asin').range(0, 4999);
  for (const r of (existing || [])) if (!skuAsin[r.sku]) skuAsin[r.sku] = r.asin;

  const skus = Object.keys(skuAsin);
  if (skus.length === 0) { console.warn('[PriceCache] snapshot refresh: no known SKUs'); return 0; }

  let saved = 0;
  for (const mpId of [MP_CA, MP_US]) {
    const prices = await fetchListingPrices(skus, mpId, token, { byType: 'Sku' });
    const rows = Object.entries(prices).map(([sku, p]) => ({
      sku, mpId, asin: skuAsin[sku] || null, price: p.amount, currency: p.currency,
    }));
    saved += await saveSkuPrices(rows);
  }
  console.log(`[PriceCache] Snapshot refresh: ${saved} SKU prices stored (${skus.length} SKUs swept, both marketplaces)`);
  return saved;
}

module.exports = { getTrailingPrices, loadSkuPrices, saveSkuPrices, refreshSkuPriceSnapshot };
