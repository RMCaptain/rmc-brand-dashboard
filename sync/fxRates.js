'use strict';
/**
 * Daily FX rates (fx_rates table, sql/fx-rates.sql) — one row per day of
 * `toCad` multipliers, the same shape /api/fx serves.
 *
 * WHY: a Sellerboard account reports every marketplace in the ACCOUNT's
 * currency ("Rocky Mountain Co" = USD, so Amazon.ca rows arrive in USD).
 * sellerboard_daily stores marketplace-native money, so the ingest has to
 * convert with the rate Sellerboard used for that day — not today's. The
 * dashboard's daily FX fetch records its rate here; the ingest reads the
 * row for each feed day and falls back to the nearest earlier day, then the
 * live rate, then the static fallback.
 */
const FALLBACK_TO_CAD = { CAD: 1, USD: 1.38, GBP: 1.75 };
const r4 = v => Math.round(v * 10000) / 10000;

/** Live rate from the same public endpoint server.js uses. Never throws. */
async function fetchLatestToCad(wanted = ['CAD', 'USD', 'GBP']) {
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(15000) });
    const json = await res.json();
    const usdToCad = json.rates?.CAD;
    if (!usdToCad) return null;
    const toCad = { CAD: 1, USD: usdToCad };
    for (const cur of wanted) {
      if (toCad[cur] != null) continue;
      const perUsd = json.rates?.[cur];
      toCad[cur] = perUsd ? r4(usdToCad / perUsd) : (FALLBACK_TO_CAD[cur] ?? null);
    }
    return toCad;
  } catch { return null; }
}

/** Upsert one day's rates. `date` is the PST calendar day. Never throws. */
async function recordRate(supabase, date, toCad, source = 'open.er-api') {
  if (!supabase || !date || !toCad) return false;
  try {
    const { error } = await supabase.from('fx_rates').upsert([{ date, to_cad: toCad, source, fetched_at: new Date().toISOString() }], { onConflict: 'date' });
    if (error) { console.warn('[FxRates] record failed:', error.message); return false; }
    return true;
  } catch (e) { console.warn('[FxRates] record failed:', e.message); return false; }
}

/** Read the rows covering [from, to] plus the last row before `from` (carry-forward). */
async function loadDailyRates(supabase, from, to) {
  const out = {};
  if (!supabase) return out;
  try {
    const { data, error } = await supabase.from('fx_rates').select('date,to_cad').gte('date', from).lte('date', to).order('date', { ascending: true });
    if (error) throw new Error(error.message);
    for (const r of data || []) out[r.date] = r.to_cad;
    const prev = await supabase.from('fx_rates').select('date,to_cad').lt('date', from).order('date', { ascending: false }).limit(1);
    if (prev.data?.[0]) out[prev.data[0].date] = prev.data[0].to_cad;
  } catch (e) { console.warn('[FxRates] daily rates unreadable (fx_rates table missing?):', e.message); }
  return out;
}

/**
 * Build a rate resolver: rateFor(date, from, to) → { rate, source } where
 * `rate` is the multiplier turning `from`-currency money into `to`.
 * Sources: 'daily' (exact day), 'carry' (nearest earlier day), 'live', 'fallback'.
 */
function makeRateResolver({ daily = {}, live = null } = {}) {
  const dates = Object.keys(daily).sort();
  const convert = (toCad, from, to) => (toCad?.[from] != null && toCad?.[to] ? r4(toCad[from] / toCad[to]) : null);
  return function rateFor(date, from, to) {
    if (from === to) return { rate: 1, source: 'same' };
    if (daily[date]) { const rate = convert(daily[date], from, to); if (rate) return { rate, source: 'daily' }; }
    for (let i = dates.length - 1; i >= 0; i--) {
      if (dates[i] < date) { const rate = convert(daily[dates[i]], from, to); if (rate) return { rate, source: 'carry' }; break; }
    }
    if (live) { const rate = convert(live, from, to); if (rate) return { rate, source: 'live' }; }
    return { rate: convert(FALLBACK_TO_CAD, from, to) || 1, source: 'fallback' };
  };
}

module.exports = { fetchLatestToCad, recordRate, loadDailyRates, makeRateResolver, FALLBACK_TO_CAD };
