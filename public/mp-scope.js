// mp-scope.js — the global marketplace picker + per-marketplace math shared by
// every dashboard page (brands, products, brand, dashboard, reports).
//
// CONTRACT: classic script, loads before the page's inline script, exposes
// window.MpScope. The selected scope lives in localStorage 'mpFilter' (a
// marketplace CODE like 'CA' / 'US' / 'UK' / 'WMCA', or 'all') so one choice
// follows the user across pages. Currency toggle stays in localStorage
// 'currency' and only means something in the All view — a single marketplace
// always shows its native currency.
//
// Money math: every server payload built by buildBrandMetricsForRange carries
// byMp = { [mp_id]: { code, currency, units, sales, adSpend, fees, … , source,
// flags } } on skus, brand summaries and financials. All view blends the
// marketplaces in scope through CAD using fx.toCad; a scoped view reads that
// marketplace's slice as-is. Payloads without byMp (Today / Yesterday) fall
// back to the legacy CAD/USD pair via legacyNum().
(function () {
  'use strict';
  const CUR_SYM = { CAD: 'CA$', USD: 'US$', GBP: '£' };
  const CUR_LOCALE = { CAD: 'en-CA', USD: 'en-US', GBP: 'en-GB' };
  const MP_BADGE = { CA: 'background:#1e3a5f;color:#60a5fa', US: 'background:#1a3a1a;color:#4ade80', UK: 'background:#3a1a2a;color:#f472b6', WMCA: 'background:#3a2a10;color:#fbbf24' };
  const FALLBACK_CUR = { CA: 'CAD', US: 'USD', UK: 'GBP', WMCA: 'CAD' };
  const FLAG_LABEL = { units: 'Units', sales: 'Sales', adSpend: 'Ad spend', refunds: 'Refunds', refundAmount: 'Refund $', fees: 'Fees', amazonFees: 'Fees' };
  const COUNT_METRICS = new Set(['units', 'refunds', 'refundCount', 'sbDays']);

  const state = {
    filter: (() => { try { return localStorage.getItem('mpFilter') || 'all'; } catch { return 'all'; } })(),
    registry: [],
    fx: () => null,
    currency: () => { try { return localStorage.getItem('currency') || 'CAD'; } catch { return 'CAD'; } },
    datasets: () => [],
    onChange: null,
    ready: false,
  };

  const byCode = code => state.registry.find(m => m.code === code) || null;
  const scoped = () => state.filter !== 'all';
  function displayCurrency() {
    if (!scoped()) return state.currency();
    return byCode(state.filter)?.currency || FALLBACK_CUR[state.filter] || 'CAD';
  }
  const curSym = () => CUR_SYM[displayCurrency()] || (displayCurrency() + ' ');
  const locale = () => CUR_LOCALE[displayCurrency()] || 'en-CA';

  function toCadRate(cur) {
    const fx = state.fx() || {};
    if (fx.toCad && fx.toCad[cur] != null) return fx.toCad[cur];
    if (cur === 'CAD') return 1;
    if (cur === 'USD') return fx.usdToCad || 1.38;
    return 1;
  }
  function toDisplay(v, cur) {
    const dc = displayCurrency();
    if (!v) return 0;
    if (cur === dc) return v;
    const inCad = v * toCadRate(cur);
    return dc === 'CAD' ? inCad : inCad / toCadRate(dc);
  }
  // Legacy CAD/USD pair → display value under the current scope.
  function legacyNum(cad, usd) {
    if (state.filter === 'CA') return cad || 0;
    if (state.filter === 'US') return usd || 0;
    if (scoped()) return 0;
    return toDisplay(cad || 0, 'CAD') + toDisplay(usd || 0, 'USD');
  }
  function fmt(v, opts = {}) {
    if (v == null || isNaN(v)) return '—';
    const abs = opts.abs ? Math.abs(v) : v;
    return curSym() + abs.toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  // Native-currency formatter (a marketplace's own symbol regardless of scope).
  function fmtIn(v, cur) {
    if (v == null || isNaN(v)) return '—';
    return (CUR_SYM[cur] || cur + ' ') + v.toLocaleString(CUR_LOCALE[cur] || 'en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function scopedMps(byMp) {
    return Object.values(byMp || {}).filter(m => !scoped() || m.code === state.filter);
  }
  function sumMp(byMp, metric) {
    let total = 0, any = false;
    const isCount = COUNT_METRICS.has(metric);
    for (const m of scopedMps(byMp)) {
      if (m[metric] == null) continue;
      any = true;
      total += isCount ? m[metric] : toDisplay(m[metric], m.currency);
    }
    return any ? total : null;
  }
  function scopedFlags(byMp) {
    const out = [];
    for (const m of scopedMps(byMp)) for (const [metric, f] of Object.entries(m.flags || {})) out.push({ mp: m.code, metric, ...f });
    return out;
  }
  function sourceOf(byMp) {
    const set = new Set(scopedMps(byMp).map(m => m.source));
    if (!set.size) return null;
    return set.size === 1 ? [...set][0] : 'mixed';
  }
  function flagTitle(flags) {
    return flags.map(f => `${f.mp} ${FLAG_LABEL[f.metric] || f.metric}: Amazon ${f.amazon} vs Sellerboard ${f.sellerboard} (${f.delta > 0 ? '+' : ''}${f.delta}${f.deltaPct != null ? `, ${f.deltaPct}%` : ''})`).join('\n');
  }
  function flagBadge(flags, size = 'text-xs') {
    if (!flags || !flags.length) return '';
    return `<span class="${size} text-amber-400 cursor-help" title="Amazon and Sellerboard disagree on the days both have data. Sellerboard is shown.\n${flagTitle(flags)}">⚑${flags.length > 1 ? flags.length : ''}</span>`;
  }
  function sourceBadge(source) {
    if (!source) return '';
    const map = { sellerboard: ['Sellerboard', '#1a3a2a', '#4ade80'], mixed: ['Sellerboard + Amazon', '#3a2f1a', '#fbbf24'], amazon: ['Amazon', '#1e293b', '#94a3b8'] };
    const [label, bg, fg] = map[source] || map.amazon;
    return `<span style="background:${bg};color:${fg};font-size:9px;font-weight:600;padding:1px 6px;border-radius:3px;letter-spacing:0.04em" title="Source of the money metrics in this view. Sellerboard is shown wherever it has data; Amazon fills the rest.">${label}</span>`;
  }
  function mpBadge(code, extraStyle = '') {
    const s = MP_BADGE[code] || 'background:#2a2a2a;color:#888';
    return `<span style="${s};font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:0.05em;vertical-align:middle;display:inline-block;${extraStyle}">${code}</span>`;
  }
  const storefrontFor = code => byCode(code)?.storefront || (code === 'US' ? 'https://www.amazon.com' : code === 'UK' ? 'https://www.amazon.co.uk' : 'https://www.amazon.ca');
  const sellerCentralFor = code => byCode(code)?.sellerCentral || (code === 'US' ? 'https://sellercentral.amazon.com' : code === 'UK' ? 'https://sellercentral.amazon.co.uk' : 'https://sellercentral.amazon.ca');
  const labelFor = code => byCode(code)?.label || ({ CA: 'Amazon.ca', US: 'Amazon.com', UK: 'Amazon.co.uk', WMCA: 'Walmart.ca' })[code] || code;

  // COGS per unit for an ASIN on a marketplace code: per-marketplace buy cost
  // wins; the legacy single cost applies to the brand's home marketplace.
  function cogsFor(brand, asin, code) {
    const per = brand?.cogsPerMarketplace?.[asin]?.[code];
    if (per != null) return per;
    const home = (brand?.marketplace || 'CA').split(',')[0].trim();
    return code === home ? (brand?.cogs?.[asin] ?? 0) : 0;
  }
  // Marketplaces with activity on a sku's byMp, as codes.
  function activeCodes(byMp) {
    return Object.values(byMp || {}).filter(m => m.units > 0 || m.sales > 0 || m.adSpend > 0 || m.fees > 0).map(m => m.code);
  }

  // ── Picker UI ──
  function ensureSelect() {
    let sel = document.getElementById('mpSwitch');
    if (sel) return sel;
    const tog = document.querySelector('.cur-toggle');
    if (!tog || !tog.parentNode) return null;
    sel = document.createElement('select');
    sel.id = 'mpSwitch';
    sel.className = 'rmc-select';
    sel.style.cssText = 'width:auto;color-scheme:dark;font-size:12px;padding:6px 10px';
    sel.title = 'Marketplace';
    const all = document.createElement('option');
    all.value = 'all'; all.textContent = '🌐 All marketplaces';
    sel.appendChild(all);
    sel.addEventListener('change', () => setFilter(sel.value));
    tog.parentNode.insertBefore(sel, tog);
    return sel;
  }
  function updateUI() {
    const sel = document.getElementById('mpSwitch');
    if (sel && sel.value !== state.filter) sel.value = state.filter;
    const tog = document.querySelector('.cur-toggle');
    if (tog) {
      tog.style.opacity = scoped() ? '0.35' : '';
      tog.style.pointerEvents = scoped() ? 'none' : '';
      tog.title = scoped() ? 'Single marketplace shows its native currency' : '';
    }
  }
  function syncOptions() {
    const sel = ensureSelect();
    if (!sel) return;
    const present = new Set();
    for (const d of (state.datasets() || [])) for (const m of (d?.marketplaces || [])) present.add(m.code);
    // Options: registry actives, anything the loaded data carries, and the
    // persisted selection itself (so a UK choice survives a page whose data
    // hasn't arrived yet). A persisted code the registry has never heard of
    // is the only thing that falls back to All.
    const wanted = state.registry.filter(m => m.active || present.has(m.code) || m.code === state.filter);
    for (const code of present) if (!wanted.some(m => m.code === code)) wanted.push({ code, label: code, flag: '' });
    const options = () => Array.from(sel.options || []);
    const have = new Set(options().map(o => o.value));
    for (const m of wanted) {
      if (have.has(m.code)) continue;
      const opt = document.createElement('option');
      opt.value = m.code;
      opt.textContent = `${m.flag || ''} ${m.label}`.trim();
      sel.appendChild(opt);
      have.add(m.code);
    }
    if (state.filter !== 'all' && state.registry.length && !byCode(state.filter)) setFilter('all', { silent: true });
    updateUI();
  }
  function setFilter(v, { silent = false } = {}) {
    state.filter = v;
    try { localStorage.setItem('mpFilter', v); } catch {}
    updateUI();
    if (!silent && state.onChange) state.onChange(v);
  }
  async function init({ onChange, fx, currency, datasets } = {}) {
    if (onChange) state.onChange = onChange;
    if (fx) state.fx = fx;
    if (currency) state.currency = currency;
    if (datasets) state.datasets = datasets;
    ensureSelect();
    updateUI();
    try {
      state.registry = await fetch('/api/marketplaces').then(r => r.json());
    } catch (e) { console.warn('[MpScope] registry load failed:', e.message); }
    state.ready = true;
    syncOptions();
    return state.registry;
  }

  window.MpScope = {
    state, init, setFilter, syncOptions, updateUI,
    filter: () => state.filter, scoped, byCode, displayCurrency, curSym, locale,
    toCadRate, toDisplay, legacyNum, fmt, fmtIn,
    scopedMps, sumMp, scopedFlags, sourceOf, flagBadge, sourceBadge, mpBadge,
    storefrontFor, sellerCentralFor, labelFor, cogsFor, activeCodes,
    CUR_SYM, CUR_LOCALE, MP_BADGE,
  };
})();
