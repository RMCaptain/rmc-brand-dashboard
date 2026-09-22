'use strict';
// Weekly performance digest — week-range math and the per-brand WoW rollup.
const assert = require('assert');
const path = require('path');
const { weekRanges, brandTotals, buildWeeklyDigest } = require(path.resolve(__dirname, '..', '..') + '/slack/weeklyDigest');

// ── weekRanges: last COMPLETE Mon–Sun week in PST ──
// 2026-09-22 is a Tuesday → last full week is Mon 14 – Sun 20.
assert.deepStrictEqual(weekRanges('2026-09-22'), {
  cur: { from: '2026-09-14', to: '2026-09-20' },
  prev: { from: '2026-09-07', to: '2026-09-13' },
});
// Monday: the week that ended yesterday counts.
assert.deepStrictEqual(weekRanges('2026-09-21').cur, { from: '2026-09-14', to: '2026-09-20' });
// Sunday: this week isn't complete — reach back to the previous one.
assert.deepStrictEqual(weekRanges('2026-09-20').cur, { from: '2026-09-07', to: '2026-09-13' });

// ── brandTotals: CAD conversion + per-SKU Sellerboard profit rule ──
const fx = { usdToCad: 1.4, toCad: { CAD: 1, USD: 1.4, GBP: 1.9 } };
const mk = (over = {}) => ({ code: 'CA', currency: 'CAD', source: 'sellerboard', units: 10, sales: 100, adSpend: 5, fees: 20, refundAmount: 0, refunds: 1, netProfit: 30, ...over });
const payload = {
  brands: {
    // Summary slice reads 'mixed' (zero-activity Amazon slot folded in) but
    // every ACTIVE sku slice is SB → profit still exact, per-SKU summed.
    zellies: {
      summary: { byMp: {
        mp_ca: mk({ source: 'mixed' }),
        mp_us: mk({ code: 'US', currency: 'USD', sales: 50, netProfit: 10, units: 5, adSpend: 2, refunds: 0 }),
      } },
      skus: [
        { asin: 'Z1', byMp: { mp_ca: mk(), mp_us: mk({ code: 'US', currency: 'USD', sales: 50, netProfit: 10, units: 5 }) } },
        { asin: 'Z2', byMp: { mp_ca: mk({ units: 0, sales: 0, adSpend: 0, fees: 0, refundAmount: 0, refunds: 0, source: 'amazon', netProfit: null }) } },
      ],
    },
    // An uncovered ACTIVE slice worth >5% of sales → no profit claim.
    acure: {
      summary: { byMp: { mp_ca: mk({ sales: 240 }) } },
      skus: [
        { asin: 'A1', byMp: { mp_ca: mk({ sales: 200, netProfit: 60 }) } },
        { asin: 'A2', byMp: { mp_ca: mk({ sales: 140, source: 'amazon', netProfit: null }) } },
      ],
    },
    // A sliver uncovered (≤ max(5%, $100)) → summed profit, marked approx.
    trimax: {
      summary: { byMp: { mp_ca: mk({ sales: 5000 }) } },
      skus: [
        { asin: 'T1', byMp: { mp_ca: mk({ sales: 4950, netProfit: 900 }) } },
        { asin: 'T2', byMp: { mp_ca: mk({ sales: 50, source: 'amazon', netProfit: null }) } },
        // FBA reimbursement: negative fees, no units — real profit that a
        // `fees > 0` activity test used to drop.
        { asin: 'T3', byMp: { mp_ca: mk({ units: 0, sales: 0, adSpend: 0, refunds: 0, fees: -40, netProfit: 40 }) } },
      ],
    },
    idle: { summary: { byMp: { mp_ca: mk({ units: 0, sales: 0, adSpend: 0, fees: 0, refunds: 0, netProfit: 0 }) } }, skus: [] },
  },
};
const t = brandTotals(payload, fx);
assert.strictEqual(t.zellies.sales, 100 + 50 * 1.4);
assert.strictEqual(t.zellies.units, 15);
assert.strictEqual(t.zellies.netProfit, 30 + 10 * 1.4, 'active-SB skus: exact profit despite mixed summary label');
assert.strictEqual(t.zellies.approx, false);
assert.strictEqual(t.acure.netProfit, null, 'uncovered slice past guardrail: no fake profit');
assert.strictEqual(t.trimax.netProfit, 940, 'sliver uncovered: summed, reimbursement slice counted');
assert.strictEqual(t.trimax.approx, true, '…and marked approximate');
assert.strictEqual(t.idle.netProfit, null, 'no active slice: no profit claim');

// ── buildWeeklyDigest: WoW, ordering, totals ──
const prevPayload = { brands: { zellies: { summary: { byMp: { mp_ca: mk({ sales: 85, netProfit: 25 }) } } } } };
const brands = [{ id: 'zellies', name: 'Zellies' }, { id: 'acure', name: 'Acure' }, { id: 'trimax', name: 'Trimax' }, { id: 'idle', name: 'Idle' }, { id: 'unknown-brand', name: 'Unknown' }];
const d = buildWeeklyDigest({ curPayload: payload, prevPayload, brands, fx, range: weekRanges('2026-09-22'), dashboardUrl: 'https://x' });
assert.strictEqual(d.lines.length, 3, 'idle + unknown-brand excluded');
assert.ok(d.lines[0].startsWith('*Trimax*'), 'sorted by sales desc: ' + d.lines[0]);
assert.ok(d.lines[0].includes('profit ~CA$940'), 'approx profit marked: ' + d.lines[0]);
assert.ok(d.lines[1].startsWith('*Acure*') && d.lines[1].includes('profit —'), 'uncovered brand shows no profit number: ' + d.lines[1]);
assert.ok(d.lines[1].includes('(new)'), 'acure had no prior week: ' + d.lines[1]);
assert.ok(d.lines[2].includes('+100% WoW'), 'zellies WoW: 170 vs 85: ' + d.lines[2]);
assert.ok(d.blocks[0].text.text.includes('Sep 14 – Sep 20'), d.blocks[0].text.text);
assert.ok(d.fallback.includes('3 brands'), d.fallback);
assert.strictEqual(d.totals.sales, (100 + 50 * 1.4) + 240 + 5000);
assert.strictEqual(d.totals.npAll, false, 'account total flagged partial when a brand has no profit');
assert.ok(d.blocks[1].text.text.includes('partial'), 'total line says partial: ' + d.blocks[1].text.text);

// Empty week renders, doesn't throw.
const empty = buildWeeklyDigest({ curPayload: { brands: {} }, prevPayload: { brands: {} }, brands, fx, range: weekRanges('2026-09-22') });
assert.ok(empty.blocks.length >= 3);

console.log('all weekly-digest checks passed');
