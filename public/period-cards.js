// Sellerboard-style period cards (Mike, 2026-09-22): colored-header columns —
// Today / Yesterday / Month to date / This month (forecast) / Last month by
// default — each a vertical P&L (Sales, Units, Refunds, Adv. cost, Est.
// payout, Gross/Net profit, expandable More with fees/COGS/promo/Margin/ROI).
// A tile-set dropdown (SB "Personalized tiles") persists in localStorage.
//
// Data: cached presets (Sellerboard-first byMp payloads) for everything but
// Today, which rides the live Amazon estimate endpoint (fees estimated, no
// refunds intraday — footnoted). Forecast = MTD actual + trailing-7-day
// run-rate × remaining days; guardrails: needs ≥3 elapsed days and 7d sales,
// one formula, clearly labeled. All values in the display currency, scoped
// by the global marketplace picker.
(function () {
  const LS_KEY = 'periodTiles';

  const TILE_SETS = [
    { id: 'sb-default', label: 'Today / Yesterday / Month to date / This month (forecast) / Last month', tiles: ['today', 'yesterday', 'mtd', 'forecast', 'lastMonth'] },
    { id: 'no-forecast', label: 'Today / Yesterday / Month to date / Last month', tiles: ['today', 'yesterday', 'mtd', 'lastMonth'] },
    { id: 'trailing', label: 'Today / Yesterday / 7 days / 14 days / 30 days', tiles: ['today', 'yesterday', 'last7d', 'last14d', 'last30d'] },
    { id: 'months', label: 'Month to date / Forecast / Last month / 60 days / 90 days', tiles: ['mtd', 'forecast', 'lastMonth', 'last60d', 'last90d'] },
    { id: 'ytd', label: 'Yesterday / Month to date / Last month / Year to date', tiles: ['yesterday', 'mtd', 'lastMonth', 'ytd'] },
  ];
  const PERIOD_LABEL = {
    today: 'Today', yesterday: 'Yesterday', mtd: 'Month to date', forecast: 'This month (forecast)',
    lastMonth: 'Last month', last7d: '7 days', last14d: '14 days', last30d: '30 days',
    last60d: '60 days', last90d: '90 days', ytd: 'Year to date', custom: 'Custom range',
  };
  // Header band colors: RMC brand-green ramp (light → deep) by position,
  // anchored on --brand #537D30 (Mike, 2026-09-26 — app palette, not SB's
  // blue→green sweep). Light text rides on every band.
  const BAND = ['#6FA845', '#5E9539', '#537D30', '#456928', '#385621'];
  const BAND_TEXT = '#F0F4FF', BAND_SUB = 'rgba(240,244,255,0.66)';
  // Interactive text on dark surfaces — --brand itself is too dark there.
  const LINK = '#8CBF5A';

  const r2 = v => Math.round(v * 100) / 100;

  function fmtRange(from, to) {
    const f = new Date(from + 'T00:00:00'), t = new Date(to + 'T00:00:00');
    const mo = d => d.toLocaleDateString('en-US', { month: 'long' });
    if (from === to) return `${mo(f)} ${f.getDate()}, ${f.getFullYear()}`;
    if (f.getMonth() === t.getMonth() && f.getFullYear() === t.getFullYear()) return `${mo(f)} ${f.getDate()}-${t.getDate()} ${f.getFullYear()}`;
    return `${mo(f)} ${f.getDate()} – ${mo(t)} ${t.getDate()}, ${t.getFullYear()}`;
  }

  const EMPTY = () => ({ sales: 0, units: 0, refundUnits: 0, refundAmount: 0, adSpend: 0, fees: null, cogs: 0, cogsOk: true, promo: 0, netProfit: null, estimated: false });

  // Aggregate one preset-shaped payload ({ brands: { id: { summary, skus } } })
  // across the brand scope into display-currency card metrics.
  function aggregate(payload, brandsMeta, scopeBrandId) {
    const M = window.MpScope;
    const out = EMPTY();
    if (!payload?.brands) return null;
    const ids = scopeBrandId ? [scopeBrandId] : Object.keys(payload.brands);
    let any = false;
    let npSb = 0, npAllSb = true, npAny = false, skuNetSum = 0;
    let unpricedRev = 0, unpricedCount = 0;
    for (const id of ids) {
      const bm = payload.brands[id];
      if (!bm?.summary) continue;
      any = true;
      const brand = (brandsMeta || []).find(b => b.id === id) || {};
      const by = bm.summary.byMp && Object.keys(bm.summary.byMp).length ? bm.summary.byMp : null;
      if (by) {
        out.sales   += M.sumMp(by, 'sales') || 0;
        out.units   += M.sumMp(by, 'units') || 0;
        out.adSpend += M.sumMp(by, 'adSpend') || 0;
        out.promo   += M.sumMp(by, 'promo') || 0;
        for (const m of M.scopedMps(by)) {
          if (m.fees != null) out.fees = (out.fees || 0) + M.toDisplay(m.fees, m.currency);
          out.refundAmount += M.toDisplay(m.refundAmount || 0, m.currency);
          out.refundUnits  += m.refunds || 0;
          if (M.activeSlice(m)) {
            npAny = true;
            if (m.source === 'sellerboard' && m.netProfit != null) npSb += M.toDisplay(m.netProfit, m.currency);
            else npAllSb = false;
          }
        }
      } else {
        const s = bm.summary;
        out.sales += M.legacyNum(s.revenueCad, s.revenueUsd);
        out.units += M.filter() === 'CA' ? (s.unitsCa || 0) : M.filter() === 'US' ? (s.unitsUs || 0) : M.scoped() ? 0 : (s.units || 0);
        out.refundAmount += M.legacyNum(s.refundAmountCad, s.refundAmountUsd);
        out.refundUnits  += s.refundedUnits || 0;
        npAllSb = false;
      }
      for (const sku of (bm.skus || [])) {
        const n = M.skuNet(brand, sku);
        out.cogs += n.cogs || 0;
        if (!n.cogsOk) out.cogsOk = false;
        if (!by) { out.adSpend += n.adSpend || 0; if (n.fees != null) out.fees = (out.fees || 0) + n.fees; }
        if (n.estimated) out.estimated = true;
        if (n.netProfit == null) { if ((n.rev || 0) > 0) { unpricedRev += n.rev; unpricedCount++; } }
        else skuNetSum += n.netProfit;
      }
    }
    if (!any) return null;
    out.exact = npAny && npAllSb;
    // Guardrail: component math tolerates a sliver of unpriceable ASINs
    // (missing unit cost / fees) — skip them and say so. Past 5% of sales
    // the number would be fiction, so show nothing instead.
    if (out.exact) out.netProfit = npSb;
    else if (unpricedRev <= Math.max(out.sales * 0.05, 100)) {
      out.netProfit = skuNetSum;
      if (unpricedCount) { out.estimated = true; out.note = `excl. ${unpricedCount} unpriced ASIN${unpricedCount > 1 ? 's' : ''}`; }
    } else {
      out.netProfit = null;
      out.note = `${unpricedCount} ASINs missing costs`;
    }
    return out;
  }

  // Forecast: MTD actual + last-7-full-days run-rate × remaining days.
  // Guardrails: null unless ≥3 elapsed MTD days and the 7d window sold; no
  // seasonality, no regression — one labeled formula. Pure; unit-tested.
  function forecastFrom(mtd, last7, mtdEnd, today) {
    if (!mtd || !last7 || !(last7.sales > 0)) return null;
    const end = new Date((mtdEnd || today) + 'T00:00:00');
    const elapsed = end.getDate();
    if (elapsed < 3) return null;
    const daysInMonth = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
    const remaining = Math.max(0, daysInMonth - elapsed);
    const scale = (a, b) => (a == null || b == null) ? null : r2(a + (b / 7) * remaining);
    const f = {
      sales: scale(mtd.sales, last7.sales),
      units: Math.round(scale(mtd.units, last7.units) || 0),
      refundUnits: Math.round(scale(mtd.refundUnits, last7.refundUnits) || 0),
      refundAmount: scale(mtd.refundAmount, last7.refundAmount),
      adSpend: scale(mtd.adSpend, last7.adSpend),
      fees: scale(mtd.fees, last7.fees),
      cogs: scale(mtd.cogs, last7.cogs),
      cogsOk: mtd.cogsOk && last7.cogsOk,
      promo: scale(mtd.promo, last7.promo),
      netProfit: scale(mtd.netProfit, last7.netProfit),
      estimated: true, exact: false,
      basis: `MTD + last 7d avg × ${remaining} day${remaining === 1 ? '' : 's'}`,
    };
    return f;
  }

  function selection() {
    try { const v = JSON.parse(localStorage.getItem(LS_KEY)); if (v?.tiles?.length) return v; } catch {}
    return { id: 'sb-default', tiles: TILE_SETS[0].tiles };
  }
  function saveSelection(sel) { try { localStorage.setItem(LS_KEY, JSON.stringify(sel)); } catch {} }

  // ── Card rendering ──────────────────────────────────────────────────────────
  const expandState = {};
  function money(v, { signCost = false } = {}) {
    const M = window.MpScope;
    if (v == null) return '<span style="color:var(--text-3)">—</span>';
    const neg = signCost ? v > 0 : v < 0;
    const abs = M.fmt(Math.abs(v));
    return (neg ? '-' : '') + abs;
  }
  function row(lbl, valHtml, color) {
    return `<div><p class="text-xs" style="color:var(--text-3)">${lbl}</p><p class="text-sm font-semibold" style="color:${color || 'var(--text)'}">${valHtml}</p></div>`;
  }

  function cardHtml(key, met, dates, idx, note, opts = {}) {
    const M = window.MpScope;
    const band = BAND[idx % BAND.length];
    const label = PERIOD_LABEL[key] || key;
    // Selectable cards (dashboard) drive the table below; the active one gets
    // a band-colored ring (the custom card is ringed but not clickable).
    // Forecast is a projection with no product rows, so it never selects.
    const ring = opts.active ? ` style="box-shadow:0 0 0 2px ${band}"` : '';
    const shell = opts.selectable
      ? `class="rmc-card overflow-hidden flex flex-col cursor-pointer" data-pc-card="${key}"${ring} title="Show ${label} in the table below"`
      : `class="rmc-card overflow-hidden flex flex-col"${ring}${opts.inPicker ? ` data-pc-card="${key}" title="No product-level data for a forecast — tiles only"` : ''}`;
    if (!met) {
      return `<div ${shell}>
        <div class="px-4 py-3" style="background:${band}"><p class="font-semibold" style="color:${BAND_TEXT}">${label}</p>
          <p class="text-xs" style="color:${BAND_SUB}">${dates || ''}</p></div>
        <div class="p-4 flex-1 flex items-center justify-center text-xs" style="color:var(--text-3)">${note || 'no data'}</div>
      </div>`;
    }
    const est = met.estimated ? '~' : '';
    const ev = v => v == null ? money(v) : est + money(v);   // no tilde on a dash
    const payout = met.fees != null ? met.sales - met.fees - met.refundAmount - met.adSpend - (met.promo || 0) : null;
    const npColor = met.netProfit == null ? undefined : met.netProfit >= 0 ? '#34d399' : '#f87171';
    const margin = met.netProfit != null && met.sales > 0 ? (met.netProfit / met.sales * 100).toFixed(1) + '%' : '—';
    const roi = met.netProfit != null && met.cogs > 0 ? (met.netProfit / met.cogs * 100).toFixed(0) + '%' : '—';
    const open = !!expandState[key];
    const more = open ? `
      <div class="grid grid-cols-2 gap-x-4 gap-y-2 pt-2" style="border-top:1px solid var(--border,#1f2937)">
        ${row('Amazon fees', met.fees == null ? money(null) : est + money(met.fees, { signCost: true }), met.fees > 0 ? '#f87171' : undefined)}
        ${row('Cost of goods', money(met.cogs, { signCost: true }) + (met.cogsOk ? '' : '<span class="text-xs" style="color:var(--text-3)"> ?</span>'), met.cogs > 0 ? '#f87171' : undefined)}
        ${row('Promo', money(met.promo || 0, { signCost: true }), met.promo > 0 ? '#f87171' : undefined)}
        ${row('Refund value', money(met.refundAmount, { signCost: true }), met.refundAmount > 0 ? '#f87171' : undefined)}
        ${row('Margin', margin)}
        ${row('ROI', roi)}
      </div>` : '';
    return `<div ${shell}>
      <div class="px-4 py-3" style="background:${band}">
        <p class="font-semibold" style="color:${BAND_TEXT}">${label}</p>
        <p class="text-xs" style="color:${BAND_SUB}">${dates || ''}</p>
      </div>
      <div class="p-4 flex-1 flex flex-col gap-3">
        <div>
          <p class="text-xs" style="color:var(--text-3)">Sales</p>
          <p class="text-2xl font-bold" style="color:var(--text)">${money(met.sales)}</p>
        </div>
        <div class="grid grid-cols-2 gap-x-4">
          ${row('Units', (met.units || 0).toLocaleString())}
          ${row('Refunds', key === 'today' ? '<span style="color:var(--text-3)">—</span>' : (met.refundUnits || 0).toLocaleString())}
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 pt-2" style="border-top:1px solid var(--border,#1f2937)">
          ${row('Adv. cost', money(met.adSpend, { signCost: true }), met.adSpend > 0 ? '#f87171' : undefined)}
          ${row('Est. payout', ev(payout))}
          ${row('Gross profit', ev(met.netProfit), npColor)}
          ${row('Net profit', ev(met.netProfit), npColor)}
        </div>
        ${more}
        <div class="mt-auto pt-1 text-center">
          ${[note, met.note].filter(Boolean).length ? `<p class="text-[10px] mb-1" style="color:var(--text-3)">${[note, met.note].filter(Boolean).join(' · ')}</p>` : ''}
          <button class="text-xs font-medium pc-more" data-key="${key}" style="color:${LINK}">${open ? 'Less' : 'More'}</button>
        </div>
      </div>
    </div>`;
  }

  // ── Public render ───────────────────────────────────────────────────────────
  // ctx: { presets(), today(), brands(), scopeBrandId, activeKey?(), onSelect?(key) }
  // With onSelect, cards become the period picker for whatever sits below
  // them: clicking one calls back with its key, activeKey() marks the ring.
  function render(el, ctx) {
    if (!el) return;
    const sel = selection();
    const presets = ctx.presets() || {};
    const brandsMeta = ctx.brands() || [];
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const pickable = typeof ctx.onSelect === 'function';
    const activeKey = pickable && ctx.activeKey ? ctx.activeKey() : null;
    const opts = key => ({ selectable: pickable && key !== 'forecast', active: key === activeKey, inPicker: pickable });
    const grid = html => `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-${Math.min(sel.tiles.length, 5)} gap-3">${html}</div>`;
    const bindMore = () => el.querySelectorAll('.pc-more').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); expandState[b.dataset.key] = !expandState[b.dataset.key]; render(el, ctx); }));

    // Custom range active (Mike, 2026-09-22): the tiles collapse to ONE card
    // — the custom range itself, in the leftmost slot at tile width, ringed
    // since it's what the table below shows. Picking any tile set in the nav
    // dropdown brings the tiles back.
    if (pickable && ctx.custom) {
      const c = ctx.custom();
      if (c) {
        const met = c.payload ? aggregate(c.payload, brandsMeta, ctx.scopeBrandId) : null;
        el.innerHTML = grid(cardHtml('custom', met, fmtRange(c.from, c.to), 0, met ? null : 'loading…', { active: true }));
        bindMore();
        return;
      }
    }

    const mtdAgg = aggregate(presets.mtd, brandsMeta, ctx.scopeBrandId);
    const l7Agg  = aggregate(presets.last7d, brandsMeta, ctx.scopeBrandId);

    const cards = sel.tiles.map((key, idx) => {
      if (key === 'today') {
        const t = ctx.today();
        const met = t ? aggregate(t, brandsMeta, ctx.scopeBrandId) : null;
        if (met) { met.estimated = true; met.fees = met.fees ?? null; }
        return cardHtml('today', met, fmtRange(todayStr, todayStr), idx, met ? 'live · fees estimated, refunds post next day' : 'loading…', opts(key));
      }
      if (key === 'forecast') {
        const f = forecastFrom(mtdAgg, l7Agg, presets.mtd?.endDate, todayStr);
        const end = presets.mtd?.endDate || todayStr;
        const d = new Date(end + 'T00:00:00');
        const dates = fmtRange(end.slice(0, 8) + '01', end.slice(0, 8) + String(new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()).padStart(2, '0'));
        return cardHtml('forecast', f, dates, idx, f ? f.basis : 'needs 3+ days of month data', opts(key));
      }
      const p = presets[key];
      const met = aggregate(p, brandsMeta, ctx.scopeBrandId);
      return cardHtml(key, met, p ? fmtRange(p.startDate, p.endDate) : '', idx, null, opts(key));
    });

    el.innerHTML = grid(cards.join(''));
    bindMore();
    if (pickable) el.querySelectorAll('[data-pc-card]').forEach(c => c.addEventListener('click', () => {
      const key = c.dataset.pcCard;
      if (key !== 'forecast') ctx.onSelect(key);
    }));
  }

  // Swap the persisted tile set (SB "Personalized tiles"); returns the new
  // selection. The dashboard's nav dropdown is the only chooser — the brand
  // page just reads whatever it saved.
  function setSelection(id) {
    const set = TILE_SETS.find(s => s.id === id);
    if (set) saveSelection({ id: set.id, tiles: set.tiles });
    return selection();
  }

  const api = { render, setSelection, aggregate, forecastFrom, TILE_SETS, PERIOD_LABEL, selection };
  if (typeof window !== 'undefined') window.PeriodCards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
