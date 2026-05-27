/**
 * Intraday Orders Poller
 * Polls SP-API Orders API to maintain a live "today" view (~15 min lag).
 * Tracks units + revenue only. Sessions / buybox / ads remain 24hr lag via S&T.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, getMarketplaceIds, sleep } = require('./amazon');

const ENABLED = process.env.SYNC_ENABLED === 'true';

let state = {
  date: null,
  updatedAt: null,
  byAsin: {},           // { asin: { units, unitsCa, unitsUs, revenueCad, revenueUsd } }
  seenOrderIds: new Set()
};

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function resetIfNewDay() {
  const today = todayStr();
  if (state.date !== today) {
    console.log(`[Orders] New day (${today}) — resetting intraday state`);
    state = { date: today, updatedAt: null, byAsin: {}, seenOrderIds: new Set() };
  }
}

async function fetchOrderItems(token, orderId) {
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`, token);
  if (res.status !== 200) return [];
  return res.body?.payload?.OrderItems || [];
}

async function processOrders(orders, token, mpId) {
  const isCA = mpId === 'A2EUQ1WTGCTBG2';

  for (const order of orders) {
    if (state.seenOrderIds.has(order.AmazonOrderId)) continue;
    state.seenOrderIds.add(order.AmazonOrderId);

    // Order items: burst 30, restore 2/sec — 550ms keeps us well under the limit
    await sleep(550);

    const items = await fetchOrderItems(token, order.AmazonOrderId);
    for (const item of items) {
      const asin = item.ASIN;
      if (!asin) continue;
      const units   = item.QuantityOrdered || 0;
      const revenue = parseFloat(item.ItemPrice?.Amount || 0);

      if (!state.byAsin[asin]) {
        state.byAsin[asin] = { units: 0, unitsCa: 0, unitsUs: 0, revenueCad: 0, revenueUsd: 0 };
      }
      state.byAsin[asin].units += units;
      if (isCA) { state.byAsin[asin].unitsCa += units; state.byAsin[asin].revenueCad += revenue; }
      else      { state.byAsin[asin].unitsUs += units; state.byAsin[asin].revenueUsd += revenue; }
    }
  }
}

async function fetchAndProcess(token, params, mpId) {
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

    await processOrders(orders, token, mpId);

    // /orders endpoint: burst 6, restore 1/min — conservative gap between pages
    if (nextToken) await sleep(3000);
  } while (nextToken);

  return totalOrders;
}

// Full rebuild — wipes state and re-fetches all orders created today.
// Called on startup and when the date rolls over.
async function rebuildToday() {
  if (!ENABLED) return;
  resetIfNewDay();
  state.byAsin = {};
  state.seenOrderIds = new Set();

  console.log(`[Orders] Full rebuild for ${state.date}...`);
  const token          = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const todayStart     = state.date + 'T00:00:00Z';
  let total = 0;

  for (const mpId of marketplaceIds) {
    const n = await fetchAndProcess(token, {
      MarketplaceIds: mpId,
      CreatedAfter:   todayStart,
      OrderStatuses:  'Unshipped,PartiallyShipped,Shipped'
    }, mpId);
    total += n;
    await sleep(2000);
  }

  state.updatedAt = new Date().toISOString();
  console.log(`[Orders] Rebuild done: ${Object.keys(state.byAsin).length} ASINs, ${total} orders`);
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
      OrderStatuses:     'Unshipped,PartiallyShipped,Shipped'
    }, mpId);
    await sleep(2000);
  }

  state.updatedAt = new Date().toISOString();
  console.log(`[Orders] Poll done: ${Object.keys(state.byAsin).length} ASINs tracked for today`);
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

module.exports = { rebuildToday, poll, getState };
