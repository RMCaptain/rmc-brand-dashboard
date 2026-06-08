#!/usr/bin/env node
/**
 * Diagnostic: for a given PST date, tally orders / units / revenue grouped by
 * OrderStatus, per marketplace. Reveals exactly which status filter matches
 * Sellerboard. Usage: node scripts/inspect-status-breakdown.js 2026-06-07
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, getMarketplaceIds, sleep } = require('../sync/amazon');
const { pstMidnightAsUTC, pstSubtractDays, pstDateStr } = require('../sync/dateUtils');

const DATE = process.argv[2] || pstSubtractDays(pstDateStr(), 1);

async function fetchItems(token, orderId, attempt = 0) {
  const res = await spRequest('GET', `/orders/v0/orders/${orderId}/orderItems`, token);
  if (res.status === 429 && attempt < 4) { await sleep(2000 * (attempt + 1)); return fetchItems(token, orderId, attempt + 1); }
  if (res.status !== 200) return [];
  return res.body?.payload?.OrderItems || [];
}

(async () => {
  const token  = await getAccessToken();
  const after  = pstMidnightAsUTC(DATE);
  const before = pstMidnightAsUTC(pstSubtractDays(DATE, -1));
  console.log(`Date ${DATE} (PST)  ${after} -> ${before}\n`);

  const byStatus = {}; // status -> { orders, units, revCad, revUsd, zeroRevUnits }

  for (const mpId of getMarketplaceIds()) {
    const isCA = mpId === 'A2EUQ1WTGCTBG2';
    let nextToken = null;
    do {
      const query = nextToken ? { NextToken: nextToken } : { MarketplaceIds: mpId, CreatedAfter: after, CreatedBefore: before };
      const res = await spRequest('GET', `/orders/v0/orders?${new URLSearchParams(query)}`, token);
      if (res.status === 429) { await sleep(65000); continue; }
      if (res.status !== 200) { console.warn('orders status', res.status); break; }
      const orders = res.body?.payload?.Orders || [];
      nextToken = res.body?.payload?.NextToken;

      for (const o of orders) {
        const st = o.OrderStatus;
        if (!byStatus[st]) byStatus[st] = { orders: 0, units: 0, revCad: 0, revUsd: 0, zeroRevUnits: 0 };
        byStatus[st].orders++;
        await sleep(550);
        const items = await fetchItems(token, o.AmazonOrderId);
        for (const it of items) {
          const q = it.QuantityOrdered || 0;
          const rev = parseFloat(it.ItemPrice?.Amount || 0);
          byStatus[st].units += q;
          if (isCA) byStatus[st].revCad += rev; else byStatus[st].revUsd += rev;
          if (q > 0 && rev === 0) byStatus[st].zeroRevUnits += q;
        }
      }
      if (nextToken) await sleep(3000);
    } while (nextToken);
  }

  console.log('status            orders  units   revCAD   revUSD   zeroRevUnits');
  let tOrders=0,tUnits=0,tCad=0,tUsd=0;
  for (const st of Object.keys(byStatus).sort()) {
    const x = byStatus[st];
    tOrders+=x.orders; tUnits+=x.units; tCad+=x.revCad; tUsd+=x.revUsd;
    console.log(st.padEnd(18), String(x.orders).padStart(5), String(x.units).padStart(6), x.revCad.toFixed(0).padStart(8), x.revUsd.toFixed(0).padStart(8), String(x.zeroRevUnits).padStart(9));
  }
  console.log('-'.repeat(64));
  console.log('TOTAL'.padEnd(18), String(tOrders).padStart(5), String(tUnits).padStart(6), tCad.toFixed(0).padStart(8), tUsd.toFixed(0).padStart(8));
  console.log('\nExcluding Pending:');
  let eO=0,eU=0,eCad=0,eUsd=0;
  for (const st of Object.keys(byStatus)) { if (st==='Pending') continue; const x=byStatus[st]; eO+=x.orders;eU+=x.units;eCad+=x.revCad;eUsd+=x.revUsd; }
  console.log(`  orders ${eO} | units ${eU} | revCAD ${eCad.toFixed(0)} | revUSD ${eUsd.toFixed(0)}`);
})().catch(e => console.error('Fatal:', e.message));
