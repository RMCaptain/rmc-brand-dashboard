// Fee breakdown + Sellerboard-vs-Amazon recon card (Mike, 2026-10-19).
// Renders GET /api/fees for a date range: Sellerboard's per-fee-type panel
// (same granularity as Sellerboard's own expanded dashboard) beside a recon
// table comparing Sellerboard against our Amazon account's Finances walk.
// Respects the marketplace picker + CAD/USD toggle via MpScope. Values keep
// Sellerboard's sign convention: costs negative (red), reimbursements
// positive (green).
window.FeeBreakdown = (() => {
  const LABELS = {
    commission: 'Referral fee (commission)', fbaperunitfulfillmentfee: 'FBA fulfillment',
    fbastoragefee: 'FBA storage', fbalongtermstoragefee: 'Long-term storage',
    fbainboundtransportationfee: 'Inbound transportation', fbainboundconveniencefee: 'Inbound convenience',
    fbaremovalfee: 'FBA removal', fbadisposalfee: 'FBA disposal',
    salestaxcollectionfee: 'Sales tax collection', compensated_clawback: 'Compensated clawback',
    missing_from_inbound: 'Missing from inbound', missing_from_inbound_clawback: 'Missing from inbound clawback',
    free_replacement_refund_items: 'Free replacement refund items', inbound_carrier_damage: 'Inbound carrier damage',
    re_evaluation: 'Re-evaluation', reversal_reimbursement: 'Reversal reimbursement',
    warehouse_damage: 'Warehouse damage', warehouse_damage_exception: 'Warehouse damage exception',
    warehouse_lost: 'Warehouse lost', warehouse_lost_manual: 'Warehouse lost (manual)',
    'refund commission': 'Refund commission kept', 'refund principal': 'Refunded amount',
    'refund promotion': 'Refund promotion', 'refund refundcommission': 'Refunded referral fee',
    refundscostsdamaged: 'Refund costs (damaged)', 'value of returned items': 'Value of returned items',
    'productcost unsellable refunds': 'Unsellable products cost',
    'productcost sales': 'Cost of goods sold', 'productcost non-amazon': 'Non-Amazon costs',
    'productcost multichannelcosts': 'Multichannel costs',
    'productcost missingfrominbound': 'Lost/damaged by Amazon (COGS)',
    'productcost costofmissingreturns': 'Cost of missing returns',
    amazonfees: 'Amazon fees (aggregate)', refundcost: 'Refund cost (aggregate)',
    'cost of goods': 'Cost of goods (aggregate)',
  };
  const FEE_KEYS = ['commission', 'fbaperunitfulfillmentfee', 'salestaxcollectionfee', 'fbastoragefee',
    'fbalongtermstoragefee', 'fbainboundtransportationfee', 'fbainboundconveniencefee', 'fbaremovalfee',
    'fbadisposalfee', 'compensated_clawback', 'missing_from_inbound', 'missing_from_inbound_clawback',
    'free_replacement_refund_items', 'inbound_carrier_damage', 're_evaluation', 'reversal_reimbursement',
    'warehouse_damage', 'warehouse_damage_exception', 'warehouse_lost', 'warehouse_lost_manual', 'amazonfees'];
  const REFUND_KEYS = ['refund principal', 'refund commission', 'refund refundcommission', 'refund promotion',
    'refundscostsdamaged', 'value of returned items', 'productcost unsellable refunds', 'refundcost'];
  const COST_KEYS = ['productcost sales', 'productcost non-amazon', 'productcost multichannelcosts',
    'productcost missingfrominbound', 'productcost costofmissingreturns', 'cost of goods'];

  // Shared /api/fees fetch cache — the big card and the period-card
  // drill-downs (period-cards.js) ride the same data.
  const cache = new Map();     // key → resolved data
  const pending = new Map();   // key → in-flight promise
  const feeKey = (from, to, brandId) => `${from}|${to}|${brandId || ''}`;
  function peekFees(from, to, brandId) { return cache.get(feeKey(from, to, brandId)) || null; }
  function fetchFees(from, to, brandId) {
    const key = feeKey(from, to, brandId);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (pending.has(key)) return pending.get(key);
    const p = fetch(`/api/fees?from=${from}&to=${to}${brandId ? `&brandId=${encodeURIComponent(brandId)}` : ''}`)
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        cache.set(key, data);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        return data;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  let seq = 0;

  async function render(el, opts = {}) {
    if (!el) return;
    if (!opts.from || !opts.to) { el.innerHTML = ''; return; }
    const my = ++seq;
    let data = peekFees(opts.from, opts.to, opts.brandId);
    if (!data) {
      el.innerHTML = shell('<p class="text-xs py-4" style="color:var(--text-3)">loading fee data…</p>', opts);
      try {
        data = await fetchFees(opts.from, opts.to, opts.brandId);
      } catch (e) {
        if (seq === my) el.innerHTML = shell(`<p class="text-xs py-4" style="color:#f87171">Fee data unavailable: ${e.message}</p>`, opts);
        return;
      }
    }
    if (seq !== my) return;
    el.innerHTML = shell(body(data), opts);
  }

  // Scoped, display-currency section rows for drill-downs elsewhere (period
  // cards): { ads, fees, refunds, cogs: [{label, v}], hasSb }. Values keep
  // Sellerboard's sign (costs negative).
  function sections(data) {
    const M = window.MpScope;
    const sb = Object.values(data?.sb?.byMp || {}).filter(s => !M.scoped() || s.code === M.filter());
    const conv = (v, cur) => M.toDisplay(v || 0, cur);
    const typeVal = k => sb.reduce((t, s) => t + conv(s.types?.[k], s.currency), 0);
    const rows = keys => keys
      .map(k => ({ label: LABELS[k] || k, v: typeVal(k) }))
      .filter(r => Math.abs(r.v) >= 0.005)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    const ads = [['Sponsored Products', 'sp'], ['Sponsored Brands Video', 'sbv'], ['Sponsored Brands', 'sb'], ['Sponsored Display', 'sd']]
      .map(([label, k]) => ({ label, v: -sb.reduce((t, s) => t + conv(s.adSplit?.[k], s.currency), 0) }))
      .filter(r => Math.abs(r.v) >= 0.005)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return { ads, fees: rows(FEE_KEYS), refunds: rows(REFUND_KEYS), cogs: rows(COST_KEYS), hasSb: sb.length > 0 };
  }

  function fmtSigned(v) {
    const M = window.MpScope;
    if (v == null || Math.abs(v) < 0.005) return `<span style="color:var(--text-3)">${M.fmt(0)}</span>`;
    const color = v < 0 ? '#f87171' : '#34d399';
    return `<span style="color:${color}">${v < 0 ? '-' : ''}${M.fmt(Math.abs(v))}</span>`;
  }

  function shell(inner, opts) {
    const range = opts.from === opts.to ? opts.from : `${opts.from} → ${opts.to}`;
    return `<div class="rmc-card p-4">
      <div class="flex items-center justify-between flex-wrap gap-2 mb-1">
        <p class="font-semibold text-sm" style="color:var(--text)">Fees — breakdown &amp; Amazon recon</p>
        <span class="text-xs" style="color:var(--text-3)">${range}</span>
      </div>
      ${inner}
    </div>`;
  }

  function body(data) {
    const M = window.MpScope;
    const sb = Object.values(data.sb?.byMp || {}).filter(s => !M.scoped() || s.code === M.filter());
    const amz = Object.values(data.amz?.byMp || {}).filter(s => !M.scoped() || s.code === M.filter());
    if (!sb.length && !amz.length) return '<p class="text-xs py-4" style="color:var(--text-3)">No fee data in this range for this scope. Sellerboard covers complete days only; Today has nothing yet.</p>';

    const conv = (v, cur) => M.toDisplay(v || 0, cur);
    const typeVal = k => sb.reduce((t, s) => t + conv(s.types?.[k], s.currency), 0);
    // Charges only (Sellerboard-negative portions), returned POSITIVE — the
    // Finances walk counts charges, so recon compares like with like.
    const typeCharge = keys => -sb.reduce((t, s) => t + keys.reduce((x, k) => x + conv(Math.min(s.types?.[k] || 0, 0), s.currency), 0), 0);
    const sbSum = k => sb.reduce((t, s) => t + conv(s[k], s.currency), 0);
    const amzSum = k => amz.reduce((t, s) => t + conv(s[k], s.currency), 0);
    const groupSum = names => amz.reduce((t, s) => t + names.reduce((x, g) => x + conv(s.groups?.[g], s.currency), 0), 0);

    const fmtSigned = v => {
      if (v == null || Math.abs(v) < 0.005) return `<span style="color:var(--text-3)">${M.fmt(0)}</span>`;
      const color = v < 0 ? '#f87171' : '#34d399';
      return `<span style="color:${color}">${v < 0 ? '-' : ''}${M.fmt(Math.abs(v))}</span>`;
    };
    const line = (lbl, v, { strong = false } = {}) => `
      <div class="flex items-center justify-between gap-3 py-0.5">
        <span class="text-xs ${strong ? 'font-semibold' : ''}" style="color:${strong ? 'var(--text)' : 'var(--text-2)'}">${lbl}</span>
        <span class="text-xs font-medium ${strong ? 'font-semibold' : ''}">${v}</span>
      </div>`;
    const section = (title, totalHtml, keys) => {
      const rows = keys
        .map(k => ({ k, v: typeVal(k) }))
        .filter(r => Math.abs(r.v) >= 0.005)
        .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
        .map(r => line(LABELS[r.k] || r.k, fmtSigned(r.v)));
      return `<div class="mb-3">
        ${line(title, totalHtml, { strong: true })}
        ${rows.length ? `<div class="pl-3 mt-0.5" style="border-left:2px solid var(--border,#1f2937)">${rows.join('')}</div>` : ''}
      </div>`;
    };

    const adTotal = sbSum('adSpend');
    const adRows = [['Sponsored Products', 'sp'], ['Sponsored Brands Video', 'sbv'], ['Sponsored Brands', 'sb'], ['Sponsored Display', 'sd']]
      .map(([lbl, k]) => ({ lbl, v: sb.reduce((t, s) => t + conv(s.adSplit?.[k], s.currency), 0) }))
      .filter(r => Math.abs(r.v) >= 0.005)
      .sort((a, b) => b.v - a.v)
      .map(r => line(r.lbl, fmtSigned(-r.v)));
    const advertising = `<div class="mb-3">
      ${line('Advertising cost', fmtSigned(-adTotal), { strong: true })}
      ${adRows.length ? `<div class="pl-3 mt-0.5" style="border-left:2px solid var(--border,#1f2937)">${adRows.join('')}</div>` : ''}
    </div>`;

    const feesNet = sb.reduce((t, s) => t + conv(-(s.amazonFees || 0), s.currency), 0);
    const breakdownCol = `
      ${advertising}
      ${section('Amazon fees', fmtSigned(feesNet), FEE_KEYS)}
      ${section('Refund cost', `<span class="text-xs" style="color:var(--text-3)">${sb.reduce((t, s) => t + (s.refundUnits || 0), 0)} unit(s)</span>`, REFUND_KEYS)}
      ${section('Cost of goods', fmtSigned(-sbSum('productCosts')), COST_KEYS)}
      ${line('Reimbursements (in fees above)', fmtSigned(sbSum('reimbursements')), { strong: true })}`;

    // ── Recon: Sellerboard (order-day basis) vs Amazon Finances (posted-day) ──
    const brandScope = data.amz?.scope === 'brand';
    const reconRows = [
      { lbl: 'Referral fee', sb: typeCharge(['commission']), amz: groupSum(['Referral Fee']) },
      { lbl: 'FBA fulfillment', sb: typeCharge(['fbaperunitfulfillmentfee']), amz: groupSum(['FBA Fulfillment']) },
      { lbl: 'Per-item fees (total)', sb: typeCharge(['commission', 'fbaperunitfulfillmentfee', 'salestaxcollectionfee', 'amazonfees']), amz: amzSum('fees') },
      { lbl: 'Storage', sb: typeCharge(['fbastoragefee', 'fbalongtermstoragefee']), amz: brandScope ? null : groupSum(['Storage']), acct: true },
      { lbl: 'Inbound', sb: typeCharge(['fbainboundtransportationfee', 'fbainboundconveniencefee']), amz: brandScope ? null : groupSum(['Inbound']), acct: true },
      { lbl: 'Removal / disposal', sb: typeCharge(['fbaremovalfee', 'fbadisposalfee']), amz: brandScope ? null : groupSum(['Removal']), acct: true },
      { lbl: 'Refund value', sb: sbSum('refundAmount'), amz: amzSum('refundAmount') },
    ].filter(r => Math.abs(r.sb) >= 0.005 || (r.amz != null && Math.abs(r.amz) >= 0.005));

    const z = v => Math.abs(v) < 0.005 ? 0 : v;   // fold -0
    const reconHtml = reconRows.map(r => {
      r.sb = z(r.sb); if (r.amz != null) r.amz = z(r.amz);
      const amzCell = r.amz == null
        ? '<span style="color:var(--text-3)" title="Storage / inbound / removal post account-level on Amazon — switch to All brands for this row">—</span>'
        : M.fmt(r.amz);
      let delta = '—', pct = '', dot = 'var(--text-3)';
      if (r.amz != null && (Math.abs(r.sb) >= 0.005 || Math.abs(r.amz) >= 0.005)) {
        const d = r.sb - r.amz;
        const p = r.amz !== 0 ? Math.abs(d / r.amz) * 100 : (r.sb !== 0 ? 100 : 0);
        delta = `${d < 0 ? '-' : ''}${M.fmt(Math.abs(d))}`;
        pct = p.toFixed(1) + '%';
        dot = p <= 10 ? '#34d399' : p <= 25 ? '#fbbf24' : '#f87171';
      }
      return `<tr>
        <td class="py-1 pr-2 text-xs" style="color:var(--text-2)">${r.lbl}</td>
        <td class="py-1 px-2 text-xs text-right font-medium" style="color:var(--text)">${M.fmt(r.sb)}</td>
        <td class="py-1 px-2 text-xs text-right font-medium" style="color:var(--text)">${amzCell}</td>
        <td class="py-1 px-2 text-xs text-right" style="color:var(--text-2)">${delta}</td>
        <td class="py-1 pl-2 text-xs text-right"><span style="color:${dot}">${pct || ''}</span></td>
      </tr>`;
    }).join('');

    const reconCol = `
      <table class="w-full">
        <thead><tr style="border-bottom:1px solid var(--border,#1f2937)">
          <th class="text-left text-xs font-medium py-1 pr-2" style="color:var(--text-3)">Charge</th>
          <th class="text-right text-xs font-medium py-1 px-2" style="color:var(--text-3)">Sellerboard</th>
          <th class="text-right text-xs font-medium py-1 px-2" style="color:var(--text-3)">Amazon</th>
          <th class="text-right text-xs font-medium py-1 px-2" style="color:var(--text-3)">Δ</th>
          <th class="text-right text-xs font-medium py-1 pl-2" style="color:var(--text-3)">Δ%</th>
        </tr></thead>
        <tbody>${reconHtml || '<tr><td colspan="5" class="text-xs py-3 text-center" style="color:var(--text-3)">nothing to compare in this range</td></tr>'}</tbody>
      </table>
      <p class="text-[10px] mt-2" style="color:var(--text-3)">
        Sellerboard books to the order day, Amazon to the posted day — a few % of window noise is
        structural (nightly recon tolerates 10% on fees). Storage amortizes daily on Sellerboard but
        posts monthly on Amazon, so short windows diverge there by design.${brandScope ? ' Brand scope compares per-item fees; account-level charges show under All brands.' : ''}
      </p>`;

    return `<div class="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-4 mt-2">
      <div>
        <p class="text-xs font-semibold mb-2" style="color:var(--text-3)">SELLERBOARD BREAKDOWN</p>
        ${breakdownCol}
      </div>
      <div>
        <p class="text-xs font-semibold mb-2" style="color:var(--text-3)">SELLERBOARD VS AMAZON (FINANCES API)</p>
        ${reconCol}
      </div>
    </div>`;
  }

  return { render, fetchFees, peekFees, sections, fmtSigned, _cache: cache };
})();
