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
assert.deepStrictEqual(skipped.unknownMarketplace, { 'Amazon.de': 1 });
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
