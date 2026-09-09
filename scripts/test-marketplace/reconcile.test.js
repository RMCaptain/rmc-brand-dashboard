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
assert.strictEqual(R.tolerance('amazon_fees', 1000, 900), 100);    // lagged basis: 10%
assert.strictEqual(R.tolerance('refunds', 50, 45), 5);
assert.strictEqual(R.tolerance('refund_amount', 100, 100), 25);   // floor still applies
assert.strictEqual(R.compare('sales', 0, 0), null);
assert.strictEqual(R.compare('sales', null, 0), null);
assert.strictEqual(R.compare('sales', 4870, 4863.86).status, 'match');
assert.strictEqual(R.compare('sales', 4900, 4863.86).status, 'match'); // $36 delta < 1% ($49)
assert.strictEqual(R.compare('sales', 4920, 4863.86).status, 'flag');  // $56 delta > 1%
assert.strictEqual(R.compare('amazon_fees', 1367.86, 1500).status, 'match'); // -132 within 10% (150)
assert.strictEqual(R.compare('amazon_fees', 1300, 1500).status, 'flag');     // -200 > 10%
assert.strictEqual(R.compare('units', 181, 179).status, 'match');
assert.strictEqual(R.compare('units', 182, 179).status, 'flag');
assert.strictEqual(R.compare('units', 0, 179).status, 'sb_only');
assert.strictEqual(R.compare('units', 179, null).status, 'amz_only');
assert.strictEqual(R.compare('sales', 110, 100).delta_pct, 10);
assert.ok(!R.METRICS.includes('sessions'), 'sessions are not reconciled');

// reconcileRows end-to-end on synthetic data
const y = pstSubtractDays(pstDateStr(), 1);
const d = n => pstSubtractDays(y, n);
const asinBrand = { A1: 'acure', A2: 'acure', Z1: 'zellies' };
const sbRows = [
  // yesterday CA: acure A1 (two SKUs) + zellies Z1. ad_spend_sp is what the
  // Amazon side (SP-only) is compared against; fee_charges - storage_fees is the fee basis.
  { date: y, mp_id: CA, asin: 'A1', units: 10, sales: 200, ad_spend_sp: 10, refunds: 1, refund_amount: 20, fee_charges: 62, storage_fees: 2 },
  { date: y, mp_id: CA, asin: 'A1', units: 5,  sales: 100, ad_spend_sp: 0,  refunds: 0, refund_amount: 0,  fee_charges: 30, storage_fees: 0 },
  { date: y, mp_id: CA, asin: 'Z1', units: 20, sales: 600, ad_spend_sp: 40, refunds: 0, refund_amount: 0,  fee_charges: 180, storage_fees: 0 },
  // yesterday US: only Sellerboard has it
  { date: y, mp_id: US, asin: 'A2', units: 3, sales: 90, ad_spend_sp: 0, refunds: 0, refund_amount: 0, fee_charges: 27, storage_fees: 0 },
  // 8 days ago: outside the ASIN window, inside the 30d window
  { date: d(8), mp_id: CA, asin: 'A1', units: 10, sales: 200, ad_spend_sp: 0, refunds: 0, refund_amount: 0, fee_charges: 60, storage_fees: 0 },
  // 40 days ago: outside everything
  { date: d(40), mp_id: CA, asin: 'A1', units: 999, sales: 99999, ad_spend_sp: 0, refunds: 0, refund_amount: 0, fee_charges: 0, storage_fees: 0 },
];
const mpRows = [
  { date: y, mp_id: CA, asin: 'A1', units: 15, revenue: 300, ad_spend: 10 },   // exact match
  { date: y, mp_id: CA, asin: 'Z1', units: 24, revenue: 700, ad_spend: 40 },   // units +4 flag, sales +100 flag
  { date: d(8), mp_id: CA, asin: 'A1', units: 10, revenue: 210, ad_spend: 0 }, // sales +10 within $25
];
const feeAsinRows = [
  { date: y, mp_id: CA, asin: 'A1', fees: 95, refund_amount: 20, refund_count: 1, breakdown: { Storage: 5, 'Referral Fee': 90 } }, // 90 vs SB 90
  { date: y, mp_id: CA, asin: 'Z1', fees: 150, refund_amount: 0, refund_count: 0, breakdown: {} },   // 150 vs 180 → -30 → flag (tol max(25, 18))
  { date: y, mp_id: CA, asin: 'sku:ORPHAN', fees: 5, refund_amount: 0, refund_count: 0 },             // ignored
];
const feeMpRows = [{ date: y, mp_id: CA, fees: 250, refund_amount: 20, refund_count: 1, breakdown: { Storage: 5 } }]; // 245 vs SB 270 → -25 → match at boundary (tol 27)

const { rows } = R.reconcileRows({ sbRows, mpRows, feeAsinRows, feeMpRows, asinBrand, yesterday: y, days: 30 });
const find = (scope, scopeId, mp, metric, date = y) => rows.find(r => r.scope === scope && r.scope_id === scopeId && r.mp_id === mp && r.metric === metric && r.date === date);

// account CA yesterday
assert.strictEqual(find('account', '*', CA, 'units').amazon_value, 39);
assert.strictEqual(find('account', '*', CA, 'units').sellerboard_value, 35);
assert.strictEqual(find('account', '*', CA, 'units').status, 'flag');
assert.strictEqual(find('account', '*', CA, 'sales').status, 'flag');       // 1000 vs 900
assert.strictEqual(find('account', '*', CA, 'ad_spend').status, 'match');   // 50 vs 50
assert.strictEqual(find('account', '*', CA, 'amazon_fees').amazon_value, 245);
assert.strictEqual(find('account', '*', CA, 'amazon_fees').sellerboard_value, 270);
assert.strictEqual(find('account', '*', CA, 'amazon_fees').status, 'match'); // 245 vs 270, delta -25 not > 27
assert.strictEqual(find('account', '*', CA, 'refunds').amazon_value, 1);     // from daily_fees_mp, not daily_metrics_mp
assert.strictEqual(find('account', '*', CA, 'refunds').status, 'match');
assert.strictEqual(find('account', '*', CA, 'refund_amount').status, 'match');
// account US: Amazon has nothing
assert.strictEqual(find('account', '*', US, 'sales').status, 'sb_only');
assert.strictEqual(find('account', '*', US, 'units').status, 'sb_only');
// no sessions rows anywhere
assert.strictEqual(rows.find(r => r.metric === 'sessions'), undefined);
// brand rows
assert.strictEqual(find('brand', 'acure', CA, 'sales').status, 'match');
assert.strictEqual(find('brand', 'acure', CA, 'amazon_fees').amazon_value, 90);   // 95 - Storage 5
assert.strictEqual(find('brand', 'acure', CA, 'amazon_fees').sellerboard_value, 90); // 62 - 2 + 30
assert.strictEqual(find('brand', 'acure', CA, 'amazon_fees').status, 'match');
assert.strictEqual(find('brand', 'acure', CA, 'refund_amount').status, 'match');  // 20 vs 20 from daily_fees_asin
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

const sum = R.summarize(rows, y);
assert.ok(sum.flags7d.length >= 2, 'flags7d: ' + JSON.stringify(sum.flags7d));
assert.ok(sum.flags7d[0].includes('Amazon') && sum.flags7d[0].includes('Sellerboard'));
console.log(sum.flags7d.join('\n'));
console.log('rows', rows.length, 'counts', JSON.stringify(sum.counts));
console.log('all reconcile checks passed');
