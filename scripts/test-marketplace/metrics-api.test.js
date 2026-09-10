'use strict';
// /api/metrics against the stub server (scripts/test-marketplace/stub-server.js):
// resolved values (Sellerboard first), byMp, flags, coverage, financials, FX.
//   node scripts/test-marketplace/metrics-api.test.js http://127.0.0.1:3699
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { pstDateStr, pstSubtractDays } = require(ROOT + '/sync/dateUtils.js');
const BASE = process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3699}`;

const CA = 'A2EUQ1WTGCTBG2', US = 'ATVPDKIKX0DER', UK = 'A1F83G8C2ARO7P';
const y = pstSubtractDays(pstDateStr(), 1);
const d = n => pstSubtractDays(y, n);
const D1 = d(2), D2 = d(1), D3 = d(0);

(async () => {
  const res = await fetch(`${BASE}/api/metrics?from=${D1}&to=${D3}`);
  const body = await res.json();
  if (res.status !== 200) { console.error('HTTP', res.status, body); process.exit(1); }

  assert.deepStrictEqual(body.marketplaces.map(m => m.code).sort(), ['CA', 'UK', 'US']);
  assert.deepStrictEqual(body.sources.sellerboard[CA], { days: 2, from: D2, to: D3 });
  assert.deepStrictEqual(body.sources.sellerboard[UK], { days: 1, from: D3, to: D3 });
  assert.strictEqual(body.sources.sellerboard[US], undefined);

  const acure = body.brands.acure;
  const a1 = acure.skus.find(s => s.asin === 'A1');
  assert.strictEqual(a1.unitsCad, 38);
  assert.strictEqual(a1.revenueCad, 380);
  assert.strictEqual(a1.spendCad, 12);
  assert.strictEqual(a1.attributedSalesCad, 32); // 7d-first: d1 7d=18, d2 14d fallback=14
  assert.strictEqual(a1.feesCad, 98);
  assert.strictEqual(a1.sessions, 135);
  assert.strictEqual(a1.inventory.onHand, 85);
  assert.strictEqual(a1.source, 'mixed');
  assert.strictEqual(a1.flagged, true);
  assert.strictEqual(a1.byMp[CA].units, 38);
  assert.strictEqual(a1.byMp[CA].netProfit, 124);
  assert.strictEqual(a1.byMp[CA].flags.units.amazon, 15);
  assert.strictEqual(a1.byMp[CA].flags.units.sellerboard, 28);
  assert.strictEqual(a1.byMp[CA].flags.adSpend, undefined);
  assert.deepStrictEqual(a1.marketplaces, ['CA']);
  assert.strictEqual(acure.summary.revenueCad, 380);
  assert.strictEqual(acure.summary.units, 38);
  assert.strictEqual(acure.summary.byMp[CA].source, 'mixed');
  assert.strictEqual(acure.summary.byMp[CA].flags.sales.delta, -120);

  const zel = body.brands.zellies;
  const z1 = zel.skus.find(s => s.asin === 'Z1');
  assert.strictEqual(z1.revenueCad, 30);
  assert.strictEqual(z1.revenueUsd, 120);
  assert.strictEqual(z1.byMp[US].source, 'amazon');
  assert.strictEqual(z1.byMp[US].fees, null);
  assert.strictEqual(z1.feesUsd, 30);
  assert.strictEqual(z1.byMp[UK].sales, 40);
  assert.strictEqual(z1.byMp[UK].currency, 'GBP');
  assert.strictEqual(z1.byMp[UK].source, 'sellerboard');
  assert.strictEqual(z1.units, 13);
  assert.deepStrictEqual(z1.marketplaces.sort(), ['CA', 'UK', 'US']);
  assert.strictEqual(z1.flagged, false);
  assert.strictEqual(zel.summary.units, 13);
  assert.strictEqual(zel.summary.byMp[UK].units, 4);

  const fin = body.financials;
  assert.strictEqual(fin.byMp[CA].amazonFees, 25 + 20 + 53 + 9);
  assert.strictEqual(fin.byMp[CA].serviceFees, 10 + 6 + 6);
  assert.strictEqual(fin.byMp[CA].source, 'mixed');
  assert.strictEqual(fin.CAD.amazonFees, fin.byMp[CA].amazonFees);
  assert.strictEqual(fin.CAD.serviceFees, 22);
  assert.strictEqual(fin.byMp[US].amazonFees, 30);
  assert.strictEqual(fin.byMp[US].source, 'amazon');
  assert.strictEqual(fin.USD.amazonFees, 30);
  assert.strictEqual(fin.byMp[UK].amazonFees, 12);
  assert.strictEqual(fin.byMp[UK].currency, 'GBP');
  assert.ok(fin.feeSource.startsWith('sellerboard+'));
  assert.strictEqual(fin.byMp[CA].adSpend, 12);
  assert.strictEqual(fin.CAD.adSpend, 12);

  assert.ok(body.flags[CA].units, 'CA units flagged at account level');
  assert.strictEqual(body.flags[US], undefined);

  const fx = await fetch(`${BASE}/api/fx`).then(r => r.json());
  assert.ok(fx.toCad && fx.toCad.CAD === 1 && fx.toCad.USD > 0 && fx.toCad.GBP > 0, JSON.stringify(fx));

  // /api/brand-ads — SP (7d-first from daily_metrics) + SB/SD (daily_brand_ads)
  // + combined TACOS per the master-sheet convention.
  const ads = await fetch(`${BASE}/api/brand-ads/acure?from=${D1}&to=${D3}`).then(r => r.json());
  assert.strictEqual(ads.adAttribution, '7d');
  assert.strictEqual(ads.sp.spendCad, 12);
  assert.strictEqual(ads.sp.salesCad, 32);            // d1 7d=18, d2 14d fallback=14
  assert.strictEqual(ads.sb.spendCad, 6);
  assert.strictEqual(ads.sb.salesCad, 24);
  assert.strictEqual(ads.sb.daysWithData, 1);
  assert.strictEqual(ads.sd.spendCad, 2);
  assert.strictEqual(ads.total.spendCad, 20);         // 12 SP + 6 SB + 2 SD
  assert.strictEqual(ads.total.salesCad, 64);         // 32 + 24 + 8
  assert.strictEqual(ads.total.acos, 31.25);          // 20 / 64
  assert.strictEqual(ads.revenue.revCad, 260);        // wide daily_metrics revenue (Amazon side)
  assert.strictEqual(ads.tacos.ca, 7.69);             // 20 / 260
  assert.strictEqual(ads.tacos.us, null);             // no USD revenue for acure
  const notFound = await fetch(`${BASE}/api/brand-ads/nope`);
  assert.strictEqual(notFound.status, 404);

  console.log('all /api/metrics checks passed');
})().catch(e => { console.error(e); process.exit(1); });
