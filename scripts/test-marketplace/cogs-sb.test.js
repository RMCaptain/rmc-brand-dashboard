'use strict';
// Sellerboard COGS derivation (sync/cogsSb.js) — median unit cost per
// (asin, marketplace), native currency, robust to lump non-sales cost days.
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { deriveUnitCogs } = require(ROOT + '/sync/cogsSb.js');
const { idByCode } = require(ROOT + '/sync/marketplaces.js');

const CA = idByCode('CA'), US = idByCode('US'), UK = idByCode('UK');

const rows = [
  // A1 on CA: unit cost 2.00 most days; one day carries a lump
  // missing-from-inbound component (30 for 2 units) — median shrugs it off.
  { date: '2026-09-01', mp_id: CA, asin: 'A1', units: 10, product_costs: 20 },
  { date: '2026-09-02', mp_id: CA, asin: 'A1', units: 5,  product_costs: 10 },
  { date: '2026-09-03', mp_id: CA, asin: 'A1', units: 2,  product_costs: 30 },
  { date: '2026-09-04', mp_id: CA, asin: 'A1', units: 4,  product_costs: 8 },
  { date: '2026-09-05', mp_id: CA, asin: 'A1', units: 8,  product_costs: 16 },
  // Zero-unit and zero-cost days never produce a sample.
  { date: '2026-09-06', mp_id: CA, asin: 'A1', units: 0,  product_costs: 12 },
  { date: '2026-09-07', mp_id: CA, asin: 'A1', units: 3,  product_costs: 0 },
  // Same ASIN, different marketplace = its own native-currency cost.
  { date: '2026-09-05', mp_id: US, asin: 'A1', units: 2, product_costs: 3 },
  { date: '2026-09-06', mp_id: UK, asin: 'A1', units: 4, product_costs: 6.4 },
  // Unknown marketplace id → skipped, not guessed.
  { date: '2026-09-05', mp_id: 'FAKE', asin: 'A1', units: 2, product_costs: 4 },
];

const out = deriveUnitCogs(rows);
assert.strictEqual(out.A1.CA.unit, 2);         // median of [2, 2, 15, 2, 2]
assert.strictEqual(out.A1.CA.currency, 'CAD');
assert.strictEqual(out.A1.CA.days, 5);
assert.strictEqual(out.A1.CA.asOf, '2026-09-05');
assert.strictEqual(out.A1.US.unit, 1.5);
assert.strictEqual(out.A1.US.currency, 'USD');
assert.strictEqual(out.A1.UK.unit, 1.6);
assert.strictEqual(out.A1.UK.currency, 'GBP');
assert.strictEqual(Object.keys(out.A1).length, 3);

// Even-count median averages the middle pair.
const even = deriveUnitCogs([
  { date: 'd1', mp_id: CA, asin: 'B', units: 1, product_costs: 2 },
  { date: 'd2', mp_id: CA, asin: 'B', units: 1, product_costs: 4 },
]);
assert.strictEqual(even.B.CA.unit, 3);

assert.deepStrictEqual(deriveUnitCogs([]), {});

console.log('sellerboard cogs checks passed');
