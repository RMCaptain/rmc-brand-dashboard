/**
 * Refund attribution — pulls SP-API Financial Events RefundEventList,
 * resolves each refund's original order date (via getOrder) + ASIN
 * (via getOrderItems), then idempotently writes per-event rows to
 * refund_events and rolls up totals into daily_metrics' refund_* columns.
 *
 * Attribution model (decided 2026-06):
 *   - refund is counted against the ORIGINAL order's date, not the
 *     refund posting date
 *   - "1 unit refunded" = 1 unit at the ASIN row (no multipack expansion)
 *   - unmapped SKUs → unknown-brand
 *
 * Idempotency: every refund event has a stable event_id (AmazonOrderId +
 * OrderAdjustmentItemId). We skip events already in refund_events, so re-runs
 * over an overlapping window never double-count.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, sleep } = require('./amazon');
const { pstDateStr, pstSubtractDays } = require('./dateUtils');

const LA_TZ = 'America/Los_Angeles';

function utcToPstDate(utcIso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: LA_TZ }).format(new Date(utcIso));
}

// In-process caches so we never re-fetch the same order during one pull
function makeOrderCache() {
  const orderMeta  = {}; // orderId → { purchaseDate, currency }
  const orderItems = {}; // orderId → { sellerSku → asin }
  return { orderMeta, orderItems };
}

async function fetchOrderMeta(orderId, token, cache) {
  if (cache.orderMeta[orderId]) return cache.orderMeta[orderId];
  // Pace: getOrder is 0.5 req/sec burst 30. 600ms between safely under.
  await sleep(600);
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}`, token);
  if (res.status !== 200) {
    console.warn(`[Refunds] getOrder ${orderId} → ${res.status}`);
    cache.orderMeta[orderId] = null;
    return null;
  }
  const order = res.body?.payload || {};
  const purchaseDate = order.PurchaseDate ? utcToPstDate(order.PurchaseDate) : null;
  const currency     = order.OrderTotal?.CurrencyCode || null;
  cache.orderMeta[orderId] = { purchaseDate, currency };
  return cache.orderMeta[orderId];
}

async function fetchOrderItemsMap(orderId, token, cache) {
  if (cache.orderItems[orderId]) return cache.orderItems[orderId];
  // Same throttle as the live poller: 550ms between item fetches
  await sleep(550);
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`, token);
  if (res.status !== 200) {
    console.warn(`[Refunds] getOrderItems ${orderId} → ${res.status}`);
    cache.orderItems[orderId] = {};
    return {};
  }
  const map = {};
  for (const item of (res.body?.payload?.OrderItems || [])) {
    if (item.SellerSKU && item.ASIN) map[item.SellerSKU] = item.ASIN;
  }
  cache.orderItems[orderId] = map;
  return map;
}

// Pull raw RefundEventList items posted in [from, to] (ISO strings).
// Returns an array of normalized line items, one per refunded SKU.
async function pullRefundEvents(from, to, token) {
  const events = [];
  let nextToken = null;
  let page = 0;
  do {
    const path = nextToken
      ? `/finances/v0/financialEvents?NextToken=${encodeURIComponent(nextToken)}&MaxResultsPerPage=100`
      : `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(from)}&PostedBefore=${encodeURIComponent(to)}&MaxResultsPerPage=100`;
    let res;
    try {
      res = await spRequest('GET', path, token, null, 90000);
    } catch (e) { console.warn(`[Refunds] events page ${page} failed: ${e.message}`); break; }
    if (res.status === 429) { await sleep(60000); continue; }
    if (res.status !== 200) { console.warn(`[Refunds] events HTTP ${res.status}`); break; }

    const fe = res.body?.payload?.FinancialEvents || {};
    for (const refund of (fe.RefundEventList || [])) {
      const orderId  = refund.AmazonOrderId;
      const postedAt = refund.PostedDate;
      if (!orderId || !postedAt) continue;

      for (const adj of (refund.ShipmentItemAdjustmentList || [])) {
        const adjId   = adj.OrderAdjustmentItemId || adj.SellerSKU || 'na';
        const eventId = `${orderId}::${adjId}::${postedAt}`;
        const sku     = adj.SellerSKU || null;
        const qty     = Math.abs(adj.QuantityShipped || adj.QuantityRefunded || 0);

        let principal = 0, currency = null;
        for (const charge of (adj.ItemChargeAdjustmentList || [])) {
          if (charge.ChargeType === 'Principal') {
            const amt = Math.abs(charge.ChargeAmount?.CurrencyAmount || 0);
            principal += amt;
            currency = currency || charge.ChargeAmount?.CurrencyCode;
          }
        }
        if (principal === 0 && qty === 0) continue;

        events.push({ eventId, orderId, postedAt, sku, qty, principal, currency });
      }
    }
    nextToken = fe.NextToken;
    page++;
    if (nextToken) await sleep(2000);
  } while (nextToken);
  console.log(`[Refunds] Pulled ${events.length} refund line items across ${page} pages`);
  return events;
}

// Main entry — pulls refund events posted in the last `windowDays`, looks up
// original-order dates + ASINs, persists to refund_events, then recomputes
// per-(asin,date) refund totals on daily_metrics for the affected dates.
async function syncRefunds(supabase, brands, { windowDays = 60 } = {}) {
  const token = await getAccessToken();
  const cache = makeOrderCache();

  // Build ASIN→brand map for unknown fallback
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  // Fetch events posted in the window
  const toIso   = new Date().toISOString();
  const fromIso = new Date(Date.now() - windowDays * 86400000).toISOString();
  const events  = await pullRefundEvents(fromIso, toIso, token);
  if (events.length === 0) {
    console.log('[Refunds] No events returned — preserving existing data, exiting');
    return { processed: 0, written: 0 };
  }

  // Skip events already in refund_events (idempotency)
  const ids = events.map(e => e.eventId);
  const existing = new Set();
  // Supabase IN clause has limits; chunk
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const { data } = await supabase.from('refund_events').select('event_id').in('event_id', chunk);
    for (const r of (data || [])) existing.add(r.event_id);
  }
  const fresh = events.filter(e => !existing.has(e.eventId));
  console.log(`[Refunds] ${events.length} total, ${fresh.length} new, ${existing.size} already processed`);

  if (fresh.length === 0) return { processed: events.length, written: 0 };

  // Resolve original order date + ASIN per fresh event
  const enriched = [];
  for (const e of fresh) {
    const meta = await fetchOrderMeta(e.orderId, token, cache);
    if (!meta?.purchaseDate) { console.warn(`[Refunds] No purchase date for ${e.orderId} — skipping`); continue; }
    let asin = null;
    if (e.sku) {
      const skuMap = await fetchOrderItemsMap(e.orderId, token, cache);
      asin = skuMap[e.sku] || null;
    }
    enriched.push({
      event_id: e.eventId,
      amazon_order_id: e.orderId,
      posted_at: e.postedAt,
      original_order_date: meta.purchaseDate,
      asin,
      marketplace_currency: e.currency || meta.currency || 'CAD',
      refunded_units: e.qty,
      refund_amount: e.principal,
    });
  }

  // Insert into refund_events (idempotent via PK)
  let inserted = 0;
  for (let i = 0; i < enriched.length; i += 100) {
    const chunk = enriched.slice(i, i + 100);
    const { error } = await supabase.from('refund_events').upsert(chunk, { onConflict: 'event_id' });
    if (error) console.warn('[Refunds] upsert refund_events:', error.message);
    else inserted += chunk.length;
  }
  console.log(`[Refunds] Wrote ${inserted} refund_events rows`);

  // Recompute aggregate refund columns for every affected (asin, date)
  const affectedDates = [...new Set(enriched.map(e => e.original_order_date))];
  await recomputeRefundAggregates(supabase, asinBrand, affectedDates);

  return { processed: events.length, written: inserted, datesTouched: affectedDates.length };
}

// For each (asin, date) in the affected dates, sum refund_events rows and
// write back to daily_metrics refund_* columns. Uses upsert so missing
// (asin, date) rows get created with sensible defaults.
async function recomputeRefundAggregates(supabase, asinBrand, dates) {
  for (const date of dates) {
    const { data: rows, error } = await supabase
      .from('refund_events')
      .select('asin,marketplace_currency,refunded_units,refund_amount')
      .eq('original_order_date', date);
    if (error) { console.warn(`[Refunds] read events for ${date}:`, error.message); continue; }

    const byAsin = {}; // asin → { units, cad, usd, count }
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

module.exports = { syncRefunds, pullRefundEvents, recomputeRefundAggregates };
