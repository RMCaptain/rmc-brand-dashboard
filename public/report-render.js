// report-render.js — shared report-rendering code for brand-report.html (team)
// and portal-report.html (client portal).
//
// Extracted 2026-07-28 to end the hand-mirroring of every section change across
// both pages. CONTRACT:
//   - Plain globals, classic script. Load with <script src="/report-render.js">
//     BEFORE the page's inline script. If a page still declares one of these
//     names, the browser throws a loud "already declared" SyntaxError — that is
//     the desired failure mode for a missed deletion.
//   - Print seam: shared code reads `window.__printMode === true`, never a page
//     const. brand-report.html assigns the flag from its own print const at
//     boot; the portal never sets it (no print mode), so the check is false.
//   - Chart.js instances live in the `charts` registry below, not page globals.
//   - SHARED_RENDERERS carries the eight sections both pages render the same
//     way. Each page composes its own SECTION_RENDERERS from it, adding its
//     page-local executive_summary and per_asin_detail — those two DIFFER BY
//     DESIGN (team: editor + paginated table; portal: read-only text + full
//     table) and must stay in the pages.

// ── Formatters ────────────────────────────────────────────────────────────────
const fmtC = (v, sym = 'CA$') => (v == null || isNaN(v)) ? '—' : sym + Math.round(v).toLocaleString('en-US');
const fmtN = v => v == null ? '—' : Number(v).toLocaleString('en-US');
const fmtPct = (v, d = 1) => v == null || isNaN(v) ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)) + '%';
const fmt2 = v => v == null || isNaN(v) ? '—' : (Math.round(v * 100) / 100).toFixed(2);

function pct(curr, prev) {
  if (!prev || prev === 0) return null;
  return Math.round((curr - prev) / prev * 1000) / 10;
}
function deltaHtml(curr, prev) {
  const p = pct(curr, prev);
  if (p === null) return '<span class="delta neu">—</span>';
  return `<span class="delta ${p >= 0 ? 'pos' : 'neg'}">${p >= 0 ? '+' : ''}${p}%</span>`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

const fmtDay = iso => {
  if (!iso) return '';
  const [y, m, dd] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

// ── Data coverage ─────────────────────────────────────────────────────────────
// A zero in this data means one of two very different things: the brand really
// sold/spent nothing, or we never had the data. The table can't distinguish them
// (0, not NULL), so the renderer must not present one as the other — a report
// telling a brand they did $0 last year when we simply lack the year is worse
// than showing nothing at all.
//
// d.coverage carries the earliest date we hold each kind of data. Anything
// before that is unknowable, so say "no data", never "$0".

function coverageState(d, kind, from, to) {
  const boundary = kind === 'ads' ? d.coverage?.adsFrom : d.coverage?.revenueFrom;
  if (!boundary) return { state: 'unknown', boundary: null };
  if (to   <  boundary) return { state: 'none',    boundary };   // entirely before we had data
  if (from <  boundary) return { state: 'partial', boundary };   // starts before, ends inside
  return { state: 'full', boundary };
}

// Prior-year YTD window, mirroring how the server builds ytdSeriesPrev.
function priorYearWindow(periodTo) {
  const [y, m, d] = periodTo.split('-').map(Number);
  const py = y - 1;
  const pad = n => String(n).padStart(2, '0');
  return { from: `${py}-01-01`, to: `${py}-${pad(m)}-${pad(d)}` };
}

// Ad data before the boundary isn't "missing pending a backfill" — Amazon only
// retains ~95 days of report history, so it aged out before we ever pulled it
// and is gone for good. Worth saying plainly: someone will otherwise keep
// trying to recover it (I did, twice).
function adsNoDataHtml(cov) {
  return `<div class="rpt-placeholder">
    <strong>No advertising data for this period.</strong> Our ad records begin
    ${fmtDay(cov.boundary)}. Amazon retains roughly 95 days of advertising report
    history, so earlier periods can't be recovered. This is missing data — not
    evidence that no ads ran.
  </div>`;
}

function adsPartialNoteHtml(cov, d) {
  return `<div class="rpt-note">Advertising figures cover ${fmtDay(cov.boundary)} – ${fmtDay(d.period.to)} only.
    Ad records don't reach the start of this period, so ad totals understate the full window.</div>`;
}

// Combined CAD+USD, matching how buildSku already derives acos/roas. Returns
// null when the ASIN shows no ad activity whatsoever, so "no data" stays
// distinct from a genuine $0.
function adSpendOf(p) {
  const spend = (p.spendCad || 0) + (p.spendUsd || 0);
  if (spend > 0) return spend;
  const touched = (p.adClicks || 0) > 0 || (p.adImpressions || 0) > 0 || (p.adOrders || 0) > 0;
  return touched ? 0 : null;
}

// Average order value — the tile that fills the 6th headline slot.
//
// AOV = period revenue / period orders. The trap: if orders cover fewer days
// than revenue does (a backfill still in flight, or the period predates order
// tracking), full-period revenue divides by part-period orders and the number
// inflates — Zellies June read $54 mid-backfill vs $37 complete. So this refuses
// to show a number unless order-day coverage matches revenue-day coverage, and
// otherwise renders "—" with a reason. Same discipline as the ad + YTD sections.
//
// AOV is blended CAD+USD to match the revenue tiles above it; order_count_ca/us
// are in the dataset if a per-marketplace split is wanted later.
function aovTile(d, tile) {
  const o = d.orders;
  const revenue = (d.summary?.revenueCad || 0) + (d.summary?.revenueUsd || 0);

  // No order data at all → period predates order tracking, or the table's empty.
  if (!o || !o.count) {
    const boundary = d.coverage?.ordersFrom;
    const sub = (boundary && d.period?.from && d.period.from < boundary)
      ? `No order data before ${fmtDay(boundary)}`
      : 'Revenue ÷ orders';
    return tile('Avg Order Value', '—', null, sub);
  }

  // Coverage mismatch → the ratio would be inflated. Don't show a wrong number.
  if (o.daysWithOrders < o.revenueDays) {
    return tile('Avg Order Value', '—', null,
      `Partial order data (${o.daysWithOrders}/${o.revenueDays} days)`);
  }

  // Cents, not whole dollars: fmtC rounds, but $45.72 vs $46 matters for an
  // order value — and it keeps AOV visibly distinct from the big revenue tiles.
  const fmtAov = v => v == null || isNaN(v) ? '—'
    : '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const aov = revenue / o.count;

  // Prior-period delta only when the comparison period is itself fully covered,
  // so an inflated prior AOV can't fabricate a swing.
  const op = d.ordersPrev;
  let change = null, prevSub = `${fmtN(o.count)} orders`;
  if (op && op.count && op.daysWithOrders >= op.revenueDays) {
    const prevRev = (d.summaryPrev?.revenueCad || 0) + (d.summaryPrev?.revenueUsd || 0);
    const prevAov = prevRev / op.count;
    change = pct(aov, prevAov);
    prevSub = `Prior: ${fmtAov(prevAov)}`;
  }
  return tile('Avg Order Value', fmtAov(aov), change, prevSub);
}

// ── Revenue share pie ─────────────────────────────────────────────────────────

const PIE_TOP_N = 10;

// Distinguishable at a glance in print and on screen, and deliberately not the
// RMC greens — ten shades of one hue is unreadable as a pie. Grey is reserved
// for "All others" so it never reads as a product.
const PIE_COLORS = [
  '#2c3a20', '#4a7c1f', '#9db47e', '#c9a227', '#e08a3c',
  '#a63d40', '#6b4e8f', '#3b7ea1', '#5f9ea0', '#8c6d4f',
];
const PIE_OTHER_COLOR = '#c8c6bc';

/**
 * Top N ASINs by revenue + an "All others" slice.
 *
 * Label is the SUPPLIER name where set, else a truncated Amazon title. `named`
 * records which, so the renderer can say when it fell back rather than passing
 * an Amazon title off as a supplier name.
 */
function revenueShareSlices(d) {
  const products = (d.products || [])
    .map(p => ({
      asin: p.asin,
      revenue: (p.revenueCad || 0) + (p.revenueUsd || 0),
      supplierName: (p.supplierName || '').trim(),
      amazonTitle: (p.amazonTitle || p.title || '').trim(),
    }))
    .filter(p => p.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);

  if (!products.length) return [];

  const top = products.slice(0, PIE_TOP_N).map(p => {
    const named = !!p.supplierName;
    let label = p.supplierName || p.amazonTitle || p.asin;
    if (!named && label.length > 34) label = label.slice(0, 34) + '…';
    return { asin: p.asin, label, revenue: p.revenue, named };
  });

  const rest = products.slice(PIE_TOP_N);
  if (rest.length) {
    top.push({
      asin: null,
      label: `All others (${rest.length})`,
      revenue: rest.reduce((s, p) => s + p.revenue, 0),
      named: true,
    });
  }
  return top;
}

// ── Charts ────────────────────────────────────────────────────────────────────
// Chart.js instances, keyed by chart. The registry lives HERE, not in the pages:
// the builders destroy-and-replace through it, so a page can't leak an old
// instance by forgetting its own global.
const charts = {};

function buildChart(daily, dailyPrev) {
  const el = document.getElementById('salesChart');
  if (!el) return;
  if (charts.sales) charts.sales.destroy();

  const labels = (daily || []).map(d => d.date);
  const curr   = (daily || []).map(d => Math.round((d.revCad + d.revUsd) * 100) / 100);
  // Align prior series to the SAME label positions, by index
  const prevByIdx = (dailyPrev || []).map(d => Math.round((d.revCad + d.revUsd) * 100) / 100);

  charts.sales = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Current period', data: curr,        borderColor: '#537D30', backgroundColor: 'rgba(83,125,48,0.10)', fill: true,  tension: 0.3, borderWidth: 2, pointRadius: 0 },
        { label: 'Prior period',   data: prevByIdx,   borderColor: '#9AAABB', backgroundColor: 'transparent',          fill: false, tension: 0.3, borderWidth: 2, pointRadius: 0, borderDash: [4, 4] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { font: { size: 11 }, color: '#5A6A82', usePointStyle: true } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#9AAABB', maxRotation: 0, autoSkip: true } },
        y: { grid: { color: '#F1F5F9' }, ticks: { font: { size: 10 }, color: '#9AAABB', callback: v => '$' + v.toLocaleString() }, beginAtZero: true },
      },
    },
  });
}

// YTD cumulative chart — current YTD (solid) vs prior YTD (dashed), aligned
// by day-of-year so seasonal patterns visually compare across years.
function buildYtdChart(curr, prior) {
  const el = document.getElementById('ytdChart');
  if (!el) return;
  if (charts.ytd) charts.ytd.destroy();

  // Cumulative running total per series, indexed by day-of-year
  function cumulative(rows) {
    let acc = 0;
    return (rows || []).map(r => { acc += (r.revCad + r.revUsd); return Math.round(acc * 100) / 100; });
  }
  // Label set: day-of-year for current series (so the X-axis stays in the current year's calendar)
  const labels   = (curr  || []).map(r => r.date);
  const currCum  = cumulative(curr);
  const priorCum = cumulative(prior);

  charts.ytd = new Chart(el, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Current YTD', data: currCum,  borderColor: '#537D30', backgroundColor: 'rgba(83,125,48,0.10)', fill: true,  tension: 0.2, borderWidth: 2, pointRadius: 0 },
        { label: 'Prior YTD',   data: priorCum, borderColor: '#9AAABB', backgroundColor: 'transparent',          fill: false, tension: 0.2, borderWidth: 2, pointRadius: 0, borderDash: [4, 4] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { font: { size: 11 }, color: '#5A6A82', usePointStyle: true } },
        tooltip: { mode: 'index', intersect: false, callbacks: { label: ctx => ctx.dataset.label + ': $' + Number(ctx.parsed.y).toLocaleString() } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#9AAABB', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { grid: { color: '#F1F5F9' }, ticks: { font: { size: 10 }, color: '#9AAABB', callback: v => '$' + Math.round(v).toLocaleString() }, beginAtZero: true },
      },
    },
  });
}

// Ad-trend chart: ad sales (bars) + organic sales (bars) + ROAS line on a
// secondary axis. Mirrors Merchant Spring's "Advertising performance trend".
function buildAdTrendChart(daily) {
  const el = document.getElementById('adTrendChart');
  if (!el) return;
  if (charts.ad) charts.ad.destroy();

  const labels   = (daily || []).map(d => d.date);
  const adSales  = (daily || []).map(d => Math.round((d.adSalesCad + d.adSalesUsd) * 100) / 100);
  const totalRev = (daily || []).map(d => Math.round((d.revCad + d.revUsd) * 100) / 100);
  // Organic = total - ad-attributed. Floored at 0 (rare: attributed > total
  // can happen because of the 14-day lookback overlap).
  const organic  = totalRev.map((tot, i) => Math.max(0, Math.round((tot - adSales[i]) * 100) / 100));
  const roas     = (daily || []).map(d => {
    const sp = (d.spendCad + d.spendUsd);
    const sa = (d.adSalesCad + d.adSalesUsd);
    return sp > 0 ? Math.round(sa / sp * 100) / 100 : null;
  });

  charts.ad = new Chart(el, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Ad sales',      data: adSales, backgroundColor: '#537D30', stack: 'sales', borderWidth: 0, yAxisID: 'y' },
        { label: 'Organic sales', data: organic, backgroundColor: '#CBD5E1', stack: 'sales', borderWidth: 0, yAxisID: 'y' },
        { label: 'ROAS', data: roas, type: 'line', borderColor: '#1A2332', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', align: 'end', labels: { font: { size: 11 }, color: '#5A6A82', usePointStyle: true } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, color: '#9AAABB', maxRotation: 0, autoSkip: true } },
        y:  { stacked: true, grid: { color: '#F1F5F9' }, ticks: { font: { size: 10 }, color: '#9AAABB', callback: v => '$' + v.toLocaleString() }, beginAtZero: true, position: 'left' },
        y1: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#9AAABB', callback: v => v + 'x' }, beginAtZero: true, position: 'right' },
      },
    },
  });
}

function buildRevenuePieChart(d) {
  const el = document.getElementById('revenueShareChart');
  if (!el) return;
  if (charts.pie) charts.pie.destroy();

  const slices = revenueShareSlices(d);
  if (!slices.length) return;
  const total = slices.reduce((s, x) => s + x.revenue, 0);

  charts.pie = new Chart(el, {
    type: 'pie',
    data: {
      labels: slices.map(s => s.label),
      datasets: [{
        data: slices.map(s => Math.round(s.revenue * 100) / 100),
        backgroundColor: slices.map((s, i) => s.asin === null ? PIE_OTHER_COLOR : PIE_COLORS[i % PIE_COLORS.length]),
        borderColor: '#fff',
        borderWidth: 1.5,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      // The legend beside the chart already names every slice with its ASIN and
      // share — Chart.js's own legend would just repeat it, worse.
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed;
              const pct = (v / total * 100).toFixed(1);
              const s = slices[ctx.dataIndex];
              return `${s.label}: ${fmtC(v, '$')} (${pct}%)`;
            },
          },
        },
      },
      // Charts must be fully painted before Puppeteer snapshots the PDF.
      animation: window.__printMode === true ? false : undefined,
    },
  });
}

// ── Section titles + shared renderers ─────────────────────────────────────────
const SECTION_TITLES = {
  executive_summary:   'Executive Summary',
  headline_tiles:      'Performance Highlights',
  sales_trend:         'Revenue Trend',
  ytd_chart:           'Year to Date',
  top_sellers:         'Top Sellers',
  ad_trend:            'Advertising Trend',
  ad_summary:          'Advertising Performance',
  inventory_status:    'Inventory Status',
  revenue_share_pie: 'Revenue Share by Product',
  per_asin_detail: 'Per-ASIN Detail',
};

// The eight renderers both pages share. Pages spread this into their own
// SECTION_RENDERERS and add executive_summary + per_asin_detail locally.
const SHARED_RENDERERS = {
  headline_tiles: (d) => {
    const s = d.summary, sp = d.summaryPrev || {};
    const conv = s.sessions ? s.units / s.sessions * 100 : null;
    const tile = (label, value, change, prev) => {
      const cls = change == null ? 'neu' : change >= 0 ? 'pos' : 'neg';
      const chg = change == null ? '' : `<div class="tile-change ${cls}">${change >= 0 ? '+' : ''}${change}% vs prior</div>`;
      const prv = prev ? `<div class="tile-prev">${prev}</div>` : '';
      return `<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${chg}${prv}</div>`;
    };

    // Only render a marketplace's revenue tile when that marketplace actually
    // has data — current period or prior. Showing "US$0" on a CA-only brand is
    // noise. Labels name the MARKETPLACE, not just the currency, so adding
    // Walmart later doesn't silently read as the same line item.
    // NOTE: the data model still keys on currency, so amazon_ca and a future
    // walmart_ca would collapse. See the Notion entry on multi-marketplace.
    const marketplaces = [
      { label: 'Revenue — Amazon.ca (CA$)', sym: 'CA$',  cur: s.revenueCad, prev: sp.revenueCad },
      { label: 'Revenue — Amazon.com (US$)', sym: 'US$', cur: s.revenueUsd, prev: sp.revenueUsd },
    ].filter(mp => (mp.cur || 0) > 0 || (mp.prev || 0) > 0);

    const revTiles = marketplaces.map(mp =>
      tile(mp.label, fmtC(mp.cur, mp.sym), pct(mp.cur, mp.prev), 'Prior: ' + fmtC(mp.prev, mp.sym))
    ).join('');

    // S&S subs (seller-scoped, live count) and repeat customers (Brand
    // Analytics, last full month, brand-wide for the brand's own marketplaces).
    // Rendered only when the data exists — never estimated, never conflated.
    const snsTile = d.snsSubs > 0
      ? tile('S&amp;S Subscriptions', fmtN(d.snsSubs), null, 'Active Subscribe &amp; Save')
      : '';
    const rp = d.repeatPurchase;
    const rpMonth = rp?.period?.start
      ? new Date(rp.period.start + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : '';
    const rpTile = (rp && rp.source === 'brand_analytics')
      ? tile('Repeat Customers', fmtPct(rp.repeatCustomersPct), null,
             `Brand Analytics — ${rpMonth} (brand-wide, ${(rp.marketplaces || []).join('+')})`)
      : '';

    return `<div class="tiles">
      ${revTiles}
      ${tile('Units Sold', fmtN(s.units), pct(s.units, sp.units), 'Prior: ' + fmtN(sp.units))}
      ${tile('Sessions', fmtN(s.sessions), null, null)}
      ${tile('Conversion (CVR)', fmtPct(conv), null, 'Units ÷ sessions')}
      ${tile('Buy Box %', fmtPct(s.buyBox), null, 'Avg across products')}
      ${aovTile(d, tile)}
      ${snsTile}
      ${rpTile}
    </div>`;
  },

  sales_trend: () => `<div class="chart-wrap"><canvas id="salesChart"></canvas></div>`,

  ytd_chart: (d) => {
    const cy = d.ytdSeries     || [];
    const py = d.ytdSeriesPrev || [];
    const cyTotal = cy.reduce((s, x) => s + (x.revCad + x.revUsd), 0);
    const pyTotal = py.reduce((s, x) => s + (x.revCad + x.revUsd), 0);

    // The prior year is the single worst place to render a zero we can't stand
    // behind: "Prior YTD $0" tells a brand they sold nothing last year. If the
    // prior-year window sits entirely before our data begins, we don't know
    // what they did — so say that, and drop the meaningless delta with it.
    const pw     = priorYearWindow(d.period.to);
    const pyCov  = coverageState(d, 'revenue', pw.from, pw.to);
    const pyKnown = pyCov.state === 'full' || pyCov.state === 'partial' || pyCov.state === 'unknown';
    const delta  = (pyKnown && pyTotal > 0) ? Math.round((cyTotal - pyTotal) / pyTotal * 1000) / 10 : null;

    const pyValue = pyKnown ? fmtC(pyTotal, '$') : 'No data';
    const pySub   = !pyKnown
      ? `Our data begins ${fmtDay(pyCov.boundary)}`
      : (delta != null ? (delta >= 0 ? '+' : '') + delta + '% vs prior'
                       : (pyCov.state === 'partial' ? `Partial — data begins ${fmtDay(pyCov.boundary)}` : '—'));

    return `
      <div class="ytd-wrap" style="display:grid;grid-template-columns:1fr 200px;gap:24px;align-items:start;">
        <div class="chart-wrap" style="height:240px"><canvas id="ytdChart"></canvas></div>
        <div class="ytd-stats">
          <div class="ad-stat" style="margin-bottom:10px"><div class="ad-stat-label">Current YTD</div><div class="ad-stat-value">${fmtC(cyTotal, '$')}</div><div class="ad-stat-sub">${cy.length} days</div></div>
          <div class="ad-stat"><div class="ad-stat-label">Prior YTD</div><div class="ad-stat-value${pyKnown ? '' : ' ad-stat-nodata'}">${pyValue}</div><div class="ad-stat-sub">${pySub}</div></div>
        </div>
      </div>
      ${!pyKnown ? `<div class="rpt-note">Prior-year comparison unavailable — our records begin ${fmtDay(pyCov.boundary)}. The chart shows this year only.</div>` : ''}`;
  },

  top_sellers: (d) => {
    const TOP_N = 10;
    const active = (d.products || []).filter(p => (p.revenueCad + p.revenueUsd + p.units) > 0);
    // Genuinely "top" sellers: ranked by combined revenue, capped at 10.
    // (Previously this listed every product with any activity, which for a
    // brand like Zellies meant the whole catalogue.)
    const ranked = [...active].sort((a, b) =>
      (b.revenueCad + b.revenueUsd) - (a.revenueCad + a.revenueUsd)
    ).slice(0, TOP_N);

    // Drop a currency column entirely if no shown product has revenue in it.
    const showCad = ranked.some(p => (p.revenueCad || 0) > 0);
    const showUsd = ranked.some(p => (p.revenueUsd || 0) > 0);

    // Inventory deliberately omitted: the counts aren't reliable enough to put
    // in front of a brand (Mike, 2026-07-14).
    const rows = ranked.map(p => {
      const full = p.title || p.asin;
      const titleShort = full.length > 60 ? full.slice(0, 60) + '…' : full;
      // title attr gives the untruncated name on hover.
      return `<tr>
        <td><span class="product-title" title="${escapeHtml(full)}">${escapeHtml(titleShort)}</span><div class="product-asin">${escapeHtml(p.asin)}</div></td>
        ${showCad ? `<td class="r">${fmtC(p.revenueCad)}</td>` : ''}
        ${showUsd ? `<td class="r">${fmtC(p.revenueUsd, 'US$')}</td>` : ''}
        <td class="r">${fmtN(p.units)}</td>
        <td class="r">${fmtN(p.sessions)}</td>
        <td class="r">${fmtPct(p.buyBox)}</td>
        <td class="r">${deltaHtml(p.units, p.prev?.units)}</td>
      </tr>`;
    }).join('');

    const cols = 5 + (showCad ? 1 : 0) + (showUsd ? 1 : 0);
    const more = active.length > TOP_N
      ? `<div class="rpt-note">Showing top ${TOP_N} of ${active.length} products by revenue.</div>` : '';

    return `<table class="rpt-table">
      <thead><tr>
        <th>Product</th>
        ${showCad ? '<th class="r">Rev CA$</th>' : ''}
        ${showUsd ? '<th class="r">Rev US$</th>' : ''}
        <th class="r">Units</th><th class="r">Sessions</th><th class="r">Buy Box</th>
        <th class="r">Δ Units</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="${cols}" style="text-align:center;color:var(--text-3)">No products with activity in this period.</td></tr>`}</tbody>
    </table>${more}`;
  },

  // Revenue share by ASIN — OPTIONAL section, off by default.
  //
  // Labels use the SUPPLIER name, not the Amazon title (Mike): "Original 12pk"
  // reads; "Zellies Cool Mint Mints, Pouch, 540 ct, Sugar Free..." does not.
  // Only ~17% of ASINs carry a supplier name today, so anything missing one
  // falls back to a truncated Amazon title and is called out beneath the chart —
  // silently mixing naming schemes would make the chart quietly untrustworthy.
  revenue_share_pie: (d) => {
    const slices = revenueShareSlices(d);
    if (!slices.length) return `<div class="rpt-placeholder">No product revenue in this period.</div>`;

    const total = slices.reduce((s, x) => s + x.revenue, 0);
    const legend = slices.map((s, i) => `
      <div class="pie-legend-row">
        <span class="pie-swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
        <span class="pie-legend-name">
          ${escapeHtml(s.label)}
          ${s.asin ? `<span class="pie-legend-asin">${escapeHtml(s.asin)}</span>` : ''}
        </span>
        <span class="pie-legend-pct">${(s.revenue / total * 100).toFixed(1)}%</span>
      </div>`).join('');

    const unnamed = slices.filter(s => s.asin && !s.named).length;
    const note = unnamed
      ? `<div class="rpt-note">${unnamed} product${unnamed === 1 ? ' has' : 's have'} no supplier name, so the Amazon title is shown instead. Set supplier names in Product Data for cleaner labels.</div>`
      : '';

    return `
      <div class="pie-wrap">
        <div class="pie-chart-box"><canvas id="revenueShareChart"></canvas></div>
        <div class="pie-legend">${legend}</div>
      </div>${note}`;
  },

  ad_trend: (d) => {
    const days = d.dailySeries || [];
    const cov  = coverageState(d, 'ads', d.period.from, d.period.to);
    if (cov.state === 'none') return adsNoDataHtml(cov);
    const hasAds = days.some(x => (x.spendCad + x.spendUsd) > 0);
    if (!hasAds) return `<div class="rpt-placeholder">No advertising activity in this period.</div>`;
    return `<div class="chart-wrap" style="height:260px"><canvas id="adTrendChart"></canvas></div>
      ${cov.state === 'partial' ? adsPartialNoteHtml(cov, d) : ''}`;
  },

  ad_summary: (d) => {
    const cov = coverageState(d, 'ads', d.period.from, d.period.to);
    if (cov.state === 'none') return adsNoDataHtml(cov);
    const ad = d.summary?.adSummary;
    if (!ad) return `<div class="rpt-placeholder">No advertising activity in this period.</div>`;
    const stat = (label, value, sub) => `<div class="ad-stat"><div class="ad-stat-label">${label}</div><div class="ad-stat-value">${value}</div>${sub ? `<div class="ad-stat-sub">${sub}</div>` : ''}</div>`;
    const totalSpend = (ad.spendCad || 0) + (ad.spendUsd || 0);
    const totalAttr  = (ad.attributedSalesCad || 0) + (ad.attributedSalesUsd || 0);
    return `
      <div class="ad-section-sub">Sales &amp; spend</div>
      <div class="ad-grid">
        ${stat('Total Ad Sales', fmtC(totalAttr, '$'), `CAD ${fmtC(ad.attributedSalesCad)} · USD ${fmtC(ad.attributedSalesUsd, 'US$')}`)}
        ${stat('Total Spend',    fmtC(totalSpend, '$'), `CAD ${fmtC(ad.spendCad)} · USD ${fmtC(ad.spendUsd, 'US$')}`)}
        ${stat('ACOS',           fmtPct(ad.acos), 'Spend ÷ ad sales')}
        ${stat('TACOS',          fmtPct(ad.tacos), 'Spend ÷ total revenue')}
      </div>
      <div class="ad-section-sub">Engagement</div>
      <div class="ad-grid ad-grid-3">
        ${stat('Impressions',    fmtN(ad.impressions), 'Times ads were shown')}
        ${stat('Clicks',         fmtN(ad.clicks), 'Times ads were clicked')}
        ${stat('Total Sessions', fmtN(d.summary?.sessions), 'All traffic — ads + organic')}
        ${stat('CPC',            ad.cpc != null ? '$' + fmt2(ad.cpc) : '—', 'Cost per click')}
        ${stat('Ad CVR',         fmtPct(ad.adCvr), `${fmtN(ad.orders)} ad orders ÷ clicks`)}
        ${stat('CTR',            fmtPct(ad.ctr, 2), 'Clicks ÷ impressions')}
      </div>
      ${cov.state === 'partial' ? adsPartialNoteHtml(cov, d) : ''}`;
  },

  inventory_status: (d) => {
    // Days of cover = on-hand ÷ daily velocity (units in period / period days).
    // Period length from the resolved dates so we work for last7d/last30d/etc.
    const products = d.products || [];
    const periodDays = Math.max(1, Math.round((new Date(d.period.to) - new Date(d.period.from)) / 86400000) + 1);
    let low = 0, warn = 0, good = 0, missing = 0;
    const rows = [];
    for (const p of products) {
      const stock = p.inventory?.onHand;
      if (stock == null) { missing++; continue; }
      const velocity = (p.units || 0) / periodDays;  // units per day
      const days = velocity > 0 ? Math.round(stock / velocity) : null;
      if (stock <= 0)        low++;
      else if (stock < 30)   low++;
      else if (stock < 100)  warn++;
      else                   good++;
      rows.push({ asin: p.asin, title: p.title || p.asin, stock, velocity, days });
    }
    // Lowest days-of-cover first (only with positive velocity, treat unknown as deprioritized).
    rows.sort((a, b) => {
      if (a.days == null && b.days == null) return 0;
      if (a.days == null) return 1;
      if (b.days == null) return -1;
      return a.days - b.days;
    });
    const top = rows.slice(0, 10);

    const tableRows = top.map(r => {
      const titleShort = (r.title.length > 50 ? r.title.slice(0, 50) + '…' : r.title);
      let cls = 'good';
      if (r.days == null) cls = '';
      else if (r.days < 14) cls = 'low';
      else if (r.days < 30) cls = 'warn';
      const daysLabel = r.days == null ? '— (no velocity)' : (r.days + ' days');
      return `<tr>
        <td><span class="product-title">${escapeHtml(titleShort)}</span><div class="product-asin">${escapeHtml(r.asin)}</div></td>
        <td class="r">${fmtN(r.stock)}</td>
        <td class="r">${r.velocity > 0 ? r.velocity.toFixed(1) + '/day' : '—'}</td>
        <td class="r">${cls ? `<span class="stock-chip ${cls}">${daysLabel}</span>` : daysLabel}</td>
      </tr>`;
    }).join('');

    return `
      <div class="ad-grid">
        <div class="ad-stat"><div class="ad-stat-label">Healthy stock</div><div class="ad-stat-value" style="color:var(--pos)">${good}</div><div class="ad-stat-sub">100+ units on hand</div></div>
        <div class="ad-stat"><div class="ad-stat-label">Warning</div><div class="ad-stat-value" style="color:var(--amber)">${warn}</div><div class="ad-stat-sub">30–99 units</div></div>
        <div class="ad-stat"><div class="ad-stat-label">Low / out</div><div class="ad-stat-value" style="color:var(--neg)">${low}</div><div class="ad-stat-sub">Under 30 units</div></div>
        <div class="ad-stat"><div class="ad-stat-label">No data</div><div class="ad-stat-value" style="color:var(--text-3)">${missing}</div><div class="ad-stat-sub">Inventory not synced</div></div>
      </div>
      ${top.length ? `
      <div class="ad-section-sub">Lowest days of cover</div>
      <table class="rpt-table">
        <thead><tr><th>Product</th><th class="r">On hand</th><th class="r">Velocity</th><th class="r">Days of cover</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>` : ''}`;
  },
};
