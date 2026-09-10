'use strict';
const assert = require('assert');
const R = require(require('path').resolve(__dirname, '..', '..') + '/sync/metricsResolver.js');
const CA = 'A2EUQ1WTGCTBG2', US = 'ATVPDKIKX0DER', UK = 'A1F83G8C2ARO7P';

// Range: d1..d3. Sellerboard covers CA on d2,d3 and UK on d3; nothing for US.
const wideRows = [
  { date: 'd1', asin: 'A', units: 10, units_ca: 10, units_us: 0, revenue_cad: 100, revenue_usd: 0, spend_cad: 5, spend_usd: 0, attributed_sales_cad: 20, attributed_sales_usd: 0, attributed_sales_7d_cad: 18, attributed_sales_7d_usd: 0, refunded_units: 1, refund_amount_cad: 10, refund_amount_usd: 0 },
  { date: 'd2', asin: 'A', units: 12, units_ca: 7, units_us: 5, revenue_cad: 70, revenue_usd: 60, spend_cad: 3, spend_usd: 2, attributed_sales_cad: 14, attributed_sales_usd: 12, refunded_units: 0, refund_amount_cad: 0, refund_amount_usd: 0 },
  { date: 'd3', asin: 'A', units: 8,  units_ca: 8, units_us: 0, revenue_cad: 90, revenue_usd: 0, spend_cad: 4, spend_usd: 0, attributed_sales_cad: 0,  attributed_sales_usd: 0, refunded_units: 2, refund_amount_cad: 0, refund_amount_usd: 0 },
  { date: 'd3', asin: 'B', units: 3,  units_ca: 3, units_us: 0, revenue_cad: 30, revenue_usd: 0, spend_cad: 0, spend_usd: 0, attributed_sales_cad: 0,  attributed_sales_usd: 0, refunded_units: 0, refund_amount_cad: 0, refund_amount_usd: 0 },
];
const sbRows = [
  { date: 'd2', mp_id: CA, asin: 'A', units: 7,  sales: 70,  ad_spend: 3, refunds: 0, refund_amount: 0, amazon_fees: 20, net_profit: 30, promo_value: 1, product_costs: 20 },
  { date: 'd3', mp_id: CA, asin: 'A', units: 20, sales: 200, ad_spend: 4, refunds: 2, refund_amount: 0, amazon_fees: 50, net_profit: 90, promo_value: 0, product_costs: 60, sellable_returns_pct: 50 }, // Amazon says 8 / 90 → flag
  { date: 'd3', mp_id: CA, asin: 'A', units: 1,  sales: 10,  ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 3,  net_profit: 4,  promo_value: 0, product_costs: 3 },  // second SKU, same ASIN
  { date: 'd3', mp_id: UK, asin: 'A', units: 4,  sales: 40,  ad_spend: 1, refunds: 0, refund_amount: 0, amazon_fees: 12, net_profit: 15, promo_value: 0, product_costs: 10 },
];
const fees = { [`A|${CA}|d1`]: 25, [`A|${CA}|d2`]: 21, [`A|${CA}|d3`]: 22, [`B|${CA}|d3`]: 9, [`A|${US}|d2`]: 15 };

const res = R.resolveByAsin({ wideRows, sbRows, feeByAsinMpDate: fees, from: 'd1', to: 'd3' });
assert.deepStrictEqual(res.coverage[CA], { days: 2, from: 'd2', to: 'd3' });
assert.deepStrictEqual(res.coverage[UK], { days: 1, from: 'd3', to: 'd3' });
assert.deepStrictEqual(res.marketplaces.sort(), [UK, CA, US].sort());

const aCA = res.byAsin.A[CA];
// resolved CA for A: d1 Amazon (10/100/5/fees25/ref 1,$10) + d2 SB (7/70/3/fees20) + d3 SB (21/210/4/fees53)
assert.strictEqual(aCA.resolved.units, 38);
assert.strictEqual(aCA.resolved.sales, 380);
assert.strictEqual(aCA.resolved.adSpend, 12);
assert.strictEqual(aCA.resolved.fees, 98);
assert.strictEqual(aCA.resolved.refunds, 3);
assert.strictEqual(aCA.resolved.refundAmount, 10);
assert.strictEqual(aCA.resolved.netProfit, 124);
assert.strictEqual(aCA.resolved.attributedSales, 32);   // Amazon-only metric, 7d-first (d1: 7d=18 wins over 14d=20; d2: no 7d row, falls back to 14d=14)
assert.strictEqual(aCA.resolved.sellableReturns, 1);    // d3: 2 refunds x 50% graded sellable
assert.strictEqual(aCA.resolved.sellableBasis, 2);      // only graded refunds count toward the %
assert.strictEqual(aCA.source, 'mixed');
assert.strictEqual(aCA.sbDays, 2);
assert.strictEqual(aCA.amzDays, 2);
// amz side over covered days only: d2 (7/70/3/fees21) + d3 (8/90/4/fees22, refunds 2)
assert.strictEqual(aCA.amz.units, 15);
assert.strictEqual(aCA.amz.sales, 160);
assert.strictEqual(aCA.amz.fees, 43);
assert.strictEqual(aCA.sb.units, 28);
assert.strictEqual(aCA.sb.sales, 280);
// flags: units 15 vs 28 (flag), sales 160 vs 280 (flag), adSpend 7 vs 7 (match → absent), fees 43 vs 73 (flag), refunds 2 vs 2 (match)
assert.strictEqual(aCA.flags.units.status, 'flag');
assert.strictEqual(aCA.flags.sales.delta, -120);
assert.strictEqual(aCA.flags.adSpend, undefined);
assert.strictEqual(aCA.flags.refunds, undefined);
assert.strictEqual(aCA.flags.fees.status, 'flag');

// US: uncovered → Amazon
const aUS = res.byAsin.A[US];
assert.strictEqual(aUS.source, 'amazon');
assert.strictEqual(aUS.resolved.units, 5);
assert.strictEqual(aUS.resolved.sales, 60);
assert.strictEqual(aUS.resolved.fees, 15);
assert.deepStrictEqual(aUS.flags, {});

// UK: Sellerboard only
const aUK = res.byAsin.A[UK];
assert.strictEqual(aUK.source, 'sellerboard');
assert.strictEqual(aUK.resolved.sales, 40);
assert.strictEqual(aUK.amzDays, 0);
assert.deepStrictEqual(aUK.flags, {});

// B: CA covered on d3, Amazon has 3/30 but Sellerboard has no row → Sellerboard wins with 0, flagged amz_only
const bCA = res.byAsin.B[CA];
assert.strictEqual(bCA.resolved.units, 0);
assert.strictEqual(bCA.source, 'amazon');            // no sbDays for B itself…
assert.strictEqual(bCA.amz.units, 3);                // …but Amazon side was parked, not resolved
assert.deepStrictEqual(bCA.flags, {});               // no sb rows → nothing to compare at ASIN level

// aggregateMp over CA slots (A + B)
const agg = R.aggregateMp([aCA, bCA]);
assert.strictEqual(agg.units, 38);
assert.strictEqual(agg.sales, 380);
assert.strictEqual(agg.source, 'mixed');
assert.strictEqual(agg.flags.units.amazon, 18);
assert.strictEqual(agg.flags.units.sellerboard, 28);

// resolveFinancials
const feeRows = [
  { date: 'd1', fees_cad: 100, fees_usd: 0,  service_fees_cad: 10, service_fees_usd: 0, refund_amount_cad: 10, refund_amount_usd: 0, refund_fees_cad: 1, refund_fees_usd: 0, refund_count: 1, breakdown_cad: { Storage: 4, Referral: 60 }, breakdown_usd: {} },
  { date: 'd2', fees_cad: 80,  fees_usd: 30, service_fees_cad: 9,  service_fees_usd: 2, refund_amount_cad: 0,  refund_amount_usd: 0, refund_fees_cad: 0, refund_fees_usd: 0, refund_count: 0, breakdown_cad: { Storage: 3 }, breakdown_usd: { Storage: 1 } },
  { date: 'd3', fees_cad: 70,  fees_usd: 0,  service_fees_cad: 8,  service_fees_usd: 0, refund_amount_cad: 5,  refund_amount_usd: 0, refund_fees_cad: 0, refund_fees_usd: 0, refund_count: 1, breakdown_cad: { Storage: 2 }, breakdown_usd: {} },
];
const fin = R.resolveFinancials({ feeRows, sbRows, coverageDates: res.coverageDates, from: 'd1', to: 'd3' });
// CA: d1 Amazon (fees 100, svc 10, ref 10) + d2 SB (fees 20, svc 9-3=6) + d3 SB (fees 53, svc 8-2=6, ref 0)
assert.strictEqual(fin[CA].amazonFees, 173);
assert.strictEqual(fin[CA].serviceFees, 22);
assert.strictEqual(fin[CA].refundAmount, 10);
assert.strictEqual(fin[CA].refundFees, 1);
assert.strictEqual(fin[CA].source, 'mixed');
assert.strictEqual(fin[CA].netProfit, 124);
assert.strictEqual(fin[CA].flags.amazonFees.amazon, 150);      // Amazon d2+d3 = 150 vs SB 73
assert.strictEqual(fin[CA].flags.amazonFees.sellerboard, 73);
assert.strictEqual(fin[CA].currency, 'CAD');
// US: uncovered → Amazon all the way
assert.strictEqual(fin[US].amazonFees, 30);
assert.strictEqual(fin[US].serviceFees, 2);
assert.strictEqual(fin[US].source, 'amazon');
// UK: Sellerboard only
assert.strictEqual(fin[UK].amazonFees, 12);
assert.strictEqual(fin[UK].serviceFees, 0);
assert.strictEqual(fin[UK].source, 'sellerboard');
assert.strictEqual(fin[UK].currency, 'GBP');

// Range filter: rows outside from..to ignored
const res2 = R.resolveByAsin({ wideRows, sbRows, feeByAsinMpDate: fees, from: 'd1', to: 'd1' });
assert.strictEqual(res2.byAsin.A[CA].resolved.units, 10);
assert.strictEqual(res2.byAsin.A[CA].source, 'amazon');
assert.deepStrictEqual(res2.coverage, {});

console.log('all resolver checks passed');
