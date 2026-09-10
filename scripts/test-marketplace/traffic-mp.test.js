'use strict';
// trafficRows + replaceDay group config (sync/metricsMp.js) — the Phase 2b
// step-1 traffic writer. Pure unit: no DB.
const assert = require('assert');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { trafficRows } = require(ROOT + '/sync/metricsMp.js');
const { idByCode } = require(ROOT + '/sync/marketplaces.js');

const CA = idByCode('CA'), US = idByCode('US'), UK = idByCode('UK');

const stByMp = {
  [CA]: {
    A1: { sessions: 50, pageViews: 60, buyBox: 90.5 },
    A2: { sessions: 0, pageViews: 0, buyBox: null },      // no traffic → no row
  },
  [US]: {
    A1: { sessions: 20, pageViews: 25, buyBox: 88 },
  },
  [UK]: {
    Z1: { sessions: 7, pageViews: 9, buyBox: null },      // non-wide mp still emits
  },
  'FAKE-MP': { A1: { sessions: 5, pageViews: 5, buyBox: 1 } }, // unknown id → skipped
};

const rows = trafficRows('2026-09-09', stByMp, { A1: 'acure', Z1: 'zellies' });
assert.strictEqual(rows.length, 3);

const caRow = rows.find(r => r.mp_id === CA);
assert.deepStrictEqual(caRow, {
  date: '2026-09-09', asin: 'A1', mp_id: CA, currency: 'CAD', brand_id: 'acure',
  sessions: 50, page_views: 60, buy_box_pct: 90.5,
});
const usRow = rows.find(r => r.mp_id === US);
assert.strictEqual(usRow.currency, 'USD');
assert.strictEqual(usRow.sessions, 20);
const ukRow = rows.find(r => r.mp_id === UK);
assert.strictEqual(ukRow.currency, 'GBP');
assert.strictEqual(ukRow.brand_id, 'zellies');
assert.strictEqual(ukRow.buy_box_pct, null);

// Sessions can be a real 0 while page views exist (bot traffic filtering) —
// row still emits, sessions kept as 0, not dropped.
const partial = trafficRows('2026-09-09', { [CA]: { B1: { sessions: 0, pageViews: 3, buyBox: null } } }, {});
assert.strictEqual(partial.length, 1);
assert.strictEqual(partial[0].sessions, 0);
assert.strictEqual(partial[0].brand_id, 'unknown-brand');

// replaceDay zero semantics: sessions/page_views zero to 0 (true zeros),
// buy box zeroes to NULL (absence = no data, 0% would be a lie).
const mpSrc = require('fs').readFileSync(ROOT + '/sync/metricsMp.js', 'utf8');
assert.ok(/traffic:\s*\{ sessions: 0, page_views: 0, buy_box_pct: null \}/.test(mpSrc));

console.log('traffic mp writer checks passed');
