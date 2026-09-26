'use strict';
// Margin guard — anomaly rules, floors, and the no-fake-profit guard.
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { checkAnomalies, buildGuardMessage } = require(ROOT + '/slack/marginGuard');
const { cogsGaps } = require(ROOT + '/slack/weeklyDigest');

const fx = { usdToCad: 1.4, toCad: { CAD: 1, USD: 1.4 } };
const slice = (sales, np, ad = 0, over = {}) => ({ code: 'CA', currency: 'CAD', source: 'sellerboard', units: Math.max(1, Math.round(sales / 10)), sales, adSpend: ad, fees: sales * 0.25, refundAmount: 0, refunds: 0, netProfit: np, promo: 0, ...over });
const brandPayload = (sales, np, ad = 0, over = {}) => ({
  summary: { byMp: { mp_ca: slice(sales, np, ad, over) } },
  skus: [{ asin: 'X1', byMp: { mp_ca: slice(sales, np, ad, over) } }],
});

const brands = [
  { id: 'acure', name: 'Acure' }, { id: 'trimax', name: 'Trimax' },
  { id: 'tiny', name: 'Tiny' }, { id: 'unknown-brand', name: 'Unknown' },
];

// Acure: margin 20% baseline → 8% now (drop 12pts). Trimax: TACOS 3% → 9%.
// Tiny: huge drop but only $200 of 7d sales — below the floor, ignored.
const curPayload = { brands: {
  acure:  brandPayload(2000, 160),
  trimax: brandPayload(3000, 600, 270),
  tiny:   brandPayload(200, -100, 0),
} };
const basePayload = { brands: {
  acure:  brandPayload(8000, 1600),
  trimax: brandPayload(12000, 2400, 360),
  tiny:   brandPayload(900, 400, 0),
} };

const anoms = checkAnomalies({ curPayload, basePayload, brands, fx });
assert.strictEqual(anoms.length, 2, JSON.stringify(anoms));
assert.ok(anoms.some(a => a.brandId === 'acure' && a.kind === 'margin' && a.cur === 8 && a.base === 20), 'acure margin drop');
assert.ok(anoms.some(a => a.brandId === 'trimax' && a.kind === 'tacos' && a.cur === 9 && a.base === 3), 'trimax tacos spike');
assert.ok(anoms[0].brandId === 'trimax', 'sorted by 7d sales desc');

// No profit claim on either side → no margin alert (never alert off fiction).
const noNp = { brands: { acure: brandPayload(2000, null, 0, { source: 'amazon', netProfit: null }) } };
assert.strictEqual(checkAnomalies({ curPayload: noNp, basePayload, brands, fx }).filter(a => a.kind === 'margin').length, 0);

// Thresholds are tunable: a 12pt drop passes a 15pt bar.
assert.strictEqual(checkAnomalies({ curPayload, basePayload, brands, fx, opts: { marginDropPts: 15, tacosRisePts: 99 } }).length, 0);

// Message renders both kinds.
const msg = buildGuardMessage(anoms, { cur: { from: 'a', to: 'b' }, base: { from: 'c', to: 'd' } });
assert.ok(msg.fallback.includes('2 brands'), msg.fallback);
assert.ok(msg.blocks[1].text.text.includes('Acure') && msg.blocks[1].text.text.includes('TACOS 9%'), msg.blocks[1].text.text);

// ── cogsGaps: sold-without-SB-cost detection, revenue-ranked ──
const gapBrands = [
  { id: 'acure', name: 'Acure', cogsSb: { A1: { CA: { unit: 2 } } }, asinTitles: { A2: 'Acure Two' } },
  { id: 'unknown-brand', name: 'Unknown' },
];
const gapPayload = { brands: {
  acure: { skus: [
    { asin: 'A1', byMp: { mp_ca: slice(500, 100) } },                                  // priced → no gap
    { asin: 'A2', byMp: { mp_ca: slice(300, 60), mp_us: slice(100, 20, 0, { code: 'US', currency: 'USD' }) } }, // unpriced both mps
    { asin: 'A3', byMp: { mp_ca: slice(0, 0, 0, { units: 0, sales: 0 }) } },           // no units → no gap
  ] },
  'unknown-brand': { skus: [{ asin: 'U1', byMp: { mp_ca: slice(9999, 0) } }] },        // excluded
} };
const gaps = cogsGaps(gapPayload, gapBrands, fx);
assert.strictEqual(gaps.length, 2, JSON.stringify(gaps));
assert.deepStrictEqual(gaps.map(g => `${g.asin}:${g.mp}`), ['A2:CA', 'A2:US'], 'ranked by CAD revenue');
assert.strictEqual(gaps[0].revenueCad, 300);
assert.strictEqual(gaps[1].revenueCad, 140);
assert.strictEqual(gaps[0].title, 'Acure Two');

console.log('all margin-guard + cogs-gaps checks passed');
