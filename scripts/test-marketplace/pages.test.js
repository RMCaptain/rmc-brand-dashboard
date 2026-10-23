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
const periodCardsSrc = fs.readFileSync(`${ROOT}/public/period-cards.js`, 'utf8');
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
    vm.runInContext(periodCardsSrc, w, { filename: 'period-cards.js' });
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
      assert.ok(html.includes('>Profit<') && html.includes('>Margin<'), `brands ${f}: profit/margin cells`);
      assert.ok(html.includes('>Returns<') && html.includes('>Return Rate<'), `brands ${f}: returns cells`);
      assert.ok(!html.includes('NaN'), `brands ${f}: no NaN in cards`);
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
    near(z1uk.revenue, 40 * gbp, 'products UK Z1 in CAD'); assert.strictEqual(z1uk.units, 4); near(z1uk.fees, 12 * gbp, 'UK fees'); near(z1uk.netProfit, 15 * gbp, 'UK net = Sellerboard per-slice netProfit (pure-SB slice, 2026-09-22 rule)');
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
    const presets = await fetch(`${BASE}/api/preset-metrics`).then(r => r.json());
    w.MpScope.state.fx = () => vm.runInContext('fxRate', w); w.MpScope.state.currency = () => vm.runInContext('currency', w);
    vm.runInContext(`brandCache = ${JSON.stringify(brandRes)}; fxRate = ${JSON.stringify(fx)}; customData = ${JSON.stringify(data)}; presetMetrics = ${JSON.stringify(presets)}; activePreset = 'custom'; allBrandsData = ${JSON.stringify(brandsRes.brands)};`, w);
    for (const f of ['all', 'CA', 'US', 'UK']) {
      w.MpScope.state.filter = f;
      vm.runInContext('renderBrand({ ...brandCache, metrics: customData.brands[brandCache.id] })', w);
      assert.ok(!w.document.getElementById('brandName').textContent.startsWith('Render error'), `brand.html ${f}: ${w.document.getElementById('brandName').textContent}`);
      const rows = w.document.getElementById('skuTable').innerHTML;
      const cards = w.document.getElementById('brandPeriodCards').innerHTML;
      if (f === 'UK') { const v = 'CA$' + (40 * gbp).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); assert.ok(rows.includes(v), 'brand UK row'); assert.ok(!rows.includes('⚑'), 'no badges'); }
      if (f === 'all') {
        assert.ok(rows.includes('UK') && rows.includes('US') && rows.includes('CA'), 'brand all badges');
        // Tiles follow the Period selection: with a custom range active they
        // collapse to the one ringed custom card (same model as the dashboard).
        assert.ok(cards.includes('Custom range'), `custom collapse card: ${cards.slice(0, 200)}`);
        assert.ok(!cards.includes('Month to date'), 'tile set hidden under custom');
        // Switch to an in-set preset: tile set returns, selected tile ringed.
        // Stub presets (zellies CA): MTD sales 1,000 exact SB net 200; last
        // month 3,000; forecast = 1000 + (700/7) × remaining days when ≥3 in.
        vm.runInContext(`activePreset = 'mtd'; renderBrand({ ...brandCache, metrics: presetMetrics.presets.mtd.brands[brandCache.id] })`, w);
        const tcards = w.document.getElementById('brandPeriodCards').innerHTML;
        assert.ok(tcards.includes('Month to date') && tcards.includes('CA$1,000.00'), `mtd card: ${tcards.match(/CA\$[\d.,]+/g)}`);
        assert.ok(tcards.includes('Last month') && tcards.includes('CA$3,000.00'), 'last month card');
        assert.ok(tcards.includes('This month (forecast)'), 'forecast card present');
        assert.ok(tcards.includes('box-shadow'), 'selected preset tile is ringed');
        const end = presets.presets.mtd.endDate;
        const elapsed = Number(end.slice(8, 10));
        if (elapsed >= 3) {
          const dim = new Date(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0).getDate();
          const fSales = 1000 + 100 * (dim - elapsed);
          assert.ok(tcards.includes('CA$' + fSales.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), `forecast sales ${fSales}: ${tcards.match(/CA\$[\d.,]+/g)}`);
          assert.ok(tcards.includes('last 7d avg'), 'forecast basis note');
        } else {
          assert.ok(tcards.includes('needs 3+'), 'forecast guardrail note');
        }
        assert.ok(tcards.includes('Today') && tcards.includes('loading…'), 'today card placeholder without live data');
        vm.runInContext(`activePreset = 'custom'`, w);
      }
    }
    console.log('brand.html: OK (all/CA/US/UK + period cards)');
  }

  // ── /api/fees — fee breakdown + Sellerboard-vs-Amazon recon source ──
  {
    const acct = await fetch(`${BASE}/api/fees?from=${from}&to=${to}`).then(r => r.json());
    const ca = acct.sb.byMp.CA;
    near(ca.types.commission, -49, 'fees acct: SB commission');
    near(ca.types.fbaperunitfulfillmentfee, -33, 'fees acct: SB FBA per-unit');
    near(ca.types.reversal_reimbursement, 2, 'fees acct: SB reimbursement kept positive');
    near(ca.amazonFees, 82, 'fees acct: SB netted fees');
    near(ca.adSplit.sp, 7, 'fees acct: SB ad split');
    near(acct.sb.byMp.UK.types.amazonfees, -12, 'fees acct: condensed UK aggregate');
    assert.strictEqual(acct.amz.scope, 'account');
    near(acct.amz.byMp.CA.fees, 77, 'fees acct: AMZ per-item fees');
    near(acct.amz.byMp.CA.serviceFees, 27, 'fees acct: AMZ service fees');
    near(acct.amz.byMp.CA.groups['Referral Fee'], 47, 'fees acct: AMZ referral group');
    near(acct.amz.byMp.CA.groups.Storage, 9, 'fees acct: AMZ storage group');
    near(acct.amz.byMp.US.fees, 30, 'fees acct: AMZ US fees');

    const brand = await fetch(`${BASE}/api/fees?from=${from}&to=${to}&brandId=acure`).then(r => r.json());
    assert.strictEqual(brand.amz.scope, 'brand');
    near(brand.sb.byMp.CA.types.commission, -44, 'fees brand: SB commission acure only');
    near(brand.amz.byMp.CA.fees, 68, 'fees brand: AMZ A1 fees only');
    near(brand.amz.byMp.CA.groups['Referral Fee'], 42, 'fees brand: AMZ referral group');
    assert.strictEqual(brand.amz.byMp.CA.serviceFees, null, 'fees brand: service fees are account-level');
    assert.ok(!brand.sb.byMp.UK, 'fees brand: zellies UK rows excluded from acure');
    console.log('/api/fees: OK (account + brand scope)');
  }

  // ── Per-marketplace traffic + S&S scoping (Mike, 2026-10-23) ──
  {
    const CAid = 'A2EUQ1WTGCTBG2', USid = 'ATVPDKIKX0DER';
    const z = data.brands.zellies;
    assert.strictEqual(z.summary.byMp[CAid].sessions, 10, 'zellies CA summary sessions');
    near(z.summary.byMp[CAid].buyBox, 80, 'zellies CA summary buy box');
    assert.strictEqual(z.summary.byMp[USid].sessions, 20, 'zellies US summary sessions');
    const z1 = z.skus.find(s => s.asin === 'Z1');
    assert.strictEqual(z1.byMp[CAid].sessions, 10, 'Z1 CA slice sessions');
    near(z1.byMp[USid].buyBox, 85, 'Z1 US slice buy box');
    const a = data.brands.acure;
    near(a.summary.byMp[CAid].buyBox, (90 + 95 + 92) / 3, 'acure CA summary buy box avg');
    assert.strictEqual(a.summary.byMp[CAid].sessions, 135, 'acure CA summary sessions');

    // Client scoping helpers against the same payload shapes.
    const store = { currency: 'CAD' };
    const w = makeWindow(store);
    vm.createContext(w);
    vm.runInContext(mpScopeSrc, w, { filename: 'mp-scope.js' });
    w.MpScope.state.registry = mps;
    w.MpScope.state.fx = () => fx; w.MpScope.state.currency = () => 'CAD';
    const zBrand = brandsRes.brands.find(b => b.id === 'zellies');
    w.MpScope.state.filter = 'all';
    assert.strictEqual(w.MpScope.snsFor(zBrand), 12, 'S&S all = summed view');
    assert.strictEqual(w.MpScope.trafficOf(z.summary).sessions, z.summary.sessions ?? null, 'traffic all = blended');
    w.MpScope.state.filter = 'CA';
    assert.strictEqual(w.MpScope.snsFor(zBrand), 5, 'S&S CA scoped');
    assert.strictEqual(w.MpScope.snsFor(zBrand, 'Z1'), 5, 'S&S CA per-ASIN');
    assert.strictEqual(w.MpScope.trafficOf(z.summary).sessions, 10, 'traffic CA sessions');
    near(w.MpScope.trafficOf(z.summary).buyBox, 80, 'traffic CA buy box');
    w.MpScope.state.filter = 'US';
    assert.strictEqual(w.MpScope.snsFor(zBrand), 7, 'S&S US scoped');
    near(w.MpScope.trafficOf(z1).buyBox, 85, 'sku traffic US buy box');
    w.MpScope.state.filter = 'UK';
    assert.strictEqual(w.MpScope.snsFor(zBrand), null, 'S&S UK: no store → dash, never blended');
    assert.strictEqual(w.MpScope.trafficOf(z.summary).sessions, null, 'traffic UK: no rows → dash');
    console.log('per-marketplace traffic + S&S: OK');
  }

  // ── /api/ppc — PPC page data (SP from daily_metrics 7d-attr, SB/SD from daily_brand_ads) ──
  {
    const ppc = await fetch(`${BASE}/api/ppc?from=${from}&to=${to}`).then(r => r.json());
    const ac = ppc.brands.find(b => b.brandId === 'acure');
    near(ac.sp.spendCad, 12, 'ppc: acure SP spend');
    near(ac.sp.salesCad, 32, 'ppc: acure SP sales (7d attr with 14d fallback)');
    near(ac.sb.spendCad, 6, 'ppc: acure SB spend');
    near(ac.sd.salesCad, 8, 'ppc: acure SD sales');
    near(ac.revCad, 260, 'ppc: acure total revenue');
    assert.strictEqual(ac.sb.clicks, 10, 'ppc: acure SB clicks');
    const zl = ppc.brands.find(b => b.brandId === 'zellies');
    near(zl.sp.spendUsd, 10, 'ppc: zellies US SP spend');
    near(zl.sp.salesUsd, 40, 'ppc: zellies US SP sales');
    const d2row = ppc.daily.find(d => d.date === pstSubtractDays(to, 1));
    near(d2row.spendCad, 9, 'ppc daily: SP + SB spend summed');
    near(d2row.salesCad, 38, 'ppc daily: SP + SB sales summed');
    const camps = await fetch(`${BASE}/api/ppc/campaigns`).then(r => r.json());
    assert.ok(Array.isArray(camps.campaigns), 'ppc campaigns: shape holds without seed data');
    console.log('/api/ppc: OK');
  }

  // ── report-render.js ──
  {
    const w = makeWindow({});
    vm.createContext(w);
    vm.runInContext(fs.readFileSync(`${ROOT}/public/report-render.js`, 'utf8'), w, { filename: 'report-render.js' });
    const zb = data.brands.zellies;
    const d = { summary: zb.summary, summaryPrev: null, products: zb.skus, orders: null, coverage: {}, period: { from, to }, snsSubs: 0, repeatPurchase: null, fx };
    const tiles = vm.runInContext('SHARED_RENDERERS.headline_tiles', w)(d);
    assert.ok(tiles.includes('Amazon.co.uk (£)') && tiles.includes('£40'), `report tiles: ${tiles.match(/Revenue — [^<]+/g)}`);
    assert.ok(tiles.includes('Amazon.com (US$)') && tiles.includes('Amazon.ca (CA$)'), 'report CA/US tiles');
    // Combined like-currency tile: CA 30 + US 120×usd + UK 40×gbp, in CAD.
    const combined = 30 + 120 * usd + 40 * gbp;
    assert.ok(tiles.includes('All Marketplaces (CA$)'), 'combined tile present');
    assert.ok(tiles.includes('CA$' + Math.round(combined).toLocaleString('en-US')), `combined value ${combined}: ${tiles.match(/CA\$[\d,.]+/g)}`);
    assert.ok(tiles.includes('converted to CAD'), 'conversion is labelled');
    const top = vm.runInContext('SHARED_RENDERERS.top_sellers', w)(d);
    assert.ok(top.includes('Rev UK £') && top.includes('Rev CA CA$') && top.includes('Rev US US$'), `report columns: ${top.match(/Rev [^<]+/g)}`);
    console.log('report-render.js: OK');
  }
  console.log('ALL PAGE CHECKS PASS');
})().catch(e => { console.error('PAGES HARNESS FAIL:', e.stack || e.message); process.exit(1); });
