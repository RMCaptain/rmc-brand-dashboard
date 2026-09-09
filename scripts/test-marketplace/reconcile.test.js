'use strict';
const assert = require('assert');
const R = require(require('path').resolve(__dirname, '..', '..') + '/sync/reconcileSellerboard.js');
const { pstDateStr, pstSubtractDays } = require(require('path').resolve(__dirname, '..', '..') + '/sync/dateUtils.js');

const CA = 'A2EUQ1WTGCTBG2', US = 'ATVPDKIKX0DER';

// tolerance / compare
assert.strictEqual(R.tolerance('sales', 100, 100), 25);
assert.strictEqual(R.tolerance('sales', 10000, 9900), 100);
assert.strictEqual(R.tolerance('units', 50, 50), 2);
assert.strictEqual(R.tolerance('units', 1000, 990), 10);
assert.strictEqual(R.compare('sales', 0, 0), null);
assert.strictEqual(R.compare('sales', null, 0), null);
assert.strictEqual(R.compare('sales', 4870, 4863.86).status, 'match');
assert.strictEqual(R.compare('sales', 4900, 4863.86).status, 'match'); // $36 delta < 1% ($49)
assert.strictEqual(R.compare('sales', 4920, 4863.86).status, 'flag');  // $56 delta > 1%
assert.strictEqual(R.compare('units', 181, 179).status, 'match');
assert.strictEqual(R.compare('units', 182, 179).status, 'flag');
assert.strictEqual(R.compare('units', 0, 179).status, 'sb_only');
assert.strictEqual(R.compare('units', 179, null).status, 'amz_only');
assert.strictEqual(R.compare('sales', 110, 100).delta_pct, 10);

// reconcileRows end-to-end on synthetic data
const y = pstSubtractDays(pstDateStr(), 1);
const d = n => pstSubtractDays(y, n);
const asinBrand = { A1: 'acure', A2: 'acure', Z1: 'zellies' };
const sbRows = [
  // yesterday CA: acure A1 (two SKUs) + zellies Z1
  { date: y, mp_id: CA, asin: 'A1', units: 10, sales: 200, ad_spend: 10, refunds: 1, refund_amount: 20, amazon_fees: 60, sessions: 100 },
  { date: y, mp_id: CA, asin: 'A1', units: 5,  sales: 100, ad_spend: 0,  refunds: 0, refund_amount: 0,  amazon_fees: 30, sessions: 50 },
  { date: y, mp_id: CA, asin: 'Z1', units: 20, sales: 600, ad_spend: 40, refunds: 0, refund_amount: 0,  amazon_fees: 180, sessions: 300 },
  // yesterday US: only Sellerboard has it
  { date: y, mp_id: US, asin: 'A2', units: 3, sales: 90, ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 27, sessions: null },
  // 8 days ago: outside the ASIN window, inside the 30d window
  { date: d(8), mp_id: CA, asin: 'A1', units: 10, sales: 200, ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 60, sessions: 80 },
  // 40 days ago: outside everything
  { date: d(40), mp_id: CA, asin: 'A1', units: 999, sales: 99999, ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 0, sessions: 0 },
];
const mpRows = [
  { date: y, mp_id: CA, asin: 'A1', units: 15, revenue: 300, ad_spend: 10, refunded_units: 1, refund_amount: 20 },   // exact match
  { date: y, mp_id: CA, asin: 'Z1', units: 24, revenue: 700, ad_spend: 40, refunded_units: 0, refund_amount: 0 },    // units +4 flag, sales +100 flag
  { date: d(8), mp_id: CA, asin: 'A1', units: 10, revenue: 210, ad_spend: 0, refunded_units: 0, refund_amount: 0 }, // sales +10 within $25
];
const feeAsinRows = [
  { date: y, mp_id: CA, asin: 'A1', fees: 90 },
  { date: y, mp_id: CA, asin: 'Z1', fees: 150 },       // -30 vs 180 → flag (tol 25)
  { date: y, mp_id: CA, asin: 'sku:ORPHAN', fees: 5 }, // ignored
];
const feeMpRows = [{ date: y, mp_id: CA, fees: 245 }]; // account 245 vs SB 270 → -25 → match at boundary (not > tol)
const wideRows = [
  { date: y, asin: 'A1', sessions: 150 },
  { date: y, asin: 'Z1', sessions: 310 },
  { date: y, asin: 'A2', sessions: 40 },
];

const { rows } = R.reconcileRows({ sbRows, mpRows, feeAsinRows, feeMpRows, wideRows, asinBrand, yesterday: y, days: 30 });
const find = (scope, scopeId, mp, metric, date = y) => rows.find(r => r.scope === scope && r.scope_id === scopeId && r.mp_id === mp && r.metric === metric && r.date === date);

// account CA yesterday
assert.strictEqual(find('account', '*', CA, 'units').amazon_value, 39);
assert.strictEqual(find('account', '*', CA, 'units').sellerboard_value, 35);
assert.strictEqual(find('account', '*', CA, 'units').status, 'flag');
assert.strictEqual(find('account', '*', CA, 'sales').status, 'flag');       // 1000 vs 900
assert.strictEqual(find('account', '*', CA, 'ad_spend').status, 'match');   // 50 vs 50
assert.strictEqual(find('account', '*', CA, 'amazon_fees').status, 'match'); // 245 vs 270, delta -25 not > 25
assert.strictEqual(find('account', '*', CA, 'refunds').status, 'match');
// account US: Amazon has nothing
assert.strictEqual(find('account', '*', US, 'sales').status, 'sb_only');
assert.strictEqual(find('account', '*', US, 'units').status, 'sb_only');
// sessions live under mp '*'
assert.strictEqual(find('account', '*', '*', 'sessions').amazon_value, 500);
assert.strictEqual(find('account', '*', '*', 'sessions').sellerboard_value, 450);
assert.strictEqual(find('account', '*', '*', 'sessions').status, 'flag');   // 50 > max(2, 5)
assert.strictEqual(find('brand', 'acure', '*', 'sessions').amazon_value, 190);
// brand rows
assert.strictEqual(find('brand', 'acure', CA, 'sales').status, 'match');
assert.strictEqual(find('brand', 'zellies', CA, 'units').status, 'flag');
assert.strictEqual(find('brand', 'zellies', CA, 'amazon_fees').status, 'flag');
assert.strictEqual(find('brand', 'acure', US, 'sales').status, 'sb_only');
// asin rows: only non-match, only trailing 7 days
assert.strictEqual(find('asin', 'A1', CA, 'sales'), undefined);            // matched → not stored
assert.strictEqual(find('asin', 'Z1', CA, 'sales').status, 'flag');
assert.strictEqual(find('asin', 'A2', US, 'sales').status, 'sb_only');
assert.strictEqual(find('asin', 'A1', CA, 'sales', d(8)), undefined);      // outside ASIN window
assert.strictEqual(find('account', '*', CA, 'sales', d(8)).status, 'match'); // 210 vs 200 within $25
assert.strictEqual(find('account', '*', CA, 'sales', d(40)), undefined);   // outside 30d window
// 7d account scope keyed on yesterday
const s7 = find('account_7d', '*', CA, 'sales');
assert.strictEqual(s7.amazon_value, 1000);
assert.strictEqual(s7.sellerboard_value, 900);
assert.strictEqual(s7.status, 'flag');
assert.strictEqual(find('account_7d', '*', US, 'sales').status, 'sb_only');
assert.strictEqual(find('account_7d', '*', '*', 'sessions').amazon_value, 500);

const sum = R.summarize(rows, y);
assert.ok(sum.flags7d.length >= 2, 'flags7d: ' + JSON.stringify(sum.flags7d));
assert.ok(sum.flags7d[0].includes('Amazon') && sum.flags7d[0].includes('Sellerboard'));
console.log(sum.flags7d.join('\n'));
console.log('rows', rows.length, 'counts', JSON.stringify(sum.counts));
console.log('all reconcile checks passed');
