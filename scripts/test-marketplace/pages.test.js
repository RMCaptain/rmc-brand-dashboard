'use strict';
// Render brands.html / products.html / brand.html / report-render.js against
// the stub server's real payloads under every marketplace scope.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const BASE = process.argv[2] || 'http://127.0.0.1:3632';
const ROOT = require('path').resolve(__dirname, '..', '..') + '';

function stubEl() {
  const el = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false }, style: {}, dataset: {}, value: '', textContent: '', title: '', checked: false, href: '',
    querySelector: () => null, querySelectorAll: () => [], insertBefore() {}, appendChild() {}, removeChild() {}, remove() {}, firstChild: null, addEventListener() {}, options: [],
    insertAdjacentElement() {}, insertAdjacentHTML() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }), setAttribute() {}, getAttribute: () => null, focus() {}, select() {} };
  return el;
}
function makeWindow(store) {
  const els = {};
  const document = { title: '', getElementById: id => (els[id] || (els[id] = stubEl())), querySelector: () => null, querySelectorAll: () => [], createElement: () => stubEl(), addEventListener() {}, body: stubEl(), documentElement: stubEl() };
  const localStorage = { getItem: k => store[k] ?? null, setItem(k, v) { store[k] = String(v); }, removeItem(k) { delete store[k]; } };
  const w = { document, localStorage, location: { href: '', search: '?id=zellies' }, Chart: class { destroy() {} }, fetch: () => new Promise(() => {}), console, setTimeout, clearTimeout, setInterval, clearInterval, Intl, Date, Math, JSON, Object, Array, Number, String, Set, Map, Promise, URLSearchParams, Notification: undefined, encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat, alert() {}, confirm: () => false, requestAnimationFrame: f => f(), navigator: { userAgent: 'x' } };
  w.window = w; w.globalThis = w; w.self = w;
  return w;
}
const inline = p => fs.readFileSync(`${ROOT}/public/${p}`, 'utf8').match(/<script>([\s\S]*?)<\/script>/g).map(s => s.replace(/<\/?script>/g, '')).join('\n');
const mpScopeSrc = fs.readFileSync(`${ROOT}/public/mp-scope.js`, 'utf8');
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.01, `${what}: ${a} vs ${b}`);

(async () => {
  const { pstDateStr, pstSubtractDays } = require(ROOT + '/sync/dateUtils.js');
  const to = pstSubtractDays(pstDateStr(), 1), from = pstSubtractDays(to, 2);
  const [brandsRes, fx, data, mps, brandRes] = await Promise.all([
    fetch(`${BASE}/api/brands`).then(r => r.json()),
    fetch(`${BASE}/api/fx`).then(r => r.json()),
    fetch(`${BASE}/api/metrics?from=${from}&to=${to}`).then(r => r.json()),
    fetch(`${BASE}/api/marketplaces`).then(r => r.json()),
    fetch(`${BASE}/api/brands/zellies`).then(r => r.json()),
  ]);
  const gbp = fx.toCad.GBP, usd = fx.toCad.USD;

  function boot(page, store) {
    const w = makeWindow(store);
    vm.createContext(w);
    vm.runInContext(mpScopeSrc, w, { filename: 'mp-scope.js' });
    vm.runInContext(inline(page), w, { filename: page });
    w.MpScope.state.registry = mps;
    return w;
  }

  // ── brands.html ──
  {
    const store = { brandPreset: 'custom', customFrom: from, customTo: to, currency: 'CAD' };
    const w = boot('brands.html', store);
    w.MpScope.state.fx = () => vm.runInContext('fxRate', w); w.MpScope.state.currency = () => vm.runInContext('currency', w);
    vm.runInContext(`brandsData = ${JSON.stringify(brandsRes.brands)}; fxRate = ${JSON.stringify(fx)}; customData = ${JSON.stringify(data)}; activePreset = 'custom';`, w);
    for (const f of ['all', 'CA', 'US', 'UK']) {
      w.MpScope.state.filter = f;
      vm.runInContext('renderPerformance()', w);
      const html = w.document.getElementById('brandsGrid').innerHTML;
      assert.ok(html.includes('Zellies') && html.includes('Acure'), `brands ${f}: cards rendered`);
      if (f === 'UK') { assert.ok(html.includes('CA$' + (40 * gbp).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), `brands UK in CAD: ${html.match(/CA\$[\d.,]+/g)}`); assert.ok(!html.includes('£'), 'no native currency'); }
      if (f === 'CA') { assert.ok(html.includes('CA$380.00') && html.includes('CA$30.00'), 'brands CA revenue'); assert.ok(!html.includes('⚑') && !html.includes('Sellerboard'), 'reconciliation is not user-facing'); }
      if (f === 'all') { const allZ = 30 + 120 * usd + 40 * gbp; assert.ok(html.includes('CA$' + allZ.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), `brands all Zellies: ${html.match(/CA\$[\d.,]+/g)}`); }
    }
    console.log('brands.html: OK (all/CA/US/UK)');
  }

  // ── products.html ──
  {
    const store = { brandPreset: 'custom', customFrom: from, customTo: to, currency: 'CAD', productsTab: 'performance' };
    const w = boot('products.html', store);
    w.MpScope.state.fx = () => vm.runInContext('fxRate', w); w.MpScope.state.currency = () => vm.runInContext('currency', w);
    vm.runInContext(`brandsData = ${JSON.stringify(brandsRes.brands)}; fxRate = ${JSON.stringify(fx)}; customData = ${JSON.stringify(data)}; presetMetrics = { presets: {} }; activePreset = 'custom'; activeTab = 'performance';`, w);
    const rowsUnder = f => { w.MpScope.state.filter = f; return vm.runInContext('buildProductList()', w); };
    const all = rowsUnder('all');
    const a1 = all.find(r => r.asin === 'A1'), z1 = all.find(r => r.asin === 'Z1');
    near(a1.revenue, 380, 'products all A1 rev'); assert.strictEqual(a1.units, 38);
    near(a1.fees, 98, 'products all A1 fees'); assert.ok(a1.flags.length >= 2, 'A1 flags');
    near(a1.netProfit, 380 - 38 * 2 - 98 - 12 - 11, 'A1 net (cogs 2/u, posted refunds 10+1 fee)');
    near(z1.revenue, 30 + 120 * usd + 40 * gbp, 'products all Z1 rev'); assert.strictEqual(z1.units, 13);
    assert.deepStrictEqual(z1.marketplaces.sort(), ['CA', 'UK', 'US']);
    const uk = rowsUnder('UK');
    const z1uk = uk.find(r => r.asin === 'Z1');
    near(z1uk.revenue, 40 * gbp, 'products UK Z1 in CAD'); assert.strictEqual(z1uk.units, 4); near(z1uk.fees, 12 * gbp, 'UK fees'); near(z1uk.netProfit, (40 - 8 - 12 - 1) * gbp, 'UK net');
    assert.strictEqual(uk.find(r => r.asin === 'A1').revenue, 0);
    const us = rowsUnder('US');
    near(us.find(r => r.asin === 'Z1').revenue, 120 * usd, 'products US Z1 in CAD'); assert.strictEqual(us.find(r => r.asin === 'Z1').source, 'amazon');
    for (const f of ['all', 'CA', 'US', 'UK']) { w.MpScope.state.filter = f; vm.runInContext('render()', w); }
    const html = w.document.getElementById('productTableBody').innerHTML;
    assert.ok(!html.includes('£') && !html.includes('⚑'), 'toggle currency only, no badges');
    console.log('products.html: OK (all/CA/US/UK)');
  }

  // ── brand.html ──
  {
    const store = { brandPreset: 'custom', customFrom: from, customTo: to, currency: 'CAD' };
    const w = boot('brand.html', store);
    w.MpScope.state.fx = () => vm.runInContext('fxRate', w); w.MpScope.state.currency = () => vm.runInContext('currency', w);
    vm.runInContext(`brandCache = ${JSON.stringify(brandRes)}; fxRate = ${JSON.stringify(fx)}; customData = ${JSON.stringify(data)}; presetMetrics = { presets: {} }; activePreset = 'custom'; allBrandsData = ${JSON.stringify(brandsRes.brands)};`, w);
    for (const f of ['all', 'CA', 'US', 'UK']) {
      w.MpScope.state.filter = f;
      vm.runInContext('renderBrand({ ...brandCache, metrics: customData.brands[brandCache.id] })', w);
      assert.ok(!w.document.getElementById('brandName').textContent.startsWith('Render error'), `brand.html ${f}: ${w.document.getElementById('brandName').textContent}`);
      const tiles = w.document.getElementById('summaryTiles').innerHTML;
      const rows = w.document.getElementById('skuTable').innerHTML;
      if (f === 'UK') { const v = 'CA$' + (40 * gbp).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); assert.ok(tiles.includes(v), `brand UK tile: ${tiles.match(/CA\$[\d.,]+/g)}`); assert.ok(rows.includes(v), 'brand UK row'); assert.ok(!tiles.includes('Sellerboard') && !rows.includes('⚑'), 'no badges'); }
      if (f === 'US') { const v = 'CA$' + (120 * usd).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); assert.ok(tiles.includes(v), `brand US tile: ${tiles.match(/CA\$[\d.,]+/g)}`); }
      if (f === 'CA') { assert.ok(tiles.includes('CA$30.00'), 'brand CA tile'); }
      if (f === 'all') { assert.ok(rows.includes('UK') && rows.includes('US') && rows.includes('CA'), 'brand all badges'); }
    }
    console.log('brand.html: OK (all/CA/US/UK)');
  }

  // ── report-render.js ──
  {
    const w = makeWindow({});
    vm.createContext(w);
    vm.runInContext(fs.readFileSync(`${ROOT}/public/report-render.js`, 'utf8'), w, { filename: 'report-render.js' });
    const zb = data.brands.zellies;
    const d = { summary: zb.summary, summaryPrev: null, products: zb.skus, orders: null, coverage: {}, period: { from, to }, snsSubs: 0, repeatPurchase: null };
    const tiles = vm.runInContext('SHARED_RENDERERS.headline_tiles', w)(d);
    assert.ok(tiles.includes('Amazon.co.uk (£)') && tiles.includes('£40'), `report tiles: ${tiles.match(/Revenue — [^<]+/g)}`);
    assert.ok(tiles.includes('Amazon.com (US$)') && tiles.includes('Amazon.ca (CA$)'), 'report CA/US tiles');
    const top = vm.runInContext('SHARED_RENDERERS.top_sellers', w)(d);
    assert.ok(top.includes('Rev UK £') && top.includes('Rev CA CA$') && top.includes('Rev US US$'), `report columns: ${top.match(/Rev [^<]+/g)}`);
    console.log('report-render.js: OK');
  }
  console.log('ALL PAGE CHECKS PASS');
})().catch(e => { console.error('PAGES HARNESS FAIL:', e.stack || e.message); process.exit(1); });
