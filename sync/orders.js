/**
 * Intraday Orders Poller
 * Polls SP-API Orders API to maintain live "today" and "yesterday" views (~15 min lag).
 * Tracks units + revenue only. Sessions / buybox / ads remain on S&T report schedule.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, getMarketplaceIds, sleep } = require('./amazon');
const { pstDateStr, pstSubtractDays, pstMidnightAsUTC } = require('./dateUtils');

const ENABLED = process.env.SYNC_ENABLED === 'true';

let state = {
  date: null,
  updatedAt: null,
  byAsin: {},
  seenOrderIds: new Set(),
  failedOrderIds: new Set(),
  orderContrib: {},
};

// Preserved when the day rolls over, and rebuilt on startup
let yesterdayState = {
  date: null,
  byAsin: {}
};

function todayStr()     { return pstDateStr(); }
function yesterdayStr() { return pstSubtractDays(pstDateStr(), 1); }

function resetIfNewDay() {
  const today = todayStr();
  if (state.date !== today) {
    // Carry finalized today data to yesterdayState before wiping
    if (state.date && Object.keys(state.byAsin).length > 0) {
      yesterdayState = { date: state.date, byAsin: state.byAsin };
      console.log(`[Orders] Carried ${state.date} → yesterdayState (${Object.keys(state.byAsin).length} ASINs)`);
    }
    console.log(`[Orders] New day (${today}) — resetting intraday state`);
    state = { date: today, updatedAt: null, byAsin: {}, seenOrderIds: new Set(), failedOrderIds: new Set(), orderContrib: {}, skuQueue: new Map(), skuTried: new Set(), estPrice: {} };
  }
}

// Returns the items array on success (may be empty), or null on retry-exhausted
// rate limit. Distinguishing null vs [] lets processOrders avoid marking
// rate-limited orders as "seen", so they get retried on the next 15-min poll
// instead of permanently losing that order's revenue.
async function fetchOrderItems(token, orderId, attempt = 0) {
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`, token);
  if (res.status === 429) {
    if (attempt < 4) {
      await sleep(2000 * (attempt + 1));
      return fetchOrderItems(token, orderId, attempt + 1);
    }
    console.warn(`[Orders] fetchOrderItems rate-limited on ${orderId} after retries — order left unmarked for retry`);
    return null;
  }
  if (res.status !== 200) return [];
  return res.body?.payload?.OrderItems || [];
}

// target = { byAsin: {}, seenOrderIds: Set, failedOrderIds: Set, orderContrib: {} }
//
// orderContrib tracks each order's current contribution to byAsin so we can
// CORRECTLY reconcile when the same order appears again (status change,
// price/qty edit, Pending→Shipped finalization). Without this, the 15-min
// incremental poll using LastUpdatedAfter sees updated orders but skips them
// via seenOrderIds — missing the change. With this, we subtract the prior
// contribution and apply the new one.
async function processOrders(orders, token, mpId, target) {
  const isCA = mpId === 'A2EUQ1WTGCTBG2';
  if (!target.failedOrderIds) target.failedOrderIds = new Set();
  if (!target.orderContrib)   target.orderContrib   = {};

  for (const order of orders) {
    const orderId = order.AmazonOrderId;

    // Order items: burst 30, restore 2/sec — 550ms keeps us well under the limit
    await sleep(550);

    const items = await fetchOrderItems(token, orderId);
    if (items === null) {
      // Rate-limit exhausted. Don't mark seen; remember for a retry pass.
      target.failedOrderIds.add(orderId);
      continue;
    }

    // Re-poll case: subtract this order's prior contribution before re-applying.
    if (target.seenOrderIds.has(orderId)) {
      reverseContribution(orderId, target);
    } else {
      target.seenOrderIds.add(orderId);
    }
    target.failedOrderIds.delete(orderId);

    // Apply the fresh contribution + record it for future reconciliation.
    applyOrderItems(items, orderId, isCA, target);
  }
}

// Subtract an order's previously-applied contribution from byAsin. Called
// before re-applying whenever an already-seen order shows up again.
function reverseContribution(orderId, target) {
  const prior = target.orderContrib[orderId];
  if (!prior) return;
  for (const [asin, c] of Object.entries(prior)) {
    if (!target.byAsin[asin]) continue;
    target.byAsin[asin].units -= c.units;
    if (c.isCA) { target.byAsin[asin].unitsCa -= c.units; target.byAsin[asin].revenueCad -= c.revenue; }
    else        { target.byAsin[asin].unitsUs -= c.units; target.byAsin[asin].revenueUsd -= c.revenue; }
    if (target.byAsin[asin].pricedCa != null) target.byAsin[asin].pricedCa -= (c.pricedCa || 0);
    if (target.byAsin[asin].pricedUs != null) target.byAsin[asin].pricedUs -= (c.pricedUs || 0);
  }
}

// Apply one order's items to target: units/revenue contributions, priced-unit
// bookkeeping, and the SKU queue for deferred pricing. Shared by the main
// pass and the rate-limit retry pass so both keep identical books.
//
// Pending orders: Amazon zeros per-item ItemPrice until the order ships. Those
// units land in byAsin with $0 revenue and the SellerSKU goes into skuQueue.
// The queue feeds a PRICE MAP only (resolveSkuPrices -> target.estPrice);
// nothing here or there ever writes estimated revenue into byAsin. Estimated
// revenue lives only in read-time derivations (estimateDay) — baking it into
// byAsin breaks reverse-and-reapply reconciliation, because the estimate isn't
// part of orderContrib and so survives the order's Pending->Shipped update as
// a double count.
function applyOrderItems(items, orderId, isCA, target) {
  if (!target.skuQueue) target.skuQueue = new Map(); // "CA|sku" / "US|sku" -> { asin, sku, isCA }

  const fresh = {};
  for (const item of items) {
    const asin = item.ASIN;
    const sku  = item.SellerSKU;
    if (!asin) continue;
    const units   = item.QuantityOrdered || 0;
    // A malformed Amount must degrade to "unpriced unit" (the estimation
    // ladder prices it), never to NaN — one NaN propagates into the day's
    // upsert payload as null and atomically fails the ENTIRE day's write.
    let revenue = parseFloat(item.ItemPrice?.Amount || 0);
    if (!Number.isFinite(revenue) || revenue < 0) revenue = 0;

    if (!target.byAsin[asin]) target.byAsin[asin] = { units: 0, unitsCa: 0, unitsUs: 0, revenueCad: 0, revenueUsd: 0 };
    const bucket = target.byAsin[asin];
    bucket.units += units;
    if (isCA) { bucket.unitsCa += units; bucket.revenueCad += revenue; }
    else      { bucket.unitsUs += units; bucket.revenueUsd += revenue; }
    bucket.pricedCa = bucket.pricedCa || 0;
    bucket.pricedUs = bucket.pricedUs || 0;
    if (revenue > 0) {
      if (isCA) bucket.pricedCa += units;
      else      bucket.pricedUs += units;
    } else if (units > 0 && sku) {
      target.skuQueue.set(`${isCA ? 'CA' : 'US'}|${sku}`, { asin, sku, isCA });
    }

    if (!fresh[asin]) fresh[asin] = { units: 0, revenue: 0, pricedCa: 0, pricedUs: 0, isCA };
    fresh[asin].units   += units;
    fresh[asin].revenue += revenue;
    if (revenue > 0) {
      if (isCA) fresh[asin].pricedCa += units;
      else      fresh[asin].pricedUs += units;
    }
  }
  target.orderContrib[orderId] = fresh;
}

// Retry orders that exhausted their initial fetchOrderItems retries. Quota
// typically restores within a few minutes; this pass with longer between-call
// sleeps recovers most drops. Used after computeDayFromOrders main pass.
async function retryFailedOrders(token, mpId, target) {
  if (!target.failedOrderIds || target.failedOrderIds.size === 0) return 0;

  const failedIds = [...target.failedOrderIds];
  console.log(`[Orders] Retrying ${failedIds.length} previously-failed orders for ${mpId} (extra-paced)...`);
  await sleep(30000); // let quota restore

  // Reconstruct minimal order objects so processOrders can run unchanged.
  // The only field it touches besides AmazonOrderId is mpId (currency context).
  const fakeOrders = failedIds.map(id => ({ AmazonOrderId: id }));
  target.failedOrderIds = new Set(); // reset; processOrders will re-add if still failing

  const isCA = mpId === 'A2EUQ1WTGCTBG2';
  if (!target.orderContrib) target.orderContrib = {};
  let recovered = 0;
  for (const order of fakeOrders) {
    await sleep(1500); // 3× normal pace
    const items = await fetchOrderItems(token, order.AmazonOrderId);
    if (items === null || items.length === 0) {
      target.failedOrderIds.add(order.AmazonOrderId);
      continue;
    }
    // An order can land in the failed set on a RE-poll (seen earlier, then its
    // update fetch rate-limited) — reverse its prior contribution first, or a
    // recovered retry double-counts it.
    if (target.seenOrderIds.has(order.AmazonOrderId)) {
      reverseContribution(order.AmazonOrderId, target);
    } else {
      target.seenOrderIds.add(order.AmazonOrderId);
    }
    recovered++;
    // Same bookkeeping as the main pass — recovered orders previously skipped
    // priced-unit tracking and the SKU queue, so their Pending units could
    // never be estimated AND triggered phantom extrapolation downstream.
    applyOrderItems(items, order.AmazonOrderId, isCA, target);
  }
  console.log(`[Orders] Retry pass recovered ${recovered}/${failedIds.length} previously-failed orders`);
  return recovered;
}

async function fetchAndProcess(token, params, mpId, target) {
  let nextToken = null;
  let totalOrders = 0;

  do {
    const query = nextToken ? { NextToken: nextToken } : params;
    const qs    = new URLSearchParams(query).toString();
    const res   = await spRequest('GET', `/orders/v0/orders?${qs}`, token);

    if (res.status === 429) {
      console.warn('[Orders] Rate limited — waiting 65s');
      await sleep(65000);
      continue;
    }
    if (res.status !== 200) {
      console.warn(`[Orders] Unexpected ${res.status}:`, JSON.stringify(res.body || {}).slice(0, 200));
      break;
    }

    const orders = res.body?.payload?.Orders || [];
    nextToken = res.body?.payload?.NextToken;
    totalOrders += orders.length;

    await processOrders(orders, token, mpId, target);

    // /orders endpoint: burst 6, restore 1/min — conservative gap between pages
    if (nextToken) await sleep(3000);
  } while (nextToken);

  return totalOrders;
}

// Full rebuild — wipes today state and re-fetches all orders created today.
async function rebuildToday() {
  if (!ENABLED) return;
  resetIfNewDay();
  state.byAsin = {};
  state.seenOrderIds = new Set();
  state.failedOrderIds = new Set();
  state.orderContrib = {};
  state.skuQueue = new Map();
  state.skuTried = new Set();
  state.estPrice = {};
  const failedByMp = {};

  console.log(`[Orders] Full rebuild for ${state.date}...`);
  const token          = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const todayStart     = pstMidnightAsUTC(state.date);
  let total = 0;

  for (const mpId of marketplaceIds) {
    const n = await fetchAndProcess(token, {
      MarketplaceIds: mpId,
      CreatedAfter:   todayStart,
      OrderStatuses:  'Pending,Unshipped,PartiallyShipped,Shipped'
    }, mpId, state);
    total += n;
    for (const id of state.failedOrderIds) if (!failedByMp[id]) failedByMp[id] = mpId;
    await sleep(2000);
  }

  // Retry pass — recover orders dropped to rate limits during the main pass.
  for (const mpId of marketplaceIds) {
    const ids = [...state.failedOrderIds].filter(id => failedByMp[id] === mpId);
    if (ids.length === 0) continue;
    const sub = { byAsin: state.byAsin, seenOrderIds: state.seenOrderIds, failedOrderIds: new Set(ids), orderContrib: state.orderContrib };
    await retryFailedOrders(token, mpId, sub);
    state.failedOrderIds = new Set([
      ...[...state.failedOrderIds].filter(id => failedByMp[id] !== mpId),
      ...sub.failedOrderIds,
    ]);
  }

  // Look up listing prices for Pending-order SKUs (feeds read-time estimation)
  await resolveSkuPrices(state, token);

  state.updatedAt = new Date().toISOString();
  const unrec = state.failedOrderIds.size;
  console.log(`[Orders] Rebuild done: ${Object.keys(state.byAsin).length} ASINs, ${total} orders${unrec ? `, ${unrec} unrecoverable` : ''}`);
}

// Rebuild yesterday state — used on startup when in-memory state was wiped.
// Skipped if carry-over already populated it from a live day rollover.
async function rebuildYesterday() {
  if (!ENABLED) return;
  const yest = yesterdayStr();

  if (yesterdayState.date === yest && Object.keys(yesterdayState.byAsin).length > 0) {
    console.log(`[Orders] Yesterday (${yest}) already populated — ${Object.keys(yesterdayState.byAsin).length} ASINs`);
    return;
  }

  console.log(`[Orders] Rebuilding yesterday (${yest})...`);
  const target = { byAsin: {}, seenOrderIds: new Set(), failedOrderIds: new Set(), orderContrib: {} };
  const token  = await getAccessToken();
  let total = 0;

  for (const mpId of getMarketplaceIds()) {
    const n = await fetchAndProcess(token, {
      MarketplaceIds: mpId,
      CreatedAfter:   pstMidnightAsUTC(yest),
      CreatedBefore:  pstMidnightAsUTC(todayStr()),
      OrderStatuses:  'Pending,Unshipped,PartiallyShipped,Shipped'
    }, mpId, target);
    total += n;
    await sleep(2000);
  }

  yesterdayState = { date: yest, byAsin: target.byAsin };
  console.log(`[Orders] Yesterday rebuild done: ${Object.keys(target.byAsin).length} ASINs, ${total} orders`);
}

// Incremental poll — only orders updated since last poll (20-min overlap for safety).
async function poll() {
  if (!ENABLED) return;
  resetIfNewDay();

  if (!state.updatedAt) return rebuildToday();

  const token          = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const since          = new Date(Date.now() - 20 * 60 * 1000).toISOString();

  for (const mpId of marketplaceIds) {
    await fetchAndProcess(token, {
      MarketplaceIds:    mpId,
      LastUpdatedAfter:  since,
      OrderStatuses:     'Pending,Unshipped,PartiallyShipped,Shipped'
    }, mpId, state);
    await sleep(2000);
  }

  // Look up listing prices for any newly-queued Pending-order SKUs
  await resolveSkuPrices(state, token);

  state.updatedAt = new Date().toISOString();
  console.log(`[Orders] Poll done: ${Object.keys(state.byAsin).length} ASINs tracked for today`);
}

// Compute units/revenue for a single PST calendar day straight from the Orders
// API, across all marketplaces. This is the AUTHORITATIVE source for
// daily_metrics units/revenue (matches Sellerboard). Used by the historical
// rebuild script and the nightly yesterday-finalize. Not gated on ENABLED —
// it's a pure, explicitly-invoked computation.
//
// INCLUDES Pending: Sellerboard counts Pending in its tiles. Pending units
// have units populated but ItemPrice = $0 from the API; their revenue is
// estimated via the estimateDay ladder and returned as byAsinEstimated.
// Canceled excluded (legitimately not a sale).
async function computeDayFromOrders(pstDate, token = null) {
  token = token || await getAccessToken();
  const target   = { byAsin: {}, seenOrderIds: new Set(), failedOrderIds: new Set(), orderContrib: {}, failedByMp: {} };
  const dayStart = pstMidnightAsUTC(pstDate);
  // Next PST midnight — but the Orders API rejects timestamps within 2 minutes
  // of now (400 InvalidInput), so clamp when computing the current (partial) day.
  let dayEnd = pstMidnightAsUTC(pstSubtractDays(pstDate, -1));
  const apiCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  if (dayEnd > apiCutoff) dayEnd = apiCutoff;
  let total = 0;

  for (const mpId of getMarketplaceIds()) {
    const failedBefore = target.failedOrderIds.size;
    const n = await fetchAndProcess(token, {
      MarketplaceIds: mpId,
      CreatedAfter:   dayStart,
      CreatedBefore:  dayEnd,
      OrderStatuses:  'Pending,Unshipped,PartiallyShipped,Shipped'
    }, mpId, target);
    total += n;
    // Tag the failures from this marketplace so the retry pass picks the right currency context
    for (const id of target.failedOrderIds) {
      if (!target.failedByMp[id]) target.failedByMp[id] = mpId;
    }
    await sleep(2000);
  }

  // Retry pass: re-attempt any orders that exhausted their item-fetch retries.
  // Quota typically restores within ~30s; this slower-paced pass recovers most drops.
  for (const mpId of getMarketplaceIds()) {
    const idsForThisMp = [...target.failedOrderIds].filter(id => target.failedByMp[id] === mpId);
    if (idsForThisMp.length === 0) continue;
    const subTarget = { byAsin: target.byAsin, seenOrderIds: target.seenOrderIds, failedOrderIds: new Set(idsForThisMp), orderContrib: target.orderContrib };
    await retryFailedOrders(token, mpId, subTarget);
    // Carry forward any STILL-failed IDs after retry
    target.failedOrderIds = new Set([
      ...[...target.failedOrderIds].filter(id => target.failedByMp[id] !== mpId),
      ...subTarget.failedOrderIds,
    ]);
  }

  if (target.failedOrderIds.size > 0) {
    console.warn(`[Orders] computeDayFromOrders ${pstDate}: ${target.failedOrderIds.size} orders unrecoverable after retry pass`);
  }

  await resolveSkuPrices(target, token);

  // byAsinEstimated = byAsin with Pending-order revenue estimated via the
  // ladder in estimateDay. Writers should persist THIS; byAsin stays raw.
  // Trailing prices are best-effort — on failure the ladder just loses its
  // last rung (listing price + same-day average still apply).
  let trailing = {};
  try {
    trailing = await require('./priceCache').getTrailingPrices();
  } catch (e) {
    console.warn(`[Orders] trailing prices unavailable: ${e.message}`);
  }
  const est = estimateDay(target.byAsin, target.estPrice, trailing);
  if (est.meta.estUnits > 0 || est.meta.unresolvedUnits > 0) {
    console.log(`[Orders] ${pstDate}: estimated ${est.meta.estUnits} Pending units (CA$${est.meta.estRevenueCad} + US$${est.meta.estRevenueUsd})${est.meta.unresolvedUnits ? `, ${est.meta.unresolvedUnits} units unpriceable` : ''}`);
  }

  // orderContrib rides along so callers can derive per-brand order counts for
  // AOV. It's already built for reversal bookkeeping — returning it costs
  // nothing, and without it the order->ASIN mapping is unrecoverable once this
  // function returns (which is why AOV was impossible until now).
  return {
    date: pstDate,
    byAsin: target.byAsin,
    byAsinEstimated: est.byAsin,
    estimateMeta: est.meta,
    orderCount: total,
    orderContrib: target.orderContrib,
    unrecoveredOrders: target.failedOrderIds.size,
  };
}

/**
 * Distinct order counts per brand for one day, derived from orderContrib.
 *
 * Counts each order ONCE per brand it touches, however many of that brand's
 * ASINs it contains — summing per-ASIN counts would overstate any multi-item
 * order. An order spanning two brands counts for both, which is correct for a
 * per-brand report but means these must never be summed across brands.
 *
 * @param {object} orderContrib  { orderId: { asin: { units, revenue, isCA } } }
 * @param {object} asinBrand     { asin: brandId }
 * @returns {object} { brandId: { order_count, order_count_ca, order_count_us } }
 */
function brandOrderCounts(orderContrib, asinBrand) {
  const sets = {};
  for (const [orderId, contrib] of Object.entries(orderContrib || {})) {
    for (const [asin, c] of Object.entries(contrib || {})) {
      const brand = asinBrand[asin];
      if (!brand) continue;
      if (!sets[brand]) sets[brand] = { all: new Set(), ca: new Set(), us: new Set() };
      sets[brand].all.add(orderId);
      (c.isCA ? sets[brand].ca : sets[brand].us).add(orderId);
    }
  }
  const out = {};
  for (const [brand, s] of Object.entries(sets)) {
    out[brand] = { order_count: s.all.size, order_count_ca: s.ca.size, order_count_us: s.us.size };
  }
  return out;
}

// Look up our seller's live listing price for every queued Pending-order SKU
// and store it in target.estPrice[asin] = { ca, us }. NEVER mutates byAsin —
// see applyOrderItems for why baking estimates into byAsin double-counts.
// skuTried stops re-hammering SKUs the Pricing API can't resolve (typically:
// no active offer because the order took the last unit); state resets clear it.
async function resolveSkuPrices(target, token) {
  if (!target.skuQueue || target.skuQueue.size === 0) return 0;
  if (!target.estPrice) target.estPrice = {};
  if (!target.skuTried) target.skuTried = new Set();
  const { fetchListingPrices } = require('./amazon');

  const pending = [...target.skuQueue.entries()].filter(([key]) => !target.skuTried.has(key));
  if (pending.length === 0) return 0;
  const caSkus = [...new Set(pending.filter(([, q]) => q.isCA).map(([, q]) => q.sku))];
  const usSkus = [...new Set(pending.filter(([, q]) => !q.isCA).map(([, q]) => q.sku))];
  console.log(`[Orders] Listing-price lookup for ${caSkus.length} CA + ${usSkus.length} US Pending-order SKUs...`);

  const caPrices = caSkus.length > 0 ? await fetchListingPrices(caSkus, 'A2EUQ1WTGCTBG2', token, { byType: 'Sku' }) : {};
  const usPrices = usSkus.length > 0 ? await fetchListingPrices(usSkus, 'ATVPDKIKX0DER',   token, { byType: 'Sku' }) : {};

  let hits = 0;
  for (const [key, q] of pending) {
    target.skuTried.add(key);
    const p = q.isCA ? caPrices[q.sku] : usPrices[q.sku];
    if (!p?.amount) continue;
    if (!target.estPrice[q.asin]) target.estPrice[q.asin] = {};
    if (q.isCA) target.estPrice[q.asin].ca = p.amount;
    else        target.estPrice[q.asin].us = p.amount;
    hits++;
  }
  console.log(`[Orders] Listing-price lookup: ${hits}/${pending.length} SKUs priced (misses usually = no active offer, e.g. just sold out)`);
  return hits;
}

// Read-time revenue estimation for unpriced (Pending) units — the Sellerboard
// approach: estimate now at a known price, reconcile to actuals as orders ship.
// Raw byAsin stays exactly what the Orders API reported; this derives a copy
// with estimates layered on, so live-state reconciliation stays exact and an
// estimate can never double-count or leak into raw state.
//
// Price ladder per ASIN+marketplace, applied to (units - pricedUnits):
//   1. our live listing price for the exact SKU  (estPrice, resolveSkuPrices)
//   2. the day's own realized average for the ASIN (revenue / pricedUnits)
//   3. trailing 14-day realized average           (priceCache, finalized days)
// Units no rung can price keep $0 revenue but are counted in meta.unresolvedUnits
// so the UI can say so instead of silently understating.
function estimateDay(byAsin, estPrice = {}, trailing = {}) {
  const out  = {};
  const meta = { estUnits: 0, estRevenueCad: 0, estRevenueUsd: 0, unresolvedUnits: 0 };

  for (const [asin, d] of Object.entries(byAsin || {})) {
    const e = { ...d };
    const unpricedCa = Math.max(0, (d.unitsCa || 0) - (d.pricedCa || 0));
    const unpricedUs = Math.max(0, (d.unitsUs || 0) - (d.pricedUs || 0));

    if (unpricedCa > 0) {
      let price = estPrice[asin]?.ca ?? null;
      if (price == null && (d.pricedCa || 0) > 0 && (d.revenueCad || 0) > 0) price = d.revenueCad / d.pricedCa;
      if (price == null) price = trailing[asin]?.ca ?? null;
      if (!Number.isFinite(price) || price <= 0) price = null;
      if (price != null) {
        e.revenueCad = (d.revenueCad || 0) + price * unpricedCa;
        e.estUnitsCa = unpricedCa;
        meta.estUnits      += unpricedCa;
        meta.estRevenueCad += price * unpricedCa;
      } else {
        meta.unresolvedUnits += unpricedCa;
      }
    }

    if (unpricedUs > 0) {
      let price = estPrice[asin]?.us ?? null;
      if (price == null && (d.pricedUs || 0) > 0 && (d.revenueUsd || 0) > 0) price = d.revenueUsd / d.pricedUs;
      if (price == null) price = trailing[asin]?.us ?? null;
      if (!Number.isFinite(price) || price <= 0) price = null;
      if (price != null) {
        e.revenueUsd = (d.revenueUsd || 0) + price * unpricedUs;
        e.estUnitsUs = unpricedUs;
        meta.estUnits      += unpricedUs;
        meta.estRevenueUsd += price * unpricedUs;
      } else {
        meta.unresolvedUnits += unpricedUs;
      }
    }

    out[asin] = e;
  }

  meta.estRevenueCad = Math.round(meta.estRevenueCad * 100) / 100;
  meta.estRevenueUsd = Math.round(meta.estRevenueUsd * 100) / 100;
  return { byAsin: out, meta };
}

function getState() {
  resetIfNewDay();
  return {
    date:      state.date,
    updatedAt: state.updatedAt,
    byAsin:    state.byAsin,
    asinCount: Object.keys(state.byAsin).length
  };
}

// Estimated view of today's live state — what the today endpoint and the
// hourly persist should consume. Raw getState() remains for anything that
// needs exactly what the Orders API reported.
async function getEstimatedState() {
  resetIfNewDay();
  let trailing = {};
  try {
    trailing = await require('./priceCache').getTrailingPrices();
  } catch (e) {
    console.warn(`[Orders] trailing prices unavailable: ${e.message}`);
  }
  const est = estimateDay(state.byAsin, state.estPrice, trailing);
  return {
    date:         state.date,
    updatedAt:    state.updatedAt,
    byAsin:       est.byAsin,
    estimateMeta: est.meta,
    asinCount:    Object.keys(est.byAsin).length
  };
}

function getYesterdayState() {
  return {
    date:      yesterdayState.date,
    byAsin:    yesterdayState.byAsin,
    asinCount: Object.keys(yesterdayState.byAsin).length
  };
}

module.exports = { rebuildToday, rebuildYesterday, poll, getState, getYesterdayState, getEstimatedState, computeDayFromOrders, brandOrderCounts, estimateDay };
