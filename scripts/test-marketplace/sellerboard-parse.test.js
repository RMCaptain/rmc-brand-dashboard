'use strict';
// sync/sellerboard.js parser against fixtures-sellerboard-feed.csv — the real
// feed's 68-column header (captured 2026-09-09, Cyrillic В in SponsoredBrands
// included) with synthetic rows: two SKUs of one ASIN, CA/US/UK rows, an
// Amazon.de row the registry doesn't know, and a bad-date row.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const sb = require(ROOT + '/sync/sellerboard.js');

const text = fs.readFileSync(path.join(__dirname, 'fixtures-sellerboard-feed.csv'), 'utf8');
const { rows, skipped, headers } = sb.parseFeed(text, { account: 'RMC', asinBrand: { B0TEST0001: 'acure' } });

assert.strictEqual(headers.length, 68);
assert.ok(headers.includes('sponsoredbrands'), 'Cyrillic В folded to Latin B');
assert.strictEqual(rows.length, 4, 'CA×2 + US + UK; DE + bad date skipped');
assert.deepStrictEqual(skipped.unknownMarketplace, { 'Amazon.com.mx': 1 }); // MX deliberately unmapped — Amazon.de became a real marketplace 2026-09-10
assert.strictEqual(skipped.badDate, 1);

const t1 = rows.find(r => r.sku === 'T1-CAD');
assert.strictEqual(t1.date, '2026-09-08');
assert.strictEqual(t1.mp_id, 'A2EUQ1WTGCTBG2');
assert.strictEqual(t1.currency, 'CAD');
assert.strictEqual(t1.brand_id, 'acure');
assert.strictEqual(t1.channel, 'FBA');
assert.strictEqual(t1.sales, 150);           // organic 100 + PPC 50
assert.strictEqual(t1.sales_ppc, 50);
assert.strictEqual(t1.units, 6);
assert.strictEqual(t1.units_ppc, 2);
assert.strictEqual(t1.refunds, 1);
assert.strictEqual(t1.refund_amount, 25);    // principal, positive
assert.strictEqual(t1.refund_costs, 14);     // -(3.75 - 25 - 0.75 + 8) = 14
assert.strictEqual(t1.promo_value, 2.5);
assert.strictEqual(t1.ad_spend, 11.5);
assert.strictEqual(t1.ad_spend_sp, 10);
assert.strictEqual(t1.ad_spend_sb, 1.5);     // read through the Cyrillic header
assert.strictEqual(t1.amazon_fees, 47.9);    // 22.5 + 30 + 0.4 - 5 reimbursement
assert.strictEqual(t1.product_costs, 48);
assert.strictEqual(t1.est_payout, 90);
assert.strictEqual(t1.net_profit, 20.1);
assert.strictEqual(t1.margin, 13.4);
assert.strictEqual(t1.sessions, 45);
assert.strictEqual(t1.unit_session_pct, 13.33);
assert.strictEqual(t1.raw['SponsoredВrands'], '-1.50', 'raw keeps the original header');

const t1b = rows.find(r => r.sku === 'T1-CAD-2');
assert.strictEqual(t1b.asin, 'B0TEST0001');
assert.strictEqual(t1b.sessions, null, 'blank sessions → null, not 0');
assert.strictEqual(t1b.channel, 'FBM');

const t2 = rows.find(r => r.sku === 'T2-USD');
assert.strictEqual(t2.mp_id, 'ATVPDKIKX0DER');
assert.strictEqual(t2.currency, 'USD');
assert.strictEqual(t2.brand_id, 'unknown-brand');
assert.strictEqual(t2.sessions, 0, '"0" stays 0');

const uk = rows.find(r => r.sku === 'T2-GBP');
assert.strictEqual(uk.mp_id, 'A1F83G8C2ARO7P');
assert.strictEqual(uk.currency, 'GBP');
assert.strictEqual(uk.sales, 60);
assert.strictEqual(uk.amazon_fees, 9);

// helpers
assert.strictEqual(sb.parseSbDate('9/8/2026'), '2026-09-08');
assert.strictEqual(sb.parseSbDate('2026-09-08 00:00'), '2026-09-08');
assert.strictEqual(sb.parseSbDate('nope'), null);
assert.deepStrictEqual(sb.parseCsv('"a,b","c""d"\r\n1,2\n'), [['a,b', 'c"d'], ['1', '2']]);
assert.strictEqual(sb.normHeader(' SponsoredВrands '), 'sponsoredbrands');

// header-only file (UK feed before first sale) parses to zero rows, no throw
const headerOnly = text.split('\n')[0] + '\n';
assert.strictEqual(sb.parseFeed(headerOnly).rows.length, 0);

console.log('all sellerboard parse checks passed');

// ── fee split + feed-currency conversion (sync/fxRates.js) ──
assert.strictEqual(t1.fee_charges, 52.9, 'charges only: 22.5 + 30 + 0.4');
assert.strictEqual(t1.reimbursements, 5);
assert.strictEqual(Math.round((t1.fee_charges - t1.reimbursements) * 100) / 100, t1.amazon_fees);
assert.strictEqual(t1.storage_fees, 0.4, 'fixture books the 0.40 as FBAStorageFee');
assert.strictEqual(t1.order_fees, 52.5, 'commission 22.5 + FBA per-unit 30; storage excluded');
assert.strictEqual(t1.feed_currency, 'CAD', 'no feedCurrency → assumed native');
assert.strictEqual(t1.fx_source, 'same');

const usdFeed = sb.parseFeed(text, { account: 'RMC', asinBrand: {}, feedCurrency: 'USD' }).rows;
const rateFor = (date, from, to) => ({ rate: from === 'USD' && to === 'CAD' ? 1.4 : from === 'USD' && to === 'GBP' ? 0.8 : 1, source: 'daily' });
const { stats } = sb.convertRows(usdFeed, { rateFor });
const c1 = usdFeed.find(r => r.sku === 'T1-CAD'), c2 = usdFeed.find(r => r.sku === 'T2-USD'), cuk = usdFeed.find(r => r.sku === 'T2-GBP');
assert.strictEqual(c1.feed_currency, 'USD'); assert.strictEqual(c1.currency, 'CAD');
assert.strictEqual(c1.sales, 210, 'CA row converted USD → CAD at 1.4');
assert.strictEqual(c1.amazon_fees, 67.06); assert.strictEqual(c1.net_profit, 28.14); assert.strictEqual(c1.order_fees, 73.5);
assert.strictEqual(c1.units, 6, 'counts untouched');
assert.strictEqual(c1.fx_rate, 1.4); assert.strictEqual(c1.fx_source, 'daily');
assert.strictEqual(c1.raw.SalesOrganic, '100.00', 'raw stays in feed currency');
assert.strictEqual(c2.sales, 80, 'US row already native'); assert.strictEqual(c2.fx_source, 'same');
assert.strictEqual(cuk.sales, 48, 'UK row USD → GBP at 0.8');
assert.deepStrictEqual(stats, { daily: 3 });

// implied rate: Amazon native sales ÷ feed sales, only where units agree and it sits near the external rate
const CA = 'A2EUQ1WTGCTBG2';
const mk = (date, units, sales) => ({ mp_id: CA, date, currency: 'CAD', feed_currency: 'USD', units, sales });
const ext = () => ({ rate: 1.4, source: 'live' });
assert.deepStrictEqual(sb.impliedRates([mk('2026-09-01', 100, 1000)], { [`${CA}|2026-09-01`]: { units: 101, sales: 1380 } }, ext), { [`${CA}|2026-09-01`]: 1.38 });
assert.deepStrictEqual(sb.impliedRates([mk('2026-09-01', 100, 1000)], { [`${CA}|2026-09-01`]: { units: 110, sales: 1380 } }, ext), {}, 'units disagree → no implied rate');
assert.deepStrictEqual(sb.impliedRates([mk('2026-09-01', 100, 1000)], { [`${CA}|2026-09-01`]: { units: 100, sales: 1500 } }, ext), {}, 'drifts >4% from external → rejected');
assert.deepStrictEqual(sb.impliedRates([mk('2026-09-01', 10, 100)], { [`${CA}|2026-09-01`]: { units: 10, sales: 138 } }, ext), {}, 'below minimum sales → rejected');
assert.deepStrictEqual(sb.impliedRates([mk('2026-09-01', 100, 1000)], {}, ext), {}, 'no Amazon day → nothing');
const conv = [mk('2026-09-01', 50, 500), mk('2026-09-02', 50, 500)];
sb.convertRows(conv, { rateFor: ext, implied: { [`${CA}|2026-09-01`]: 1.38 } });
assert.strictEqual(conv[0].sales, 690); assert.strictEqual(conv[0].fx_source, 'implied');
assert.strictEqual(conv[1].sales, 700); assert.strictEqual(conv[1].fx_source, 'live');

// fxRates resolver: daily → carry-forward → live → fallback
const FX = require(ROOT + '/sync/fxRates.js');
const rf = FX.makeRateResolver({ daily: { '2026-09-01': { CAD: 1, USD: 1.38, GBP: 1.8 } }, live: { CAD: 1, USD: 1.4, GBP: 1.75 } });
assert.deepStrictEqual(rf('2026-09-01', 'USD', 'CAD'), { rate: 1.38, source: 'daily' });
assert.deepStrictEqual(rf('2026-09-05', 'USD', 'CAD'), { rate: 1.38, source: 'carry' });
assert.deepStrictEqual(rf('2026-08-20', 'USD', 'CAD'), { rate: 1.4, source: 'live' });
assert.deepStrictEqual(rf('2026-09-01', 'USD', 'GBP'), { rate: 0.7667, source: 'daily' });
assert.deepStrictEqual(rf('2026-09-01', 'CAD', 'CAD'), { rate: 1, source: 'same' });
assert.strictEqual(FX.makeRateResolver({})('2026-09-01', 'USD', 'CAD').source, 'fallback');
console.log('all sellerboard fx/conversion checks passed');
