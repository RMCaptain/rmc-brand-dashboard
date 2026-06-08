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
  seenOrderIds: new Set()
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
    state = { date: today, updatedAt: null, byAsin: {}, seenOrderIds: new Set() };
  }
}

async function fetchOrderItems(token, orderId, attempt = 0) {
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`, token);
  if (res.status === 429) {
    if (attempt < 4) {
      await sleep(2000 * (attempt + 1));
      return fetchOrderItems(token, orderId, attempt + 1);
    }
    console.warn(`[Orders] fetchOrderItems rate-limited on ${orderId} after retries`);
    return [];
  }
  if (res.status !== 200) return [];
  return res.body?.payload?.OrderItems || [];
}

// target = { byAsin: {}, seenOrderIds: Set } — writes into the provided object
async function processOrders(orders, token, mpId, target) {
  const isCA = mpId === 'A2EUQ1WTGCTBG2';

  for (const order of orders) {
    if (target.seenOrderIds.has(order.AmazonOrderId)) continue;
    target.seenOrderIds.add(order.AmazonOrderId);

    // Order items: burst 30, restore 2/sec — 550ms keeps us well under the limit
    await sleep(550);

    const items = await fetchOrderItems(token, order.AmazonOrderId);
    for (const item of items) {
      const asin = item.ASIN;
      if (!asin) continue;
      const units   = item.QuantityOrdered || 0;
      const revenue = parseFloat(item.ItemPrice?.Amount || 0);

      if (!target.byAsin[asin]) {
        target.byAsin[asin] = { units: 0, unitsCa: 0, unitsUs: 0, revenueCad: 0, revenueUsd: 0 };
      }
      target.byAsin[asin].units += units;
      if (isCA) { target.byAsin[asin].unitsCa += units; target.byAsin[asin].revenueCad += revenue; }
      else      { target.byAsin[asin].unitsUs += units; target.byAsin[asin].revenueUsd += revenue; }
    }
  }
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
    await sleep(2000);
  }

  state.updatedAt = new Date().toISOString();
  console.log(`[Orders] Rebuild done: ${Object.keys(state.byAsin).length} ASINs, ${total} orders`);
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
  const target = { byAsin: {}, seenOrderIds: new Set() };
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

  state.updatedAt = new Date().toISOString();
  console.log(`[Orders] Poll done: ${Object.keys(state.byAsin).length} ASINs tracked for today`);
}

// Compute units/revenue for a single PST calendar day straight from the Orders
// API, across all marketplaces. This is the AUTHORITATIVE source for
// daily_metrics units/revenue (matches Sellerboard). Used by the historical
// rebuild script and the nightly yesterday-finalize. Not gated on ENABLED —
// it's a pure, explicitly-invoked computation.
async function computeDayFromOrders(pstDate, token = null) {
  token = token || await getAccessToken();
  const target   = { byAsin: {}, seenOrderIds: new Set() };
  const dayStart = pstMidnightAsUTC(pstDate);
  const dayEnd   = pstMidnightAsUTC(pstSubtractDays(pstDate, -1)); // next PST midnight
  let total = 0;

  for (const mpId of getMarketplaceIds()) {
    const n = await fetchAndProcess(token, {
      MarketplaceIds: mpId,
      CreatedAfter:   dayStart,
      CreatedBefore:  dayEnd,
      OrderStatuses:  'Pending,Unshipped,PartiallyShipped,Shipped'
    }, mpId, target);
    total += n;
    await sleep(2000);
  }

  return { date: pstDate, byAsin: target.byAsin, orderCount: total };
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

function getYesterdayState() {
  return {
    date:      yesterdayState.date,
    byAsin:    yesterdayState.byAsin,
    asinCount: Object.keys(yesterdayState.byAsin).length
  };
}

module.exports = { rebuildToday, rebuildYesterday, poll, getState, getYesterdayState, computeDayFromOrders };
