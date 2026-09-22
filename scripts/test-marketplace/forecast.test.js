'use strict';
// PeriodCards.forecastFrom — the month-out forecast and its guardrails.
// Pure function: MTD actual + trailing-7-day run-rate × remaining days.
const assert = require('assert');
const PC = require(require('path').resolve(__dirname, '..', '..') + '/public/period-cards.js');

const mtd = { sales: 1000, units: 100, refundUnits: 5, refundAmount: 50, adSpend: 80, fees: 250, cogs: 300, cogsOk: true, promo: 10, netProfit: 200 };
const l7 = { sales: 700, units: 70, refundUnits: 7, refundAmount: 35, adSpend: 70, fees: 175, cogs: 210, cogsOk: true, promo: 7, netProfit: 140 };

// September: 30 days; MTD through the 20th → 10 remaining, run rate 100/day.
const f = PC.forecastFrom(mtd, l7, '2026-09-20', '2026-09-21');
assert.strictEqual(f.sales, 2000, 'sales = 1000 + 100 × 10');
assert.strictEqual(f.units, 200);
assert.strictEqual(f.netProfit, 400, 'net = 200 + 20 × 10');
assert.strictEqual(f.adSpend, 180);
assert.strictEqual(f.fees, 500);
assert.strictEqual(f.cogs, 600);
assert.strictEqual(f.refundUnits, 15);
assert.strictEqual(f.estimated, true);
assert.ok(f.basis.includes('10 days'), f.basis);

// Last day of the month → nothing remaining, forecast = MTD.
const fEnd = PC.forecastFrom(mtd, l7, '2026-09-30', '2026-09-30');
assert.strictEqual(fEnd.sales, 1000);
assert.strictEqual(fEnd.netProfit, 200);

// 31-day month.
assert.strictEqual(PC.forecastFrom(mtd, l7, '2026-08-20', '2026-08-21').sales, 1000 + 100 * 11);

// Guardrails: <3 elapsed days, missing inputs, dead 7d window → null.
assert.strictEqual(PC.forecastFrom(mtd, l7, '2026-09-02', '2026-09-03'), null, 'needs 3 elapsed days');
assert.strictEqual(PC.forecastFrom(null, l7, '2026-09-20', '2026-09-21'), null);
assert.strictEqual(PC.forecastFrom(mtd, null, '2026-09-20', '2026-09-21'), null);
assert.strictEqual(PC.forecastFrom(mtd, { ...l7, sales: 0 }, '2026-09-20', '2026-09-21'), null, 'no recent sales → no forecast');

// Null components stay null rather than fabricating: fees unknown on either side.
const fNullFees = PC.forecastFrom({ ...mtd, fees: null, netProfit: null }, l7, '2026-09-20', '2026-09-21');
assert.strictEqual(fNullFees.fees, null);
assert.strictEqual(fNullFees.netProfit, null);
assert.strictEqual(fNullFees.sales, 2000, 'sales still forecast');

console.log('all forecast checks passed');
