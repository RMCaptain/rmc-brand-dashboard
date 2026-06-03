#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, getMarketplaceIds, sleep } = require('../sync/amazon');
const { pstMidnightAsUTC, pstSubtractDays, pstDateStr } = require('../sync/dateUtils');

(async () => {
  const token = await getAccessToken();
  const yest  = pstSubtractDays(pstDateStr(), 1);
  const after  = pstMidnightAsUTC(yest);
  const before = pstMidnightAsUTC(pstDateStr());

  for (const mpId of getMarketplaceIds()) {
    console.log(`\n--- Marketplace ${mpId} ---`);
    const statusCounts = {};
    let nextToken = null;
    let pageNum = 0;
    do {
      const query = nextToken ? { NextToken: nextToken } : { MarketplaceIds: mpId, CreatedAfter: after, CreatedBefore: before };
      const qs = new URLSearchParams(query).toString();
      const res = await spRequest('GET', `/orders/v0/orders?${qs}`, token);
      if (res.status !== 200) { console.warn('Status', res.status); break; }
      pageNum++;
      const orders = res.body?.payload?.Orders || [];
      for (const o of orders) statusCounts[o.OrderStatus] = (statusCounts[o.OrderStatus] || 0) + 1;
      nextToken = res.body?.payload?.NextToken;
      console.log(`page ${pageNum}: ${orders.length} orders, statuses so far:`, statusCounts);
      if (nextToken) await sleep(3000);
    } while (nextToken);
  }
})().catch(e => console.error('Fatal:', e.message));
