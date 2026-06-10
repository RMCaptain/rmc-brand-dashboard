/**
 * Refund tracking via the FBA Returns Report (near-real-time, 24-48h lag).
 *
 * Why this report vs Financial Events:
 *   - Financial Events only surfaces SETTLED activity (~14-30 day lag) — fine
 *     for monthly P&L but useless for the dashboard's "refunds yesterday" tile.
 *   - GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA publishes within 24-48h of
 *     Amazon receiving the return, matching what Sellerboard surfaces.
 *
 * Attribution (per Mike, 2026-06):
 *   - refund counts against the ORIGINAL order's PST date (we look up
 *     PurchaseDate via getOrder per unique order id, cached in-process)
 *   - 1 returned unit = 1 unit at the ASIN row (no multipack expansion)
 *   - refund $ derived from daily_metrics avg price for that ASIN on that
 *     day (revenue / units). No extra getOrderItems call required.
 *   - unmapped ASINs → unknown-brand
 *
 * Idempotency: license-plate-number is unique per physically-returned unit.
 * We store it as event_id in refund_events; re-runs over overlapping windows
 * skip rows already present.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, sleep, createReport, waitForReport, downloadReport, getMarketplaceIds } = require('./amazon');
const { pstDateStr, pstSubtractDays } = require('./dateUtils');

const LA_TZ = 'America/Los_Angeles';
const RETURNS_REPORT_TYPE = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';

function utcToPstDate(utcIso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LA_TZ }).format(new Date(utcIso));
}

// Parse TSV report body. Returns array of row objects keyed by lowercase
// header. Amazon reports use header-row + tab-separated values.
function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = (cells[j] || '').trim();
    rows.push(obj);
  }
  return rows;
}

// Pull the FBA Returns Report for [from, to] from one marketplace.
async function pullReturnsForMarketplace(mpId, fromIso, toIso, token) {
  const reportId = await createReport(
    RETURNS_REPORT_TYPE,
    [mpId],
    null,
    { start: fromIso, end: toIso },
    token,
  );
  const docId = await waitForReport(reportId, token);
  const raw   = await downloadReport(docId, token);
  return parseTsv(raw);
}

// Order-meta cache. Returns { purchaseDate, marketplaceId } per orderId.
// 600ms gap per call. Cached so we don't refetch the same order.
async function fetchOrderMeta(orderId, token, cache) {
  if (cache[orderId] !== undefined) return cache[orderId];
  await sleep(600);
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}`, token);
  if (res.status !== 200) {
    console.warn(`[Refunds] getOrder ${orderId} → ${res.status}`);
    cache[orderId] = null;
    return null;
  }
  const order = res.body?.payload || {};
  const purchaseDate  = order.PurchaseDate ? utcToPstDate(order.PurchaseDate) : null;
  const marketplaceId = order.MarketplaceId || null;
  cache[orderId] = purchaseDate ? { purchaseDate, marketplaceId } : null;
  return cache[orderId];
}

// Look up a per-ASIN per-day average price (blended CAD) from daily_metrics.
// Used to derive refund $ when the report itself doesn't include price.
async function getAvgPriceCache(supabase, asinDatePairs) {
  // asinDatePairs: array of [asin, date]
  const out = {};
  if (asinDatePairs.length === 0) return out;
  const byDate = {};
  for (const [asin, date] of asinDatePairs) {
    if (!byDate[date]) byDate[date] = new Set();
    byDate[date].add(asin);
  }
  for (const [date, asinSet] of Object.entries(byDate)) {
    const asins = [...asinSet];
    for (let i = 0; i < asins.length; i += 100) {
      const chunk = asins.slice(i, i + 100);
      const { data } = await supabase
        .from('daily_metrics')
        .select('asin,units,revenue_cad,revenue_usd')
        .eq('date', date)
        .in('asin', chunk);
      for (const r of (data || [])) {
        const u = r.units || 0;
        if (u === 0) continue;
        out[`${r.asin}|${date}`] = {
          unitPriceCad: (r.revenue_cad || 0) / u,
          unitPriceUsd: (r.revenue_usd || 0) / u,
        };
      }
    }
  }
  return out;
}

async function syncRefunds(supabase, brands, { windowDays = 30 } = {}) {
  const token = await getAccessToken();

  // ASIN → brand_id for unknown-brand fallback
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  const todayPst = pstDateStr();
  const toIso    = new Date().toISOString();
  const fromIso  = new Date(Date.now() - windowDays * 86400000).toISOString();

  // Pull returns from both marketplaces. Returns reports include the
  // marketplace's currency context implicitly via the order — we re-derive
  // it from daily_metrics later.
  const allRows = [];
  for (const mpId of getMarketplaceIds()) {
    console.log(`[Refunds] Requesting FBA Returns Report for ${mpId}, ${windowDays}-day window...`);
    try {
      const rows = await pullReturnsForMarketplace(mpId, fromIso, toIso, token);
      console.log(`[Refunds]   ${mpId}: ${rows.length} return rows`);
      for (const r of rows) r._mpId = mpId;
      allRows.push(...rows);
    } catch (e) {
      console.warn(`[Refunds] ${mpId} returns report failed: ${e.message}`);
    }
    await sleep(2000);
  }

  if (allRows.length === 0) {
    console.log('[Refunds] No return rows — preserving existing data, exiting');
    return { processed: 0, written: 0 };
  }

  // Normalize. license-plate-number is the per-unit unique key; fall back to
  // order+sku+date if missing (rare for FBA).
  const events = [];
  for (const r of allRows) {
    const orderId = r['order-id'];
    const asin    = r['asin'];
    const sku     = r['sku'];
    const qty     = parseInt(r['quantity'] || '1', 10);
    const lpn     = r['license-plate-number'] || `${orderId}|${sku}|${r['return-date']}`;
    const returnDate = r['return-date'];
    if (!orderId || !asin || !qty) continue;
    events.push({ event_id: lpn, orderId, asin, sku, qty, returnDate, mpId: r._mpId });
  }

  // Skip events already in refund_events (idempotency)
  const ids = events.map(e => e.event_id);
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await supabase.from('refund_events').select('event_id').in('event_id', chunk);
    for (const r of (data || [])) existing.add(r.event_id);
  }
  const fresh = events.filter(e => !existing.has(e.event_id));
  console.log(`[Refunds] ${events.length} total returns, ${fresh.length} new, ${existing.size} already processed`);
  if (fresh.length === 0) return { processed: events.length, written: 0 };

  // Dedup by event_id FIRST. FBA Returns Report appears to ignore the
  // MarketplaceIds filter and return the same data for both CA and US
  // marketplace queries — every LPN shows up twice. Keep one copy per LPN;
  // currency will be derived from the original order's MarketplaceId below.
  const seenLpn = new Set();
  const uniqueFresh = [];
  for (const e of fresh) {
    if (seenLpn.has(e.event_id)) continue;
    seenLpn.add(e.event_id);
    uniqueFresh.push(e);
  }
  if (uniqueFresh.length < fresh.length) {
    console.log(`[Refunds] Deduped ${fresh.length} → ${uniqueFresh.length} (FBA report listed LPNs across both marketplaces)`);
  }

  // Resolve original purchase date + marketplace for each unique order
  const meta = {};
  const uniqueOrders = [...new Set(uniqueFresh.map(e => e.orderId))];
  console.log(`[Refunds] Resolving order meta for ${uniqueOrders.length} orders...`);
  for (const id of uniqueOrders) {
    await fetchOrderMeta(id, token, meta);
  }

  // Filter to returns whose original order resolved, then look up per-(asin,date)
  // avg unit price from daily_metrics for the refund $ amount.
  const enriched = uniqueFresh
    .map(e => {
      const m = meta[e.orderId];
      return m ? { ...e, originalDate: m.purchaseDate, originalMp: m.marketplaceId } : null;
    })
    .filter(Boolean);
  const priceMap = await getAvgPriceCache(supabase,
    enriched.map(e => [e.asin, e.originalDate]));

  // Build refund_events rows. Currency is derived from the ORIGINAL order's
  // marketplace, not the report we pulled it from.
  const rowsToInsert = enriched.map(e => {
    const isCA = e.originalMp === 'A2EUQ1WTGCTBG2';
    const price = priceMap[`${e.asin}|${e.originalDate}`] || { unitPriceCad: 0, unitPriceUsd: 0 };
    const unitPrice = isCA ? price.unitPriceCad : price.unitPriceUsd;
    return {
      event_id:             e.event_id,
      amazon_order_id:      e.orderId,
      posted_at:            e.returnDate + (e.returnDate.length === 10 ? 'T00:00:00Z' : ''),
      original_order_date:  e.originalDate,
      asin:                 e.asin,
      marketplace_currency: isCA ? 'CAD' : 'USD',
      refunded_units:       e.qty,
      refund_amount:        Math.round(unitPrice * e.qty * 100) / 100,
    };
  });

  // Insert refund_events
  let inserted = 0;
  for (let i = 0; i < rowsToInsert.length; i += 100) {
    const chunk = rowsToInsert.slice(i, i + 100);
    const { error } = await supabase.from('refund_events').upsert(chunk, { onConflict: 'event_id' });
    if (error) console.warn('[Refunds] upsert refund_events:', error.message);
    else inserted += chunk.length;
  }
  console.log(`[Refunds] Wrote ${inserted} refund_events rows`);

  // Recompute aggregate refund columns for every affected (asin, date)
  const affectedDates = [...new Set(rowsToInsert.map(r => r.original_order_date))];
  await recomputeRefundAggregates(supabase, asinBrand, affectedDates);

  return { processed: events.length, written: inserted, datesTouched: affectedDates.length };
}

// For each (asin, date) in the affected dates, sum refund_events rows and
// write back to daily_metrics refund_* columns.
async function recomputeRefundAggregates(supabase, asinBrand, dates) {
  for (const date of dates) {
    const { data: rows, error } = await supabase
      .from('refund_events')
      .select('asin,marketplace_currency,refunded_units,refund_amount')
      .eq('original_order_date', date);
    if (error) { console.warn(`[Refunds] read events for ${date}:`, error.message); continue; }

    const byAsin = {};
    for (const r of (rows || [])) {
      const a = r.asin || 'UNMAPPED';
      if (!byAsin[a]) byAsin[a] = { units: 0, cad: 0, usd: 0, count: 0 };
      byAsin[a].units += r.refunded_units || 0;
      byAsin[a].count += 1;
      if (r.marketplace_currency === 'USD') byAsin[a].usd += r.refund_amount || 0;
      else                                   byAsin[a].cad += r.refund_amount || 0;
    }

    const updates = Object.entries(byAsin).map(([asin, v]) => ({
      asin:              asin === 'UNMAPPED' ? `UNMAPPED-REFUND-${date}` : asin,
      date,
      brand_id:          asin === 'UNMAPPED' ? 'unknown-brand' : (asinBrand[asin] || 'unknown-brand'),
      refunded_units:    v.units,
      refund_amount_cad: Math.round(v.cad * 100) / 100,
      refund_amount_usd: Math.round(v.usd * 100) / 100,
      refund_count:      v.count,
    }));
    if (updates.length === 0) continue;

    const { error: upErr } = await supabase
      .from('daily_metrics')
      .upsert(updates, { onConflict: 'asin,date' });
    if (upErr) console.warn(`[Refunds] upsert daily_metrics ${date}:`, upErr.message);
    else console.log(`[Refunds] ${date}: refund totals on ${updates.length} ASIN rows`);
  }
}

module.exports = { syncRefunds, recomputeRefundAggregates };
