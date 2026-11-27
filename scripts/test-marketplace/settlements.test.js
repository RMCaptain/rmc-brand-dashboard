'use strict';
// Pure-function coverage for sync/settlements.js: settlement line/credit
// math (blank-SKU credit mapping via prior files, prefix filter, FBA-fee
// gate, truncation) and fee-preview column pass-through.
const assert = require('assert');
const { computeSettlementFees, shapePreviewRows, parseTsv } = require('../../sync/settlements');

const row = o => ({ 'transaction-type': 'Order', 'order-id': '', 'order-item-code': '', 'sku': '', 'amount-type': '', 'amount-description': '', 'amount': '0', 'quantity-purchased': '', 'posted-date': '2026-11-20', 'marketplace-name': 'Amazon.ca', ...o });
const audited = [
  row({ 'order-id': 'O1', 'order-item-code': 'I1', sku: 'ZE-A', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '20.00', 'quantity-purchased': '2' }),
  row({ 'order-id': 'O1', 'order-item-code': 'I1', sku: 'ZE-A', 'amount-type': 'ItemPrice', 'amount-description': 'Tax', amount: '2.60' }),
  row({ 'order-id': 'O1', 'order-item-code': 'I1', sku: 'ZE-A', 'amount-type': 'ItemFees', 'amount-description': 'FBAPerUnitFulfillmentFee', amount: '-7.50' }),
  row({ 'order-id': 'O1', 'order-item-code': 'I1', sku: 'ZE-A', 'amount-type': 'ItemFees', 'amount-description': 'Commission', amount: '-3.00' }),
  row({ 'order-id': 'O2', 'order-item-code': 'I2', sku: 'ZE-B', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '10.00', 'quantity-purchased': '1' }), // no FBA fee → dropped
  row({ 'order-id': 'O3', 'order-item-code': 'I3', sku: 'XX-1', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '50.00', 'quantity-purchased': '1' }),
  row({ 'order-id': 'O3', 'order-item-code': 'I3', sku: 'XX-1', 'amount-type': 'ItemFees', 'amount-description': 'FBAPerUnitFulfillmentFee', amount: '-9.00' }), // other prefix
  row({ 'transaction-type': 'Fee Adjustment', 'order-id': 'O9', sku: '', 'amount-description': 'FBAPerUnitFulfillmentFee', amount: '1.25' }), // blank sku, mapped via prior week
  row({ 'transaction-type': 'Fee Adjustment', 'order-id': 'O8', sku: '', 'amount-description': 'FBAPerUnitFulfillmentFee', amount: '0.80' }), // maps to XX → excluded
];
const prior = [[
  row({ 'order-id': 'O9', 'order-item-code': 'I9', sku: 'ZE-C', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '12', 'quantity-purchased': '1' }),
  row({ 'order-id': 'O8', 'order-item-code': 'I8', sku: 'XX-2', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '12', 'quantity-purchased': '1' }),
]];

const r = computeSettlementFees(audited, prior, 'ZE-');
assert.strictEqual(r.lines.length, 1, 'only ZE- lines with an FBA fee survive');
assert.deepStrictEqual({ ...r.lines[0] }, { postedDate: '2026-11-20', orderId: 'O1', orderItemCode: 'I1', sku: 'ZE-A', qty: 2, principal: 20, tax: 2.6, fbaFee: -7.5, marketplaceName: 'Amazon.ca' });
assert.strictEqual(r.credits.length, 1, 'blank-SKU credit mapped to ZE-C via prior file; XX credit excluded');
assert.strictEqual(r.credits[0].sku, 'ZE-C');
assert.strictEqual(r.credits[0].amount, 1.25);
assert.strictEqual(r.truncated, false);

// Truncation cap
const many = [];
for (let i = 0; i < 5; i++) {
  many.push(row({ 'order-id': 'M' + i, 'order-item-code': 'X', sku: 'ZE-M', 'amount-type': 'ItemPrice', 'amount-description': 'Principal', amount: '1', 'quantity-purchased': '1' }));
  many.push(row({ 'order-id': 'M' + i, 'order-item-code': 'X', sku: 'ZE-M', 'amount-type': 'ItemFees', 'amount-description': 'FBAPerUnitFulfillmentFee', amount: '-1' }));
}
const t = computeSettlementFees(many, [], 'ZE-', { cap: 3 });
assert.strictEqual(t.lines.length, 3); assert.strictEqual(t.truncated, true); assert.strictEqual(t.lineCount, 5);

// Fee preview: dims + every fee column pass through; prefix / asin filters
const tsv = 'sku\tfnsku\tasin\tproduct-name\tyour-price\tcurrency\tlongest-side\tmedian-side\tshortest-side\tunit-of-dimension\titem-package-weight\tunit-of-weight\tproduct-size-weight-band\testimated-pick-pack-fee-per-unit\texpected-fulfillment-fee-per-unit\testimated-fee-total\n'
  + 'ZE-A\tX0A\tB0001\tZellies A\t19.99\tCAD\t8.1\t5\t2.2\tinches\t0.6\tpounds\tLarge standard-size\t5.10\t5.10\t8.20\n'
  + 'QQ-1\tX0Q\tB0002\tOther\t9.99\tCAD\t4\t3\t1\tinches\t0.2\tpounds\tSmall standard-size\t3.00\t3.00\t4.50\n';
const p = parseTsv(tsv);
const shaped = shapePreviewRows(p.rows, p.header, { skuPrefix: 'ZE-' });
assert.strictEqual(shaped.rows.length, 1);
assert.deepStrictEqual(shaped.feeColumns, ['estimated-pick-pack-fee-per-unit', 'expected-fulfillment-fee-per-unit', 'estimated-fee-total']);
assert.strictEqual(shaped.rows[0]['longest-side'], 8.1);
assert.strictEqual(shaped.rows[0]['product-size-weight-band'], 'Large standard-size');
assert.strictEqual(shaped.rows[0]['estimated-fee-total'], 8.2);
const byAsin = shapePreviewRows(p.rows, p.header, { asinSet: new Set(['B0002']) });
assert.strictEqual(byAsin.rows[0].sku, 'QQ-1');

console.log('settlements: lines/credits math, prefix filter, blank-SKU mapping, truncation, fee-preview pass-through OK');

// Fee-preview marketplace guard: the document's currency decides.
{
  const { previewCurrencyOf } = require('../../sync/settlements');
  assert.strictEqual(previewCurrencyOf([{ currency: '' }, { currency: 'usd' }]), 'USD');
  assert.strictEqual(previewCurrencyOf([{ currency: 'CAD' }]), 'CAD');
  assert.strictEqual(previewCurrencyOf([]), null);
  console.log('fee-preview currency guard OK');
}
