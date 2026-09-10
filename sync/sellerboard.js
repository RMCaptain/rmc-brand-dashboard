'use strict';
/**
 * Sellerboard feed ingest — Settings → Automation → Product Dashboard report,
 * delivered as a CSV behind a permanent secure link. One link per Sellerboard
 * account; each fetch returns the latest generated file, which covers a
 * trailing ~32-day window per (day, marketplace, SKU). Rows land in
 * sellerboard_daily (sql/sellerboard-daily.sql) via upsert, so a restated day
 * simply overwrites itself on the next fetch.
 *
 * Feed links are credentials: env only (SELLERBOARD_FEED_<KEY>), never logged
 * in full, never committed.
 *
 * The CSV format was captured from the live RMC feed on 2026-09-09 and its
 * column→dashboard mapping verified against Sellerboard's own dashboard for
 * 2026-09-08 Amazon.ca to the penny (sales, units, fees, ads, net profit).
 * Headers are matched by NAME after normalization (the live file spells
 * "SponsoredBrands" with a Cyrillic В), so column order is irrelevant.
 *
 * Sign convention on the way in: Sellerboard writes costs negative; the
 * normalized columns store money-out POSITIVE (dashboard convention). See the
 * table header comment. The raw row is kept verbatim in `raw`.
 *
 * CURRENCY: every money column in a feed is in the Sellerboard ACCOUNT's
 * currency, not the marketplace's — "Rocky Mountain Co" is a USD account, so
 * its Amazon.ca rows arrive in USD (first live reconciliation, 2026-09-09:
 * CA sales came in at exactly the day's CAD→USD rate, US matched to the
 * penny). Rows are converted to the marketplace's native currency at ingest
 * with the day's rate; `feed_currency` / `fx_rate` / `fx_source` record it and
 * `raw` keeps the account-currency figures. Where Amazon's own numbers for
 * that marketplace-day agree on units, the implied rate (Amazon native sales
 * ÷ Sellerboard feed sales) is Sellerboard's exact rate for the day and is
 * preferred over the external one.
 *
 * DAY BOUNDARY: the feed's day is the marketplace's local calendar day — for
 * Amazon NA that is Pacific time, the dashboard's own day (US daily sales
 * match Amazon's S&T figures to the cent). Not UTC.
 */

const MP = require('./marketplaces');
const FX = require('./fxRates');

// `currency` is the Sellerboard account's display currency (Sellerboard
// Settings → account; confirmed via the Sellerboard connector 2026-09-09).
// Change it here if the account setting changes — every feed row is stored
// converted from it.
const FEEDS = [
  { key: 'RMC',  env: 'SELLERBOARD_FEED_RMC',  currency: 'USD', label: 'Rocky Mountain Co (Amazon CA/US)' },
  { key: 'WMCA', env: 'SELLERBOARD_FEED_WMCA', currency: 'CAD', label: 'RMC WMCA (Walmart.ca)' },
  { key: 'INTL', env: 'SELLERBOARD_FEED_INTL', currency: 'USD', label: 'RMCo Intl (Amazon UK/EU)' },
];

// Money columns converted feed-currency → marketplace-native at ingest.
const MONEY_COLS = [
  'sales', 'sales_ppc', 'sales_sd', 'refund_amount', 'refund_costs', 'promo_value',
  'ad_spend', 'ad_spend_sp', 'ad_spend_sb', 'ad_spend_sbv', 'ad_spend_sd',
  'amazon_fees', 'fee_charges', 'reimbursements', 'storage_fees', 'order_fees', 'product_costs',
  'est_payout', 'gross_profit', 'net_profit',
];
// Implied-rate guard: accept Amazon÷Sellerboard sales as the day's rate only
// when units agree within 2%, both sides sold at least this much, and the
// result sits within 4% of the external rate (a wrong S&T day can't poison it).
const IMPLIED = { unitsPct: 0.02, minSales: 200, maxDrift: 0.04, minAsins: 3, minAsinSales: 50 };

const NOT_READY_RE = /report not ready/i;

// ── CSV parsing ──────────────────────────────────────────────────────────────

// Minimal RFC-4180 parser: quoted fields, doubled quotes, CRLF/LF. The feed is
// ~6 MB / ~10k rows — a hand parser keeps the dependency list flat.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Header normalization: trim, collapse whitespace, fold the Cyrillic В (U+0412)
// the live file uses in "SponsoredВrands" to a Latin B, lower-case.
function normHeader(h) {
  return String(h || '').replace(/В/g, 'B').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Sellerboard dates are M/D/YYYY. Returns YYYY-MM-DD or null.
function parseSbDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const money = v => Math.round(v * 100) / 100;

// Fee columns in the live file sit between "Commission" and "EstimatedPayout"
// (inclusive of every Amazon fee/reimbursement code). Matched by name so a new
// fee code Sellerboard adds is picked up only if it lands in this list — the
// raw row keeps it regardless. Verified sum = dashboard AmazonFees.
const FEE_COLS = [
  'commission', 'compensated_clawback', 'fbadisposalfee', 'fbainboundconveniencefee',
  'fbainboundtransportationfee', 'fbalongtermstoragefee', 'fbaperunitfulfillmentfee',
  'fbaremovalfee', 'fbastoragefee', 'free_replacement_refund_items', 'inbound_carrier_damage',
  'missing_from_inbound', 'missing_from_inbound_clawback', 're_evaluation',
  'reversal_reimbursement', 'salestaxcollectionfee', 'warehouse_damage',
  'warehouse_damage_exception', 'warehouse_lost', 'warehouse_lost_manual',
];
const REFUND_COST_COLS = [
  'refund commission', 'refund principal', 'refund promotion', 'refund refundcommission',
  'refundscostsdamaged', 'value of returned items', 'productcost unsellable refunds',
];
const PRODUCT_COST_COLS = [
  'productcost sales', 'productcost non-amazon', 'productcost multichannelcosts',
  'productcost missingfrominbound', 'productcost costofmissingreturns',
];
const REQUIRED = ['date', 'marketplace', 'asin', 'sku'];

/**
 * Parse a feed CSV into normalized sellerboard_daily rows.
 * Returns { rows, skipped: { unknownMarketplace: {name: count}, badDate, noKey }, headers }.
 * `asinBrand` maps ASIN → brand_id (from the brands blob); unmapped → 'unknown-brand'.
 */
function parseFeed(text, { account = null, asinBrand = {}, feedCurrency = null } = {}) {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], skipped: {}, headers: [] };
  const headers = table[0].map(normHeader);
  const idx = {};
  headers.forEach((h, i) => { if (!(h in idx)) idx[h] = i; });
  const missing = REQUIRED.filter(h => !(h in idx));
  if (missing.length) throw new Error(`Sellerboard feed: required column(s) missing: ${missing.join(', ')} — headers: ${headers.slice(0, 8).join(' | ')}…`);

  const get = (r, h) => (idx[h] == null ? '' : (r[idx[h]] ?? ''));
  const sum = (r, cols) => cols.reduce((s, c) => s + num(get(r, c)), 0);

  const rows = [];
  const skipped = { unknownMarketplace: {}, badDate: 0, noKey: 0 };
  const fetchedAt = new Date().toISOString();

  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    if (r.length < 4) continue;
    const date = parseSbDate(get(r, 'date'));
    if (!date) { skipped.badDate++; continue; }
    const mpName = get(r, 'marketplace');
    const mp = MP.bySellerboardName(mpName);
    if (!mp) { skipped.unknownMarketplace[mpName || '(blank)'] = (skipped.unknownMarketplace[mpName || '(blank)'] || 0) + 1; continue; }
    const sku = String(get(r, 'sku')).trim();
    const asin = String(get(r, 'asin')).trim().toUpperCase();
    if (!sku || !asin) { skipped.noKey++; continue; }

    const raw = {};
    headers.forEach((h, j) => { raw[table[0][j]] = r[j]; });

    const salesOrganic = num(get(r, 'salesorganic'));
    const salesPpc     = num(get(r, 'salesppc'));
    const sessionsRaw  = get(r, 'sessions');
    const uspRaw       = get(r, 'unit session percentage');
    rows.push({
      date, mp_id: mp.id, sku, asin,
      currency: mp.currency,
      feed_currency: feedCurrency || mp.currency,   // money below is in this until convertRows() runs
      fx_rate: 1,
      fx_source: 'same',
      account,
      brand_id: asinBrand[asin] || 'unknown-brand',
      name: String(get(r, 'name')).slice(0, 500) || null,
      channel: String(get(r, 'fulfillment channel')).trim() || null,
      sales:        money(salesOrganic + salesPpc),
      sales_ppc:    money(salesPpc),
      sales_sd:     money(num(get(r, 'salessponsoreddisplay'))),
      units:        Math.round(num(get(r, 'unitsorganic')) + num(get(r, 'unitsppc'))),
      units_ppc:    Math.round(num(get(r, 'unitsppc'))),
      refunds:      Math.round(num(get(r, 'refunds'))),
      refund_amount: money(-num(get(r, 'refund principal'))),
      refund_costs:  money(-sum(r, REFUND_COST_COLS)),
      promo_value:   money(-num(get(r, 'promovalue'))),
      ad_spend:      money(-num(get(r, 'ads spend'))),
      ad_spend_sp:   money(-num(get(r, 'sponsoredproducts'))),
      ad_spend_sb:   money(-num(get(r, 'sponsoredbrands'))),
      ad_spend_sbv:  money(-num(get(r, 'sponsoredbrandsvideo'))),
      ad_spend_sd:   money(-num(get(r, 'sponsoreddisplay'))),
      amazon_fees:   money(-sum(r, FEE_COLS)),
      // Split of the same columns by sign: charges (Sellerboard negative) vs
      // reimbursements (positive — lost/damaged inventory, re-evaluations).
      // Amazon's Finances walk counts charges only, so the reconciliation
      // compares fee_charges; amazon_fees stays Sellerboard's netted figure.
      fee_charges:   money(-FEE_COLS.reduce((s, c) => s + Math.min(0, num(get(r, c))), 0)),
      reimbursements: money(FEE_COLS.reduce((s, c) => s + Math.max(0, num(get(r, c))), 0)),
      storage_fees:  money(-(num(get(r, 'fbastoragefee')) + num(get(r, 'fbalongtermstoragefee')))),
      // Per-order fees only (referral + FBA per-unit + sales-tax collection):
      // the basis of daily_fees_*.fees, whose storage / inbound / removal sit
      // in service_fees instead. This is what the reconciliation compares.
      order_fees:    money(-(num(get(r, 'commission')) + num(get(r, 'fbaperunitfulfillmentfee')) + num(get(r, 'salestaxcollectionfee')))),
      product_costs: money(-sum(r, PRODUCT_COST_COLS)),
      est_payout:    money(num(get(r, 'estimatedpayout'))),
      gross_profit:  money(num(get(r, 'grossprofit'))),
      net_profit:    money(num(get(r, 'netprofit'))),
      margin:        get(r, 'margin') === '' ? null : num(get(r, 'margin')),
      sessions:      sessionsRaw === '' ? null : Math.round(num(sessionsRaw)),
      unit_session_pct: uspRaw === '' ? null : num(uspRaw),
      raw,
      fetched_at: fetchedAt,
    });
  }
  return { rows, skipped, headers };
}

// ── Currency conversion ──────────────────────────────────────────────────────

/**
 * Convert parsed rows from the feed currency into each row's marketplace
 * currency. `rateFor(date, from, to)` → { rate, source } (sync/fxRates.js);
 * `implied` is an optional { `${mp_id}|${date}`: rate } map that wins where
 * present. Mutates and returns rows; rows already native are left alone.
 */
function convertRows(rows, { rateFor, implied = {} } = {}) {
  const stats = {};
  for (const r of rows) {
    if (r.feed_currency === r.currency) continue;
    const key = `${r.mp_id}|${r.date}`;
    let rate, source;
    if (implied[key]) { rate = implied[key]; source = 'implied'; }
    else if (rateFor) ({ rate, source } = rateFor(r.date, r.feed_currency, r.currency));
    else { rate = 1; source = 'none'; }
    for (const c of MONEY_COLS) if (r[c] != null) r[c] = money(r[c] * rate);
    r.fx_rate = rate; r.fx_source = source;
    stats[source] = (stats[source] || 0) + 1;
  }
  return { rows, stats };
}

/**
 * Sellerboard's own rate for a marketplace-day, implied by Amazon's native
 * sales ÷ the feed's account-currency sales — exact where both sides count
 * the same units. `amazonMpDay` is { `${mp_id}|${date}`: { units, sales } }
 * (native currency). Returns { `${mp_id}|${date}`: rate } for accepted days.
 */
function impliedRates(rows, amazonMpDay, rateFor) {
  const sb = {};
  for (const r of rows) {
    if (r.feed_currency === r.currency) continue;
    const k = `${r.mp_id}|${r.date}`;
    const s = sb[k] || (sb[k] = { units: 0, sales: 0, from: r.feed_currency, to: r.currency, byAsin: {} });
    s.units += r.units; s.sales += r.sales;
    const a = s.byAsin[r.asin] || (s.byAsin[r.asin] = { units: 0, sales: 0 });
    a.units += r.units; a.sales += r.sales;
  }
  const out = {};
  for (const [k, s] of Object.entries(sb)) {
    const a = amazonMpDay[k];
    if (!a || s.sales < IMPLIED.minSales || a.sales < IMPLIED.minSales) continue;
    if (!s.units || Math.abs(a.units - s.units) / s.units > IMPLIED.unitsPct) continue;
    // Sellerboard applies ONE rate per day, so per-ASIN ratios cluster on it.
    // The median of ASINs whose units agree exactly is immune to a single
    // product's genuine sales discrepancy (which the account ratio would
    // otherwise smear across every other product that day). Fewer than
    // IMPLIED.minAsins qualifying → account ratio.
    const ratios = [];
    for (const [asin, sa] of Object.entries(s.byAsin)) {
      const aa = a.byAsin?.[asin];
      if (!aa || aa.units !== sa.units || sa.sales < IMPLIED.minAsinSales) continue;
      ratios.push(aa.sales / sa.sales);
    }
    ratios.sort((x, y) => x - y);
    const mid = ratios.length >> 1;
    const raw = ratios.length >= IMPLIED.minAsins
      ? (ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2)
      : a.sales / s.sales;
    const rate = Math.round(raw * 100000) / 100000;
    const ext = rateFor ? rateFor(k.split('|')[1], s.from, s.to).rate : null;
    if (ext && Math.abs(rate - ext) / ext > IMPLIED.maxDrift) continue;
    out[k] = rate;
  }
  return out;
}

// Amazon-side native sales per marketplace-day (and per ASIN within it) for
// the implied rate.
async function loadAmazonMpDay(supabase, from, to) {
  const out = {};
  for (let off = 0; ; off += 1000) {
    const { data, error } = await supabase.from('daily_metrics_mp').select('date,mp_id,asin,units,revenue')
      .gte('date', from).lte('date', to).gt('units', 0)
      .order('date', { ascending: true }).order('asin', { ascending: true }).order('mp_id', { ascending: true })
      .range(off, off + 999);
    if (error) throw new Error(`daily_metrics_mp read failed: ${error.message}`);
    for (const r of data || []) {
      const k = `${r.mp_id}|${r.date}`;
      const s = out[k] || (out[k] = { units: 0, sales: 0, byAsin: {} });
      const u = Number(r.units) || 0, v = Number(r.revenue) || 0;
      s.units += u; s.sales += v;
      const a = s.byAsin[r.asin] || (s.byAsin[r.asin] = { units: 0, sales: 0 });
      a.units += u; a.sales += v;
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchFeed(url, { timeoutMs = 120000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
    if (text.length < 200 && NOT_READY_RE.test(text)) return { notReady: true, text };
    return { notReady: false, text };
  } finally {
    clearTimeout(t);
  }
}

// ── Upsert ───────────────────────────────────────────────────────────────────

async function upsertRows(supabase, rows, tag) {
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('sellerboard_daily').upsert(batch, { onConflict: 'date,mp_id,sku' });
    if (error) throw new Error(`[${tag}] upsert failed at row ${i}: ${error.message}`);
    written += batch.length;
  }
  return written;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Fetch every configured feed and upsert. Never throws for one feed's
 * failure — each feed reports its own outcome so a Walmart hiccup can't
 * block the Amazon rows. Returns { feeds: [{ key, status, rows, window, skipped, error }] }.
 * status: 'ok' | 'not_ready' | 'unconfigured' | 'error'
 */
async function syncSellerboardFeeds({ supabase, loadBrands, label = 'Sellerboard', liveToCad = null }) {
  const asinBrand = {};
  try {
    const { brands } = await loadBrands();
    for (const b of brands || []) for (const a of (b.asins || [])) asinBrand[a] = b.id;
  } catch (e) {
    console.warn(`[${label}] brands blob unavailable (${e.message}) — rows stamped unknown-brand`);
  }

  // FX for feeds whose account currency differs from a marketplace's: daily
  // rows from fx_rates, else the live rate (passed in or fetched), else static.
  let rateFor = null, amazonMpDay = null;
  const getRateFor = async (from, to) => {
    if (rateFor) return rateFor;
    const daily = await FX.loadDailyRates(supabase, from, to);
    const live = liveToCad || await FX.fetchLatestToCad();
    rateFor = FX.makeRateResolver({ daily, live });
    return rateFor;
  };
  const getAmazonMpDay = async (from, to) => {
    if (amazonMpDay) return amazonMpDay;
    try { amazonMpDay = await loadAmazonMpDay(supabase, from, to); }
    catch (e) { console.warn(`[${label}] Amazon mp-day sales unavailable for implied FX (${e.message}) — external rate only`); amazonMpDay = {}; }
    return amazonMpDay;
  };

  const out = { feeds: [], startedAt: new Date().toISOString() };
  for (const feed of FEEDS) {
    const url = process.env[feed.env];
    if (!url) { out.feeds.push({ key: feed.key, status: 'unconfigured' }); continue; }
    const tag = `${label}:${feed.key}`;
    try {
      const { notReady, text } = await fetchFeed(url);
      if (notReady) {
        console.warn(`[${tag}] feed not ready yet (Sellerboard still generating) — will retry on the backup cron`);
        out.feeds.push({ key: feed.key, status: 'not_ready' });
        continue;
      }
      const { rows, skipped } = parseFeed(text, { account: feed.key, asinBrand, feedCurrency: feed.currency });
      for (const [name, n] of Object.entries(skipped.unknownMarketplace)) {
        console.error(`[${tag}] ${n} row(s) for marketplace "${name}" skipped — not in sync/marketplaces.js registry (add a \`sellerboard\` name to the entry)`);
      }
      if (skipped.badDate || skipped.noKey) console.warn(`[${tag}] skipped ${skipped.badDate} bad-date + ${skipped.noKey} keyless row(s)`);
      const dates = rows.map(r => r.date);
      const window = dates.length ? { from: dates.reduce((a, b) => (a < b ? a : b)), to: dates.reduce((a, b) => (a > b ? a : b)) } : null;
      let fx = null;
      if (rows.some(r => r.feed_currency !== r.currency)) {
        const rf = await getRateFor(window.from, window.to);
        const implied = impliedRates(rows, await getAmazonMpDay(window.from, window.to), rf);
        fx = convertRows(rows, { rateFor: rf, implied }).stats;
        console.log(`[${tag}] converted ${feed.currency} → native: ${Object.entries(fx).map(([k, v]) => `${k}=${v}`).join(' ')} rows (${Object.keys(implied).length} marketplace-days on Sellerboard's implied rate)`);
      }
      const written = await upsertRows(supabase, rows, tag);
      const byMp = {};
      for (const r of rows) byMp[MP.codeOf(r.mp_id) || r.mp_id] = (byMp[MP.codeOf(r.mp_id) || r.mp_id] || 0) + 1;
      console.log(`[${tag}] ${written} rows upserted, window ${window?.from}..${window?.to}, ${Object.entries(byMp).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      out.feeds.push({ key: feed.key, status: 'ok', rows: written, window, byMp, skipped, fx });
    } catch (e) {
      console.error(`[${tag}] failed: ${e.message}`);
      out.feeds.push({ key: feed.key, status: 'error', error: e.message });
    }
  }
  out.finishedAt = new Date().toISOString();
  return out;
}

module.exports = { FEEDS, MONEY_COLS, IMPLIED, parseCsv, parseFeed, parseSbDate, normHeader, fetchFeed, convertRows, impliedRates, loadAmazonMpDay, syncSellerboardFeeds, FEE_COLS, REFUND_COST_COLS, PRODUCT_COST_COLS };
