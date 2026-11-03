// Per-product detail panel (Mike, 2026-11-03) — Sellerboard's line-item
// popover, computed from the sku's byMp slices for the selected period and
// marketplace scope. Opened from a product row; closes on X, outside click,
// or Escape. Values follow the CAD/USD toggle; costs show negative in red
// exactly like Sellerboard's panel.
window.SkuDetail = (() => {
  let el = null;

  function close() {
    if (el) { el.remove(); el = null; }
    document.removeEventListener('click', onDocClick, true);
    document.removeEventListener('keydown', onKey);
  }
  function onDocClick(e) { if (el && !el.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') close(); }

  const esc = t => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  function open(ev, brand, s) {
    ev?.stopPropagation?.();
    close();
    if (!brand || !s || !window.MpScope) return;
    const M = window.MpScope;
    const n = M.skuNet(brand, s);
    const tilde = n.estimated ? '~' : '';
    const by = s.byMp && Object.keys(s.byMp).length ? s.byMp : null;
    const refundUnits = by ? (M.sumMp(by, 'refunds') || 0) : (s.refundedUnits ?? null);
    const refundValue = by ? (M.sumMp(by, 'refundAmount') || 0) : M.legacyNum(s.refundPostedCad || 0, s.refundPostedUsd || 0);
    const promo = by ? (M.sumMp(by, 'promo') || 0) : 0;
    let sellRet = 0, sellBasis = 0;
    for (const m of M.scopedMps(by || {})) if (m.sellableBasis > 0) { sellRet += m.sellableReturns || 0; sellBasis += m.sellableBasis; }
    const trf = M.trafficOf(s);
    const sns = M.snsFor(brand, s.asin);
    const payout = n.fees != null ? n.rev - n.fees - refundValue - (n.adSpend || 0) - promo : null;

    const money = v => M.fmt(Math.abs(v));
    const cost = (v, est = false) => v == null ? dash()
      : Math.abs(v) < 0.005 ? `<span style="color:var(--text-2)">${M.fmt(0)}</span>`
      : `<span style="color:#f87171">-${est ? '~' : ''}${money(v)}</span>`;
    const gain = (v, est = false) => v == null ? dash()
      : `<span style="color:${v >= 0 ? '#34d399' : '#f87171'}">${est ? '~' : ''}${v < 0 ? '-' : ''}${money(v)}</span>`;
    const plain = v => `<span style="color:var(--text)">${v}</span>`;
    const dash = () => '<span style="color:var(--text-3)">—</span>';
    const pctOr = (num, den, digits = 2) => den > 0 ? (num / den * 100).toFixed(digits) + '%' : '—';

    const rows = [
      ['Sales', plain(M.fmt(n.rev))],
      ['Units', plain((n.units || 0).toLocaleString())],
      ['Refunds', plain(refundUnits != null ? refundUnits.toLocaleString() : '—')],
      ['Promo', cost(promo)],
      ['Advertising cost', cost(n.adSpend)],
      ['Refund cost', cost(refundValue)],
      ['Amazon fees', n.fees != null ? cost(n.fees, n.estimated) : dash()],
      ['Cost of goods', n.cogs > 0 ? cost(n.cogs) : dash()],
      ['Gross profit', gain(n.netProfit, n.estimated)],
      ['Net profit', gain(n.netProfit, n.estimated), true],
      ['Estimated payout', payout != null ? plain((n.estimated ? '~' : '') + M.fmt(payout)) : dash()],
      ['TACOS', plain(pctOr(n.adSpend || 0, n.rev)), true],
      ['% Refunds', plain(refundUnits != null ? pctOr(refundUnits, n.units || 0) : '—')],
      ['Sellable returns', plain(sellBasis > 0 ? (sellRet / sellBasis * 100).toFixed(1) + '%' : '—')],
      ['Margin', plain(n.netProfit != null && n.rev > 0 ? tilde + (n.netProfit / n.rev * 100).toFixed(2) + '%' : '—'), true],
      ['ROI', plain(n.netProfit != null && n.cogs > 0 ? tilde + (n.netProfit / n.cogs * 100).toFixed(2) + '%' : '—')],
      ['Active subscriptions (S&S)', plain(sns != null ? sns.toLocaleString() : '—'), true],
      ['Sessions', plain(trf.sessions != null ? trf.sessions.toLocaleString() : '—')],
      ['Unit session percentage', plain(trf.cvr != null ? trf.cvr.toFixed(2) + '%' : '—')],
    ];

    el = document.createElement('div');
    el.className = 'rounded-lg';
    const w = Math.min(380, window.innerWidth - 16);
    const x = Math.max(8, Math.min((ev?.clientX ?? window.innerWidth - w) - w / 2, window.innerWidth - w - 8));
    const y = Math.min((ev?.clientY ?? 100) + 12, Math.max(8, window.innerHeight - 560));
    el.style.cssText = `position:fixed;top:${Math.max(8, y)}px;left:${x}px;width:${w}px;max-height:86vh;overflow-y:auto;z-index:1100;background:#0e1524;border:1px solid #2a3650;box-shadow:0 12px 40px rgba(0,0,0,0.7)`;
    el.innerHTML = `
      <div class="flex items-start gap-3 p-3" style="border-bottom:1px solid var(--border,#1f2937);background:var(--brand-tint, rgba(83,125,48,0.11))">
        ${s.imageUrl ? `<img src="${esc(s.imageUrl)}" class="w-10 h-10 object-contain rounded bg-slate-700 flex-shrink-0" onerror="this.style.display='none'" />` : ''}
        <div class="min-w-0 flex-1">
          <p class="font-mono text-xs" style="color:var(--text-3)">${esc(s.asin)}${s.sellerSku ? ' · ' + esc(s.sellerSku) : ''}</p>
          <p class="text-xs font-medium mt-0.5" style="color:var(--text)">${esc(s.title || s.asin)}</p>
        </div>
        <button class="sku-detail-x text-lg leading-none px-1" style="color:var(--text-3)" title="Close">×</button>
      </div>
      <div class="p-2">
        ${rows.map(([lbl, v, sep]) => `
          <div class="flex items-center justify-between gap-4 px-2 py-1.5 text-sm" style="${sep ? 'border-top:1px solid var(--border,#1f2937)' : ''}">
            <span style="color:var(--text-2)">${lbl}</span>
            <span class="font-medium text-right">${v}</span>
          </div>`).join('')}
        ${n.estimated ? '<p class="px-2 pt-1 text-[10px]" style="color:var(--text-3)">~ fees estimated from trailing per-unit rates — replaced with posted fees within 24–48h</p>' : ''}
      </div>`;
    el.addEventListener('click', e => e.stopPropagation());
    el.querySelector('.sku-detail-x').addEventListener('click', close);
    document.body.appendChild(el);
    setTimeout(() => { document.addEventListener('click', onDocClick, true); document.addEventListener('keydown', onKey); }, 0);
  }

  return { open, close };
})();
