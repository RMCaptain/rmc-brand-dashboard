/**
 * Daily Amazon fees & refunds — Finances API, bucketed per PST posted-day.
 *
 * WHY: the tile's payout/profit needs real Amazon fees for ARBITRARY date
 * ranges. Until 2026-07-29, amazonFees came from a per-preset passthrough —
 * custom ranges got $0 fees, overstating profit ~4x vs Sellerboard (Jul 1-29:
 * app $127k profit vs SB $31k; the entire gap was ~$80k of missing fees).
 *
 * HOW: one Finances-API walk per PST calendar day (posted-date window =
 * exactly that day). Day-sized windows sidestep the schema's missing
 * per-event PostedDate on some event types — everything in the response
 * belongs to the day. Posted-date semantics deliberately match Sellerboard.
 *
 * Each day upserts one row into daily_fees. Fees/refunds keep posting for
 * days after the order (refunds for weeks) — so refresh must re-collect a
 * trailing window, not just yesterday: nightly trailing 4 days + weekly
 * trailing 40 (see server.js crons).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, getFinancialSummary, sleep } = require('./amazon');
const { pstDateStr, pstSubtractDays, pstMidnightAsUTC } = require('./dateUtils');

const decodeSku = s => (s == null ? s : String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));

// Collect one PST day's posted fees/refunds.
// Returns { row, mpRows, asinRows }: the wide daily_fees row, the per-marketplace
// daily_fees_mp rows (true per-currency refund counts — the wide row's single
// count can't split by marketplace), and per-ASIN daily_fees_asin rows built
// from the walk's perSku aggregation via the skuToAsin map.
async function collectFeesForDay(pstDate, token, skuToAsin = {}) {
  const start = pstMidnightAsUTC(pstDate);
  const end   = pstMidnightAsUTC(pstSubtractDays(pstDate, -1));
  const f = await getFinancialSummary(start, end, token);
  const { idByCode } = require('./marketplaces');

  // Per-ASIN rows: SKU → ASIN via sku_prices; currency picks the marketplace
  // (CAD=CA, USD=US — same convention as the mp rows). Multiple SKUs of one
  // ASIN merge. Unmapped SKUs become 'sku:<SellerSKU>' — loud, never dropped.
  //
  // MULTI-MARKETPLACE NOTE: currency→marketplace is only safe because this
  // walk is the NA Amazon Finances API, where CAD can only be Amazon.ca.
  // Walmart.ca is also CAD — its fees must come from Walmart's own API into
  // daily_fees_mp with mp_id 'walmart_ca', never through this function.
  // UK (GBP) rides an EU-region walk that writes mp rows only.
  const asinAgg = new Map();
  for (const s of (f.perSku || [])) {
    const mpCode = s.currency === 'CAD' ? 'CA' : s.currency === 'USD' ? 'US' : null;
    if (!mpCode) { console.error(`[DailyFees] ${pstDate} sku ${s.sku}: fees in ${s.currency || 'unknown currency'} skipped — no CA/US home (ride daily_fees_mp when that marketplace goes live)`); continue; }
    const mpId = idByCode(mpCode);
    // The Finances API HTML-escapes SKUs ("A&amp;B"); sku_prices and Sellerboard
    // hold the real "A&B". Decode before the lookup — first live reconciliation
    // (2026-09-09) found $3.7k/30d of fees parked under 'sku:' for that alone.
    const skuKey = decodeSku(s.sku);
    const asin = (skuKey && (skuToAsin[`${skuKey}|${mpId}`] || skuToAsin[skuKey])) || `sku:${skuKey || 'unknown'}`;
    const key = `${asin}|${mpId}`;
    if (!asinAgg.has(key)) {
      asinAgg.set(key, { date: pstDate, asin, mp_id: mpId, currency: s.currency, fees: 0, refund_amount: 0, refund_fees: 0, refund_count: 0, breakdown: {}, updated_at: new Date().toISOString() });
    }
    const a = asinAgg.get(key);
    a.fees          += s.fees;
    a.refund_amount += s.refundAmount;
    a.refund_fees   += s.refundFees;
    a.refund_count  += s.refundCount;
    for (const [g, v] of Object.entries(s.breakdown || {})) a.breakdown[g] = Math.round(((a.breakdown[g] || 0) + v) * 100) / 100;
  }
  const asinRows = [...asinAgg.values()].map(a => ({
    ...a,
    fees:          Math.round(a.fees * 100) / 100,
    refund_amount: Math.round(a.refund_amount * 100) / 100,
    refund_fees:   Math.round(a.refund_fees * 100) / 100,
  }));
  const mpRow = (code, currency) => ({
    date: pstDate, mp_id: idByCode(code), currency,
    fees:          f[currency].amazonFees   || 0,
    service_fees:  f[currency].serviceFees  || 0,
    refund_amount: f[currency].refundAmount || 0,
    refund_fees:   f[currency].refundFees   || 0,
    refund_count:  f[currency].refundCount  || 0,
    ad_spend:      f[currency].adSpend      || 0,
    breakdown:     f[currency].breakdown    || {},
    updated_at:    new Date().toISOString(),
  });
  const mpRows = [mpRow('CA', 'CAD'), mpRow('US', 'USD')];
  const row = {
    date: pstDate,
    fees_cad:          f.CAD.amazonFees   || 0,
    fees_usd:          f.USD.amazonFees   || 0,
    service_fees_cad:  f.CAD.serviceFees  || 0,
    service_fees_usd:  f.USD.serviceFees  || 0,
    refund_amount_cad: f.CAD.refundAmount || 0,
    refund_amount_usd: f.USD.refundAmount || 0,
    refund_fees_cad:   f.CAD.refundFees   || 0,
    refund_fees_usd:   f.USD.refundFees   || 0,
    refund_count:      f.refundCount      || 0,
    ad_spend_cad:      f.CAD.adSpend      || 0,   // finances-posted ad charges (audit; tile ads stay Ads-API)
    ad_spend_usd:      f.USD.adSpend      || 0,
    breakdown_cad:     f.CAD.breakdown    || {},
    breakdown_usd:     f.USD.breakdown    || {},
    updated_at:        new Date().toISOString(),
  };
  return { row, mpRows, asinRows };
}

// SKU → ASIN map from sku_prices (daily listing-price sweep keeps it fresh).
// Keys both '<sku>|<mp_id>' (exact) and '<sku>' (fallback). Paginated past
// Supabase's 1000-row cap.
async function loadSkuAsinMap(supabase) {
  const map = {};
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase.from('sku_prices')
      .select('sku,mp_id,asin').range(off, off + 999);
    if (error) { console.warn(`[DailyFees] sku_prices load failed: ${error.message} — per-ASIN rows will be sku-keyed`); return map; }
    for (const r of data) {
      if (!r.asin) continue;
      map[`${r.sku}|${r.mp_id}`] = r.asin;
      if (!map[r.sku]) map[r.sku] = r.asin;
    }
    if (data.length < 1000) break;
  }
  // Sellerboard fallback: the feed carries SKU + ASIN + marketplace for every
  // row it has ever sold, including SKUs sku_prices never learned (first live
  // reconciliation 2026-09-09: eight US ASINs with real sales had $0 fees on
  // the ASIN table because their SKUs sat in the 'sku:' bucket). Only fills
  // gaps — sku_prices stays authoritative where it has an answer.
  try {
    let added = 0;
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from('sellerboard_daily')
        .select('sku,mp_id,asin').order('date', { ascending: false }).range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        if (!r.asin || !r.sku) continue;
        if (!map[`${r.sku}|${r.mp_id}`]) { map[`${r.sku}|${r.mp_id}`] = r.asin; added++; }
        if (!map[r.sku]) map[r.sku] = r.asin;
      }
      if (!data || data.length < 1000) break;
    }
    if (added) console.log(`[DailyFees] ${added} sku|marketplace pair(s) mapped from Sellerboard rows that sku_prices lacked`);
  } catch (e) {
    console.warn(`[DailyFees] Sellerboard sku map unavailable (${e.message}) — sku_prices only`);
  }
  return map;
}

/**
 * Collect + upsert a list of PST dates (newest-first recommended).
 * Skips (preserves) a day on API failure — never writes zeros for a day it
 * couldn't read. Returns { done, failed }.
 */
async function syncDailyFees(supabase, dates, { label = 'DailyFees' } = {}) {
  const token = await getAccessToken();
  const skuToAsin = await loadSkuAsinMap(supabase);
  let done = 0, failed = 0;
  for (const date of dates) {
    try {
      const { row, mpRows, asinRows } = await collectFeesForDay(date, token, skuToAsin);
      const { error } = await supabase.from('daily_fees').upsert(row, { onConflict: 'date' });
      if (error) throw new Error(error.message);
      // Expand-phase double-write: same day as per-marketplace rows in
      // daily_fees_mp (wide table stays the reader's source of truth for
      // CA/US; new marketplaces will write ONLY the mp table). A failed mp
      // write must not fail the day — log loudly and move on.
      try {
        const { error: mpErr } = await supabase.from('daily_fees_mp')
          .upsert(mpRows, { onConflict: 'date,mp_id' });
        if (mpErr) console.error(`[${label}] ${date}: daily_fees_mp double-write failed: ${mpErr.message}`);
      } catch (e2) {
        console.error(`[${label}] ${date}: daily_fees_mp double-write failed: ${e2.message}`);
      }
      // Per-ASIN rows: replace the day AFTER a successful fetch (never zero a
      // day we couldn't read — the fetch already succeeded above). Delete then
      // insert because an upsert would strand rows for ASINs that vanish on
      // re-collect. A failure here must not fail the day; next run self-heals.
      try {
        const { error: delErr } = await supabase.from('daily_fees_asin').delete().eq('date', date);
        if (delErr) throw new Error(delErr.message);
        if (asinRows.length) {
          const { error: insErr } = await supabase.from('daily_fees_asin').insert(asinRows);
          if (insErr) throw new Error(insErr.message);
        }
        const unmapped = asinRows.filter(r => r.asin.startsWith('sku:'));
        if (unmapped.length) console.warn(`[${label}] ${date}: ${unmapped.length} unmapped SKU rows (${unmapped.slice(0, 3).map(r => r.asin).join(', ')}${unmapped.length > 3 ? ', …' : ''})`);
      } catch (e3) {
        console.error(`[${label}] ${date}: daily_fees_asin write failed: ${e3.message}`);
      }
      done++;
      const tot = (row.fees_cad + row.fees_usd + row.service_fees_cad + row.service_fees_usd).toFixed(0);
      console.log(`[${label}] ${date}: fees+service $${tot} | refunds ${row.refund_count}`);
    } catch (e) {
      failed++;
      console.warn(`[${label}] ${date} FAILED (kept previous): ${e.message.slice(0, 120)}`);
    }
    await sleep(2100); // Finances API: ~0.5 rps
  }
  return { done, failed };
}

// Trailing-window refresh used by crons.
function trailingDates(days) {
  const out = [];
  const today = pstDateStr();
  for (let i = 1; i <= days; i++) out.push(pstSubtractDays(today, i));
  return out;
}

module.exports = { collectFeesForDay, syncDailyFees, trailingDates, loadSkuAsinMap };
