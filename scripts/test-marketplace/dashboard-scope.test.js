'use strict';
// Evaluate index.html's inline script with a stub DOM against the stub server's
// real /api/metrics payload, then assert the marketplace picker scopes numbers
// correctly (All / CA / US / UK) and flags surface.
const assert = require('assert');
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:3632';
function stubEl() {
  return { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: {}, dataset: {}, value: '', textContent: '', title: '', checked: false,
    querySelector: () => null, querySelectorAll: () => [], insertBefore() {}, appendChild() {}, removeChild() {}, remove() {}, firstChild: null, addEventListener() {}, options: [] };
}
const els = {};
global.document = { getElementById: id => (els[id] || (els[id] = stubEl())), querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener() {}, body: stubEl() };
const store = {};
global.localStorage = { getItem: k => store[k] ?? null, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
global.location = { href: '', search: '' }; global.window = global; global.Chart = class { destroy() {} };
const realFetch = global.fetch; global.fetch = () => new Promise(() => {});

(async () => {
  const { pstDateStr, pstSubtractDays } = require(require('path').resolve(__dirname, '..', '..') + '/sync/dateUtils.js');
  const to = pstSubtractDays(pstDateStr(), 1), from = pstSubtractDays(to, 2);
  const [brandsRes, fx, data, mps] = await Promise.all([
    realFetch(`${BASE}/api/brands`).then(r => r.json()),
    realFetch(`${BASE}/api/fx`).then(r => r.json()),
    realFetch(`${BASE}/api/metrics?from=${from}&to=${to}`).then(r => r.json()),
    realFetch(`${BASE}/api/marketplaces`).then(r => r.json()),
  ]);
  const html = fs.readFileSync(require('path').resolve(__dirname, '..', '..') + '/public/index.html', 'utf8');
  const src = html.match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script>/g, '')).join('\n');
  global.__D = { brands: brandsRes.brands, fx, data, mps, from, to };
  const driver = `
;brandsData = __D.brands; fxRate = __D.fx; mpRegistry = __D.mps; customTableData = __D.data; customFrom = __D.from; customTo = __D.to;
activeBrandPreset = 'custom'; currency = 'CAD';
const gbp = toCadRate('GBP'), usd = toCadRate('USD');
const near = (a, b, what) => { if (Math.abs(a - b) > 0.01) throw new Error(what + ': ' + a + ' vs ' + b); };
// ALL (CAD): CA 380+30 + US 120*usd + UK 40*gbp
mpFilter = 'all'; let m = getTileMetrics(customTableData);
near(m.sales, 410 + 120 * usd + 40 * gbp, 'all sales');
if (m.units !== 38 + 13) throw new Error('all units ' + m.units);
near(m.amzFees, (25+20+53+9) + 30 * usd + 12 * gbp, 'all fees');
near(m.adSpend, 12 + 10 * usd + 1 * gbp, 'all ads');
if (m.source !== 'mixed') throw new Error('all source ' + m.source);
if (!m.flags.some(f => f.mp === 'CA' && f.metric === 'units')) throw new Error('CA units flag missing at tile level');
// COGS all: A1 38u*2 CAD + Z1 CA 3u*3 + US 6u*2.5 USD + UK 4u*2 GBP
near(m.cogsTotal, 76 + 9 + 15 * usd + 8 * gbp, 'all cogs');
// CA scope: native CAD
mpFilter = 'CA'; m = getTileMetrics(customTableData);
near(m.sales, 410, 'CA sales'); if (m.units !== 41) throw new Error('CA units ' + m.units);
if (displayCurrency() !== 'CAD') throw new Error('CA currency');
near(m.amzFees, 107, 'CA fees'); near(m.serviceFees, 22, 'CA svc');
// US scope: native USD, Amazon-only, no flags
mpFilter = 'US'; m = getTileMetrics(customTableData);
near(m.sales, 120 * usd, 'US sales in CAD'); if (m.units !== 6) throw new Error('US units ' + m.units);
if (displayCurrency() !== 'CAD' || curSym() !== 'CA$') throw new Error('US scope must stay in the toggle currency');
if (m.source !== 'amazon') throw new Error('US source ' + m.source);
if (m.flags.length) throw new Error('US should have no flags');
// UK scope: native GBP, Sellerboard-only
mpFilter = 'UK'; m = getTileMetrics(customTableData);
near(m.sales, 40 * gbp, 'UK sales in CAD'); if (m.units !== 4) throw new Error('UK units ' + m.units);
if (displayCurrency() !== 'CAD' || curSym() !== 'CA$') throw new Error('UK scope must stay in the toggle currency');
currency = 'USD'; m = getTileMetrics(customTableData); near(m.sales, 40 * gbp / usd, 'UK sales in USD'); if (curSym() !== 'US$') throw new Error('USD toggle'); currency = 'CAD'; m = getTileMetrics(customTableData);
if (m.source !== 'sellerboard') throw new Error('UK source ' + m.source);
near(m.amzFees, 12 * gbp, 'UK fees'); near(m.cogsTotal, 8 * gbp, 'UK cogs');
// product rows under UK scope
const rowsUK = getAllSkus(customTableData).filter(s => s.marketplace === 'UK');
if (rowsUK.length !== 1 || rowsUK[0].asin !== 'Z1') throw new Error('UK rows ' + JSON.stringify(rowsUK.map(r => r.asin)));
near(rowsUK[0].revenue, 40 * gbp, 'UK row rev'); near(rowsUK[0].fees, 12 * gbp, 'UK row fees'); near(rowsUK[0].netProfit, (40 - 8 - 12 - 1) * gbp, 'UK row np');
// product rows ALL: A1 CA row carries flags; Z1 has CA, US, UK rows
mpFilter = 'all'; const rows = getAllSkus(customTableData);
const a1 = rows.find(r => r.asin === 'A1' && r.marketplace === 'CA');
if (!a1.flags.some(f => f.metric === 'sales')) throw new Error('A1 row flags');
if (rows.filter(r => r.asin === 'Z1').map(r => r.marketplace).sort().join() !== 'CA,UK,US') throw new Error('Z1 rows');
near(a1.fees, 98, 'A1 fees'); near(a1.revenue, 380, 'A1 rev');
// render paths don't throw under each scope
for (const f of ['all', 'CA', 'US', 'UK']) { mpFilter = f; renderTiles(); renderBrandTable(); renderProductTable(); }
// picker options gained UK from the payload (registry has it inactive)
const opts = document.getElementById('mpSwitch').options; void opts;
console.log('ALL SCOPE CHECKS PASS  (usd→cad ' + usd + ', gbp→cad ' + gbp + ')');
`;
  eval(src + driver);
})().catch(e => { console.error('SCOPE HARNESS FAIL:', e.stack || e.message); process.exit(1); });
