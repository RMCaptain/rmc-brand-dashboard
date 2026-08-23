#!/usr/bin/env node
/**
 * Dashboard render regression test — catches runtime errors in index.html's
 * render functions that no syntax check can (e.g. block-scoped variable read
 * outside its scope → ReferenceError, which froze the products table on
 * 2026-08-23). Evaluates the page's inline scripts with a stub DOM, feeds
 * them REAL API payloads, and calls every render path.
 *
 * Needs the server running locally:  $env:PORT=3600; node server.js
 *   node scripts/test-dashboard-render.js [baseUrl]   # default http://127.0.0.1:3600
 */
const fs = require('fs');
const path = require('path');

const BASE = process.argv[2] || 'http://127.0.0.1:3600';

function stubEl() {
  return {
    _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    style: {}, dataset: {}, value: '', textContent: '', title: '', checked: false,
    querySelector: () => null, querySelectorAll: () => [],
    insertBefore() {}, appendChild() {}, removeChild() {}, remove() {},
    firstChild: null, addEventListener() {},
  };
}
const els = {};
global.document = {
  getElementById: id => (els[id] || (els[id] = stubEl())),
  querySelector: () => null, querySelectorAll: () => [],
  createElement: () => stubEl(), addEventListener() {}, body: stubEl(),
};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { href: '', search: '' };
global.window = global;
global.Chart = class { constructor() {} destroy() {} };
const realFetch = global.fetch;
global.fetch = () => new Promise(() => {}); // neuter page init

const ymd = d => d.toISOString().split('T')[0];

(async () => {
  const to = ymd(new Date(Date.now() - 864e5));
  const from = ymd(new Date(Date.now() - 15 * 864e5));
  const [brandsRes, fx, customData, yesterdayData, todayData] = await Promise.all([
    realFetch(`${BASE}/api/brands`).then(r => r.json()),
    realFetch(`${BASE}/api/fx`).then(r => r.json()).catch(() => ({ usdToCad: 1.35 })),
    realFetch(`${BASE}/api/metrics?from=${from}&to=${to}`).then(r => r.json()),
    realFetch(`${BASE}/api/metrics/yesterday`).then(r => r.json()),
    realFetch(`${BASE}/api/metrics/today`).then(r => r.json()),
  ]);
  global.__DATA = { brands: brandsRes.brands || brandsRes, fx, customData, yesterdayData, todayData, from, to };

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // Bare <script> tags only — external scripts are <script src=...> and never
  // match. Do NOT filter block bodies on 'src=' (they build <img src=...>).
  const src = html.match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script>/g, '')).join('\n');

  const driver = `
;brandsData = __DATA.brands;
fxRate = __DATA.fx;
customTableData = __DATA.customData;
yesterdayTableData = __DATA.yesterdayData;
todayTableData = __DATA.todayData;
customFrom = __DATA.from; customTo = __DATA.to;
let __failures = 0;
for (const preset of ['custom', 'yesterday', 'today']) {
  activeBrandPreset = preset;
  for (const fn of [renderTiles, renderBrandTable, renderProductTable]) {
    try { fn(); console.log(preset + ' / ' + fn.name + ': OK'); }
    catch (e) { __failures++; console.error(preset + ' / ' + fn.name + ' THREW: ' + e.stack.split('\\n')[0]); }
  }
}
if (__failures) { console.error(__failures + ' render failure(s)'); process.exitCode = 1; }
else console.log('ALL RENDER PATHS PASS');
`;
  eval(src + driver);
})().catch(e => { console.error('HARNESS FAIL:', e.message); process.exit(1); });
