'use strict';
/**
 * Master-sheet tab writer — projects dashboard data into each brand's Master
 * Google Sheet every Monday: "Ads (auto)" (ad performance from daily_metrics)
 * and "Inventory (auto)" (per-ASIN FBA stock + days of cover + weekly on-hand
 * history; current stock from the preset_metrics blob, history from
 * daily_metrics.inventory_on_hand which the post-sync traffic writer has been
 * snapshotting daily — no separate inventory pull exists or is needed).
 *
 * The DATABASE is the permanent ads history (daily_metrics, ASIN-level daily
 * since 2026-04-11; the 9:10 UTC cron re-pulls a trailing 30d window daily, so
 * Amazon's 14-day attribution restatements self-correct and older data is
 * effectively solidified). The sheet tab is a READ-ONLY projection of it,
 * fully rebuilt on every run — never a data store. Deleting the tab loses
 * nothing.
 *
 * Auth: Google service account (rmc-sheets-writer@rmc-dashboard-sheets).
 * Each Master sheet must be shared with that email as Editor. Credentials
 * resolve from, in order:
 *   GOOGLE_SERVICE_ACCOUNT_B64 (base64 JSON) → GOOGLE_SERVICE_ACCOUNT (raw
 *   JSON) → GOOGLE_SERVICE_ACCOUNT_FILE (path) → ./google-service-account.json
 * Missing credentials or an unshared sheet skip cleanly with a warning.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs   = require('fs');
const path = require('path');
const { google } = require('googleapis');

const ADS_HISTORY_START = '2026-04-11'; // earlier Ads data was past Amazon's ~95d retention when syncing began — gone forever
const TAB_ADS = 'Ads (auto)';
const TAB_INV = 'Inventory (auto)';
const INV_HISTORY_WEEKS = 13;

// brand_id → Master sheet. Which brands get a tab is controlled by which
// sheets Mike shares with the service account — add a row here after sharing.
const BRAND_SHEETS = {
  'acure':             '1gjraYdbBBXyZAMViPFrjVP9n6bxvIed3GiqpyRXgRlg',
  'big-league-chew':   '1qlG3WkK5d9tZ7pzI8t-4K1mTU0J92O7gZVKom_Bbrkk',
  'zellies':           '1LL5jE1BVjsboG8wwSwIFNcMJEnWMSBwN4Y1Oz9q6wuA',
  'trimax':            '17VJq_eHD5ri5C3vB3Y4vDQNtsWZJ1zKkys9DNLZ1GiA',
  'supreme-petfoods':  '1Do5qyHOox5ICxTSCHnE8jntRXjJSg56DYVP79HCsIG4',
  'kidstar-nutrients': '1EWyLoJwQYOhC5B5WcHPvLYM8Vk90UT4ukSXkS2YFLdQ',
};

// ── Auth ──────────────────────────────────────────────────────────────────────

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
  }
  const file = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(__dirname, '../google-service-account.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return null;
}

async function getSheetsClient() {
  const credentials = loadCredentials();
  if (!credentials) return null;
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth: await auth.getClient() });
}

// ── Date helpers (all on YYYY-MM-DD strings, PST day boundary upstream) ──────

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dayOfWeek(dateStr) { // 0=Sun … 6=Sat
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function monthOf(dateStr)   { return dateStr.slice(0, 7); }               // 'YYYY-MM'
function monthStart(ym)     { return `${ym}-01`; }
function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function prevMonthOf(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function fmtDate(dateStr) { // 'Aug 5'
  const [y, m, d] = dateStr.split('-').map(Number);
  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${MON[m - 1]} ${d}`;
}
function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const MON = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${MON[m - 1]} ${y}`;
}

// ── Data ──────────────────────────────────────────────────────────────────────

// Per-date brand aggregates from daily_metrics (paginated past the 1000-row cap).
//
// Sales/orders prefer the 7-DAY attribution columns — that's what the Ads
// console shows sellers for Sponsored Products, so the tab reconciles against
// May's campaign-manager view. Rows older than Amazon's ~95d retention predate
// the 7d backfill (NULL) and fall back to 14d — only April–early-May 2026.
//
// Pagination is ordered by (date, asin) — a UNIQUE key, so page boundaries are
// stable even while other syncs write. Ordering by date alone lets Postgres
// return same-date rows in any physical order per request, which under
// concurrent writes double-serves early rows and drops the tail. The count and
// duplicate guards turn any such shred into a loud failure instead of a
// silently wrong sheet.
async function fetchBrandDaily(supabase, brandId) {
  const { count, error: cntErr } = await supabase
    .from('daily_metrics')
    .select('*', { count: 'exact', head: true })
    .eq('brand_id', brandId)
    .gte('date', ADS_HISTORY_START);
  if (cntErr) throw new Error(`daily_metrics count (${brandId}): ${cntErr.message}`);

  const byDate = {};
  const seen = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('date,asin,spend_cad,spend_usd,attributed_sales_cad,attributed_sales_usd,attributed_sales_7d_cad,attributed_sales_7d_usd,ad_clicks,ad_impressions,ad_orders,ad_orders_7d,revenue_cad,revenue_usd')
      .eq('brand_id', brandId)
      .gte('date', ADS_HISTORY_START)
      .order('date', { ascending: true })
      .order('asin', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`daily_metrics fetch (${brandId}): ${error.message}`);
    for (const r of (data || [])) {
      const k = `${r.date}|${r.asin}`;
      if (seen.has(k)) throw new Error(`daily_metrics read shred (${brandId}): duplicate ${k} across pages — table changing under the read, retry later`);
      seen.add(k);
      const e = byDate[r.date] || (byDate[r.date] = { spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0, revCad: 0, revUsd: 0 });
      e.spendCad    += Number(r.spend_cad || 0);
      e.spendUsd    += Number(r.spend_usd || 0);
      e.salesCad    += Number(r.attributed_sales_7d_cad ?? r.attributed_sales_cad ?? 0);
      e.salesUsd    += Number(r.attributed_sales_7d_usd ?? r.attributed_sales_usd ?? 0);
      e.clicks      += Number(r.ad_clicks      || 0);
      e.impressions += Number(r.ad_impressions || 0);
      e.orders      += Number(r.ad_orders_7d   ?? r.ad_orders ?? 0);
      e.revCad      += Number(r.revenue_cad || 0); // total revenue → TACOS denominator
      e.revUsd      += Number(r.revenue_usd || 0);
    }
    if (!data || data.length < PAGE) break;
  }
  if (seen.size !== count) {
    throw new Error(`daily_metrics read shred (${brandId}): paged ${seen.size} rows but count says ${count} — table changing under the read, retry later`);
  }
  return byDate;
}

// SB/SD campaign-level rollups from daily_brand_ads → { [ym]: { SB: t, SD: t } }
// (t matches the metricRow shape). Small table — one page covers years.
async function fetchBrandSbSd(supabase, brandId) {
  const byMonth = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('daily_brand_ads')
      .select('date,ad_product,spend_cad,spend_usd,sales_cad,sales_usd,clicks,impressions,orders')
      .eq('brand_id', brandId)
      .order('date', { ascending: true })
      .order('ad_product', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`daily_brand_ads fetch (${brandId}): ${error.message}`);
    for (const r of (data || [])) {
      const ym = r.date.slice(0, 7);
      const m = byMonth[ym] || (byMonth[ym] = {});
      const e = m[r.ad_product] || (m[r.ad_product] = { spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0, days: 0 });
      e.spendCad += Number(r.spend_cad || 0); e.spendUsd += Number(r.spend_usd || 0);
      e.salesCad += Number(r.sales_cad || 0); e.salesUsd += Number(r.sales_usd || 0);
      e.clicks += Number(r.clicks || 0); e.impressions += Number(r.impressions || 0); e.orders += Number(r.orders || 0);
      e.days++;
    }
    if (!data || data.length < PAGE) break;
  }
  return byMonth;
}

function sumRange(byDate, from, to) {
  const t = { spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0, revCad: 0, revUsd: 0, days: 0 };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const e = byDate[d];
    if (!e) continue;
    t.days++;
    for (const k of ['spendCad','spendUsd','salesCad','salesUsd','clicks','impressions','orders','revCad','revUsd']) t[k] += e[k] || 0;
  }
  return t;
}

const round2 = v => Math.round(v * 100) / 100;

// One table row: [label, Spend CA, Sales CA, ACOS CA, Spend US, Sales US, ACOS US, Clicks, Impr, CTR, Orders, CVR]
function metricRow(label, t) {
  if (!t || t.days === 0) return [label, '', '', '', '', '', '', '', '', '', '', 'no data'];
  return [
    label,
    round2(t.spendCad), round2(t.salesCad), t.salesCad > 0 ? t.spendCad / t.salesCad : '',
    round2(t.spendUsd), round2(t.salesUsd), t.salesUsd > 0 ? t.spendUsd / t.salesUsd : '',
    t.clicks, t.impressions, t.impressions > 0 ? t.clicks / t.impressions : '',
    t.orders, t.clicks > 0 ? t.orders / t.clicks : '',
  ];
}

// Δ row: % change for money/volume columns, point change for rate columns.
function deltaRow(label, cur, prev) {
  if (!cur || !prev || cur.days === 0 || prev.days === 0) return [label, '', '', '', '', '', '', '', '', '', '', ''];
  const pct  = (c, p) => (p > 0 ? (c - p) / p : '');
  const rate = (c, cd, p, pd) => (cd > 0 && pd > 0 ? c / cd - p / pd : '');
  return [
    label,
    pct(cur.spendCad, prev.spendCad), pct(cur.salesCad, prev.salesCad), rate(cur.spendCad, cur.salesCad, prev.spendCad, prev.salesCad),
    pct(cur.spendUsd, prev.spendUsd), pct(cur.salesUsd, prev.salesUsd), rate(cur.spendUsd, cur.salesUsd, prev.spendUsd, prev.salesUsd),
    pct(cur.clicks, prev.clicks), pct(cur.impressions, prev.impressions), rate(cur.clicks, cur.impressions, prev.clicks, prev.impressions),
    pct(cur.orders, prev.orders), rate(cur.orders, cur.clicks, prev.orders, prev.clicks),
  ];
}

const HEADER = ['Period', 'Spend CA (CAD)', 'Ad Sales CA (CAD)', 'ACOS CA', 'Spend US (USD)', 'Ad Sales US (USD)', 'ACOS US', 'Clicks', 'Impressions', 'CTR', 'Orders', 'CVR'];

// ── Tab content ───────────────────────────────────────────────────────────────

// Ads tab. Returns { values, boldRows, headerRows, deltaRows, bands, colWidths }.
const ADS_BANDS = [
  { c0: 1, c1: 3,  pattern: '$#,##0.00', type: 'CURRENCY' }, // Spend/Sales CA
  { c0: 4, c1: 6,  pattern: '$#,##0.00', type: 'CURRENCY' }, // Spend/Sales US
  { c0: 3, c1: 4,  pattern: '0.0%',  type: 'PERCENT' },      // ACOS CA
  { c0: 6, c1: 7,  pattern: '0.0%',  type: 'PERCENT' },      // ACOS US
  { c0: 7, c1: 9,  pattern: '#,##0', type: 'NUMBER' },       // Clicks, Impressions
  { c0: 9, c1: 10, pattern: '0.00%', type: 'PERCENT' },      // CTR
  { c0: 10, c1: 11, pattern: '#,##0', type: 'NUMBER' },      // Orders
  { c0: 11, c1: 12, pattern: '0.0%', type: 'PERCENT' },      // CVR
];
const ADS_WIDTHS = [{ c0: 0, c1: 1, px: 300 }, { c0: 1, c1: 12, px: 105 }];

function buildTabValues(byDate, dataThrough, todayStr, sbSd = {}) {
  const values = [];
  const boldRows = [], headerRows = [], deltaRows = [];
  const push = row => { values.push(row); return values.length - 1; };
  const section = title => boldRows.push(push([title]));
  const header  = () => headerRows.push(push(HEADER));
  const blank   = () => push([]);

  boldRows.push(push(['AMAZON ADS (CA + US) — AUTO-GENERATED. Do not edit: this tab is rebuilt every Monday by the RMC dashboard. Manual notes belong on your own tabs.']));
  push([`Updated ${todayStr} · data through ${dataThrough} · history starts ${ADS_HISTORY_START} · sales & orders use 7-DAY attribution (what the Ads console shows for Sponsored Products) — before 2026-05-08 only 14-day exists and is shown for those dates · SP sections; SB/Display tracked from Jun 2026 at the bottom`]);
  blank();

  // Month to date, paced against the same days of the prior month
  const ym = monthOf(dataThrough);
  const mtd = sumRange(byDate, monthStart(ym), dataThrough);
  const pm  = prevMonthOf(ym);
  const pmSameDay = `${pm}-${dataThrough.slice(8)}`; // same day-of-month, clamped to month length
  const pmPaceEnd = pmSameDay > monthEnd(pm) ? monthEnd(pm) : pmSameDay;
  const pmPace = sumRange(byDate, monthStart(pm), pmPaceEnd);
  section(`MONTH TO DATE (Sponsored Products) — ${fmtDate(monthStart(ym))}–${fmtDate(dataThrough)}`);
  header();
  push(metricRow(`MTD (${fmtDate(monthStart(ym))}–${fmtDate(dataThrough)})`, mtd));
  push(metricRow(`Prior month, same days (${fmtDate(monthStart(pm))}–${fmtDate(pmPaceEnd)})`, pmPace));
  deltaRows.push(push(deltaRow('Δ vs prior-month pace', mtd, pmPace)));
  blank();

  // Week over week — last complete Mon–Sun week vs the one before
  const wkEnd   = dayOfWeek(dataThrough) === 0 ? dataThrough : addDays(dataThrough, -dayOfWeek(dataThrough));
  const wkStart = addDays(wkEnd, -6);
  const pwEnd   = addDays(wkStart, -1);
  const pwStart = addDays(pwEnd, -6);
  const wk = sumRange(byDate, wkStart, wkEnd);
  const pw = sumRange(byDate, pwStart, pwEnd);
  section('WEEK OVER WEEK (Sponsored Products) — last complete week (Mon–Sun)');
  header();
  push(metricRow(`Week ${fmtDate(wkStart)}–${fmtDate(wkEnd)}`, wk));
  push(metricRow(`Week ${fmtDate(pwStart)}–${fmtDate(pwEnd)}`, pw));
  deltaRows.push(push(deltaRow('Δ week over week', wk, pw)));
  blank();

  // Month over month — last complete month vs the one before
  const lm  = monthEnd(ym) === dataThrough ? ym : prevMonthOf(ym);
  const lm2 = prevMonthOf(lm);
  const lmT  = sumRange(byDate, monthStart(lm),  monthEnd(lm));
  const lm2T = sumRange(byDate, monthStart(lm2), monthEnd(lm2));
  section('MONTH OVER MONTH (Sponsored Products) — last complete month');
  header();
  push(metricRow(fmtMonth(lm), lmT));
  push(metricRow(fmtMonth(lm2), lm2T));
  deltaRows.push(push(deltaRow('Δ month over month', lmT, lm2T)));
  blank();

  // Weekly history — every complete Mon–Sun week, newest first
  section('WEEKLY HISTORY (Sponsored Products, Mon–Sun, newest first — rebuilt from the database each run)');
  header();
  for (let end = wkEnd; end >= ADS_HISTORY_START; end = addDays(end, -7)) {
    const start = addDays(end, -6);
    const partial = start < ADS_HISTORY_START;
    const t = sumRange(byDate, partial ? ADS_HISTORY_START : start, end);
    push(metricRow(`${fmtDate(start)}–${fmtDate(end)}${partial ? ' (partial — history starts Apr 11)' : ''}`, t));
  }
  blank();

  // Monthly history — complete months, newest first
  section('MONTHLY HISTORY (Sponsored Products, newest first)');
  header();
  for (let m = lm; m >= monthOf(ADS_HISTORY_START); m = prevMonthOf(m)) {
    const partial = m === monthOf(ADS_HISTORY_START);
    const t = sumRange(byDate, partial ? ADS_HISTORY_START : monthStart(m), monthEnd(m));
    push(metricRow(`${fmtMonth(m)}${partial ? ' (partial — history starts Apr 11)' : ''}`, t));
  }

  // Sponsored Brands / Display — campaign-level, so they live in their own
  // block instead of the ASIN-based SP sections. Console reconciliation:
  // SP rows above + these = the account's total ad spend for the brand.
  const SBSD_START = '2026-06';
  const kinds = ['SB', 'SD'].filter(k => Object.values(sbSd).some(m => m[k]));
  blank();
  if (kinds.length === 0) {
    section('SPONSORED BRANDS + DISPLAY — no activity recorded (tracked from Jun 2026; Amazon retains SB/SD only ~60 days, earlier is unrecoverable)');
  } else {
    const KIND_LABEL = { SB: 'Sponsored Brands', SD: 'Sponsored Display' };
    section('SPONSORED BRANDS + DISPLAY — monthly, newest first (campaign-level; tracked from Jun 2026, earlier is past Amazon\'s ~60d SB/SD retention)');
    header();
    for (let m = lm; m >= SBSD_START; m = prevMonthOf(m)) {
      for (const k of kinds) {
        const t = sbSd[m]?.[k];
        push(metricRow(`${fmtMonth(m)}${m === SBSD_START ? ' (partial — tracking begins mid-June)' : ''} — ${KIND_LABEL[k]}`, t));
      }
    }
  }

  // TACOS block — total ad spend (SP + SB + SD) over TOTAL revenue, the number
  // May computes for bid/budget planning. Starts where SB/SD tracking starts:
  // earlier months can't prove their spend is complete (SB/SD past retention),
  // and an understated TACOS is exactly the failure this section replaces.
  blank();
  section('ALL AD TYPES + TACOS — SP + SB + SD combined, monthly (TACOS = total ad spend ÷ total sales revenue, per marketplace)');
  headerRows.push(push([...HEADER, 'TACOS CA', 'TACOS US']));
  const tacosStart = values.length;
  for (let m = lm; m >= SBSD_START; m = prevMonthOf(m)) {
    const sp = sumRange(byDate, monthStart(m), monthEnd(m));
    const t = { ...sp };
    for (const k of kinds) {
      const e = sbSd[m]?.[k];
      if (!e) continue;
      for (const key of ['spendCad', 'spendUsd', 'salesCad', 'salesUsd', 'clicks', 'impressions', 'orders']) t[key] += e[key];
    }
    const row = metricRow(`${fmtMonth(m)}${m === SBSD_START && kinds.length ? ' (partial — SB/SD from mid-June)' : ''}`, t);
    row.push(t.revCad > 0 ? t.spendCad / t.revCad : '');
    row.push(t.revUsd > 0 ? t.spendUsd / t.revUsd : '');
    push(row);
  }

  return {
    values, boldRows, headerRows, deltaRows,
    bands: [
      ...ADS_BANDS,
      { c0: 12, c1: 14, r0: tacosStart, r1: values.length, pattern: '0.0%', type: 'PERCENT' },
    ],
    colWidths: ADS_WIDTHS,
  };
}

// ── Inventory tab ─────────────────────────────────────────────────────────────

// Current per-ASIN stock lives in the preset_metrics blob (FBA Inventory API,
// CA+US summed per ASIN during sync). last30d gives velocity; last7d gives the
// recent-ad-spend signal for the "spending on low stock" flag.
async function loadPresetBrands(supabase) {
  const { data, error } = await supabase.from('preset_metrics').select('data').eq('id', 'main').single();
  if (error || !data?.data) throw new Error(`preset_metrics fetch: ${error?.message || 'empty'}`);
  return {
    last30d:  data.data.presets?.last30d?.brands || {},
    last7d:   data.data.presets?.last7d?.brands  || {},
    lastSync: data.data.lastSync || null,
  };
}

// Weekly on-hand history from daily_metrics: for each ASIN and each week, the
// last non-null inventory_on_hand snapshot in that week.
async function fetchInventoryHistory(supabase, brandId, fromDate) {
  const latest = {}; // `${asin}|${weekEnd}` -> { date, onHand }
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('date,asin,inventory_on_hand')
      .eq('brand_id', brandId)
      .gte('date', fromDate)
      .not('inventory_on_hand', 'is', null)
      .order('date', { ascending: true })
      .order('asin', { ascending: true }) // unique (date,asin) order → stable pages under concurrent writes
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`inventory history (${brandId}): ${error.message}`);
    for (const r of (data || [])) {
      const dow = dayOfWeek(r.date);
      const weekEnd = dow === 0 ? r.date : addDays(r.date, 7 - dow);
      const key = `${r.asin}|${weekEnd}`;
      if (!latest[key] || r.date > latest[key].date) latest[key] = { date: r.date, onHand: r.inventory_on_hand };
    }
    if (!data || data.length < PAGE) break;
  }
  return latest;
}

const INV_HEADER = ['ASIN', 'Product', 'On hand', 'Reserved', 'Inbound', 'Unfulfillable', 'Units/day (30d)', 'Days of cover', 'Ad spend 7d ($)', 'Flag'];
const INV_BANDS = [
  { c0: 2, c1: 6, pattern: '#,##0', type: 'NUMBER' },       // On hand, Reserved, Inbound, Unfulfillable
  { c0: 6, c1: 7, pattern: '0.0',   type: 'NUMBER' },       // Units/day
  { c0: 7, c1: 8, pattern: '#,##0', type: 'NUMBER' },       // Days of cover
  { c0: 8, c1: 9, pattern: '$#,##0.00', type: 'CURRENCY' }, // Ad spend 7d
];
const INV_WIDTHS = [{ c0: 0, c1: 1, px: 110 }, { c0: 1, c1: 2, px: 340 }, { c0: 2, c1: 10, px: 100 }];

// Latest reserved/unfulfillable snapshot per ASIN from daily_metrics — the
// preset blob's rebuild paths historically slimmed inventory to onHand/inbound,
// so these two fall back to the daily snapshot when the blob lacks them.
async function fetchInvExtras(supabase, brandId, fromDate) {
  const byAsin = {};
  const { data, error } = await supabase
    .from('daily_metrics')
    .select('date,asin,inventory_reserved,inventory_unfulfillable')
    .eq('brand_id', brandId)
    .gte('date', fromDate)
    .not('inventory_reserved', 'is', null)
    .order('date', { ascending: true })
    .order('asin', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`inventory extras (${brandId}): ${error.message}`);
  for (const r of (data || [])) {
    if (!byAsin[r.asin] || r.date > byAsin[r.asin].date) byAsin[r.asin] = r;
  }
  return byAsin;
}
const RED   = { red: 0.96, green: 0.80, blue: 0.80 };
const AMBER = { red: 0.99, green: 0.90, blue: 0.80 };

function buildInventoryValues({ skus30, spend7ByAsin, history, invExtras, dataThrough, todayStr, lastSync }) {
  // Collapse sku rows to one row per ASIN (inventory in the blob is already a
  // per-ASIN total, so take it as-is; units and spend sum across rows).
  const byAsin = {};
  for (const s of (skus30 || [])) {
    if (!s.asin) continue;
    const e = byAsin[s.asin] || (byAsin[s.asin] = { asin: s.asin, title: s.title || s.amazonTitle || s.asin, units30: 0, inv: null });
    e.units30 += Number(s.units || 0);
    if (!e.inv && s.inventory) e.inv = s.inventory;
    if ((e.title === e.asin) && (s.title || s.amazonTitle)) e.title = s.title || s.amazonTitle;
  }

  const rows = Object.values(byAsin).map(e => {
    const extra    = invExtras[e.asin] || {};
    const onHand   = e.inv?.onHand ?? null;
    const reserved = e.inv?.reserved      ?? extra.inventory_reserved      ?? null;
    const unfulf   = e.inv?.unfulfillable ?? extra.inventory_unfulfillable ?? null;
    const vel     = e.units30 / 30;
    const cover   = onHand != null && vel > 0 ? Math.round(onHand / vel) : null;
    const spend7  = Math.round((spend7ByAsin[e.asin] || 0) * 100) / 100;
    let flag = '';
    if (onHand === 0 && vel > 0)            flag = spend7 > 0 ? 'OOS + AD SPEND' : 'OOS';
    else if (cover != null && cover < 14)   flag = spend7 > 0 ? 'LOW (<14d) + AD SPEND' : 'LOW (<14d)';
    else if (cover != null && cover < 30)   flag = 'WATCH (<30d)';
    return { ...e, onHand, reserved, unfulf, vel, cover, spend7, flag };
  });

  const FLAG_RANK = { 'OOS + AD SPEND': 0, 'OOS': 1, 'LOW (<14d) + AD SPEND': 2, 'LOW (<14d)': 3, 'WATCH (<30d)': 4, '': 9 };
  rows.sort((a, b) => (FLAG_RANK[a.flag] - FLAG_RANK[b.flag])
    || ((a.cover ?? 1e9) - (b.cover ?? 1e9))
    || (b.units30 - a.units30));

  const values = [];
  const boldRows = [], headerRows = [], highlights = [];
  const push = row => { values.push(row); return values.length - 1; };

  boldRows.push(push(['FBA INVENTORY (CA + US) — AUTO-GENERATED. Do not edit: this tab is rebuilt every Monday by the RMC dashboard. Manual notes belong on your own tabs.']));
  push([`Updated ${todayStr} · inventory as of last sync (${lastSync ? String(lastSync).slice(0, 16).replace('T', ' ') : 'unknown'} UTC) · Reserved = FC transfer + FC processing + pending customer orders · velocity = units sold last 30d ÷ 30 · cover = on hand ÷ velocity · flags: OOS, LOW <14d cover, WATCH <30d · "+ AD SPEND" = ad spend in the last 7 days on that ASIN`]);
  push([]);
  headerRows.push(push(INV_HEADER));

  for (const r of rows) {
    const rowIdx = push([
      r.asin, r.title,
      r.onHand ?? '', r.reserved ?? '', r.inv?.inbound ?? '', r.unfulf ?? '',
      r.vel > 0 ? Math.round(r.vel * 10) / 10 : 0,
      r.cover ?? '', r.spend7 || 0, r.flag,
    ]);
    if (r.flag.startsWith('OOS') || r.flag.includes('+ AD SPEND')) highlights.push({ row: rowIdx, color: RED });
    else if (r.flag.startsWith('LOW'))                             highlights.push({ row: rowIdx, color: AMBER });
  }

  const mainEnd = values.length; // main table bands stop here — history reuses the same columns

  // Weekly on-hand history — one column per week (ending Sunday), newest first
  push([]);
  const wkEnd = dayOfWeek(dataThrough) === 0 ? dataThrough : addDays(dataThrough, -dayOfWeek(dataThrough));
  const weeks = [];
  for (let i = 0; i < INV_HISTORY_WEEKS; i++) weeks.push(addDays(wkEnd, -7 * i));
  boldRows.push(push(['WEEKLY ON-HAND HISTORY (units at end of week, newest first — from the dashboard database)']));
  headerRows.push(push(['ASIN', 'Product', ...weeks.map(fmtDate)]));
  const histStart = values.length;
  for (const r of rows) {
    push([r.asin, r.title, ...weeks.map(w => history[`${r.asin}|${w}`]?.onHand ?? '')]);
  }

  return {
    values, boldRows, headerRows, highlights,
    bands: [
      ...INV_BANDS.map(b => ({ ...b, r0: 3, r1: mainEnd })),
      { c0: 2, c1: 2 + INV_HISTORY_WEEKS, r0: histStart, r1: values.length, pattern: '#,##0', type: 'NUMBER' },
    ],
    colWidths: INV_WIDTHS,
  };
}

// ── Sheet writing ─────────────────────────────────────────────────────────────

async function ensureTab(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const existing = meta.data.sheets.find(s => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: {
      title: tabName,
      tabColor: { red: 0.17, green: 0.23, blue: 0.13 }, // RMC green — marks machine-owned tabs
      gridProperties: { rowCount: 400, columnCount: 20 },
    } } }] },
  });
  return res.data.replies[0].addSheet.properties.sheetId;
}

function formatRequests(sheetId, built) {
  const numRows = built.values.length;
  const reqs = [
    // Wipe all formatting first so layout shifts between runs never leave stale styling
    { repeatCell: { range: { sheetId }, cell: { userEnteredFormat: {} }, fields: 'userEnteredFormat' } },
  ];
  for (const b of (built.bands || [])) {
    reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: b.r0 ?? 2, endRowIndex: b.r1 ?? numRows, startColumnIndex: b.c0, endColumnIndex: b.c1 },
      cell: { userEnteredFormat: { numberFormat: { type: b.type, pattern: b.pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    } });
  }
  for (const w of (built.colWidths || [])) {
    reqs.push({ updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: w.c0, endIndex: w.c1 },
      properties: { pixelSize: w.px }, fields: 'pixelSize',
    } });
  }
  for (const r of [...(built.boldRows || []), ...(built.headerRows || [])]) {
    reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r, endRowIndex: r + 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    } });
  }
  for (const r of (built.deltaRows || [])) {
    reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: r, endRowIndex: r + 1, startColumnIndex: 1, endColumnIndex: 12 },
      cell: { userEnteredFormat: { numberFormat: { type: 'PERCENT', pattern: '+0.0%;-0.0%' } } },
      fields: 'userEnteredFormat.numberFormat',
    } });
  }
  for (const h of (built.highlights || [])) {
    reqs.push({ repeatCell: {
      range: { sheetId, startRowIndex: h.row, endRowIndex: h.row + 1, startColumnIndex: 0, endColumnIndex: 10 },
      cell: { userEnteredFormat: { backgroundColor: h.color } },
      fields: 'userEnteredFormat.backgroundColor',
    } });
  }
  return reqs;
}

async function writeTab(sheets, spreadsheetId, tabName, built) {
  const sheetId = await ensureTab(sheets, spreadsheetId, tabName);
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${tabName}'` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: built.values },
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: formatRequests(sheetId, built) } });

  // Read the tab back and compare cell-by-cell against what was built. A
  // mismatch means the projection layer corrupted data in flight — fail the
  // brand loudly (it lands in results.failed → Slack) instead of leaving a
  // wrong sheet for the team to trust.
  const check = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${tabName}'`, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  verifyReadBack(built.values, check.data.values || [], tabName);
}

function verifyReadBack(expected, actual, tabName) {
  for (let i = 0; i < expected.length; i++) {
    const e = expected[i] || [], a = actual[i] || [];
    for (let j = 0; j < e.length; j++) {
      const ev = e[j], av = a[j]; // values.get trims trailing empties → undefined ≈ ''
      const empty = v => v === '' || v == null;
      if (empty(ev)) {
        if (!empty(av)) throw new Error(`${tabName} read-back mismatch R${i + 1}C${j + 1}: wrote empty, sheet has ${JSON.stringify(av)}`);
      } else if (typeof ev === 'number') {
        if (typeof av !== 'number' || Math.abs(ev - av) > 1e-6) throw new Error(`${tabName} read-back mismatch R${i + 1}C${j + 1}: wrote ${ev}, sheet has ${JSON.stringify(av)}`);
      } else if (String(av) !== String(ev)) {
        throw new Error(`${tabName} read-back mismatch R${i + 1}C${j + 1}: wrote ${JSON.stringify(ev)}, sheet has ${JSON.stringify(av)}`);
      }
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

async function syncMasterSheets(supabase) {
  const { pstDateStr, pstSubtractDays } = require('./dateUtils');
  const sheets = await getSheetsClient();
  if (!sheets) {
    console.warn('[MasterSheets] No Google service-account credentials — skipping (set GOOGLE_SERVICE_ACCOUNT_B64 or mount google-service-account.json)');
    return { skipped: 'no credentials' };
  }
  const todayStr    = pstDateStr();
  const dataThrough = pstSubtractDays(todayStr, 1);
  const invFrom     = pstSubtractDays(todayStr, INV_HISTORY_WEEKS * 7 + 6);
  const presets     = await loadPresetBrands(supabase);

  const results = { ok: [], failed: [] };
  for (const [brandId, spreadsheetId] of Object.entries(BRAND_SHEETS)) {
    try {
      const byDate = await fetchBrandDaily(supabase, brandId);
      const sbSd   = await fetchBrandSbSd(supabase, brandId);
      const ads = buildTabValues(byDate, dataThrough, todayStr, sbSd);
      await writeTab(sheets, spreadsheetId, TAB_ADS, ads);

      const spend7ByAsin = {};
      for (const s of (presets.last7d[brandId]?.skus || [])) {
        if (s.asin) spend7ByAsin[s.asin] = (spend7ByAsin[s.asin] || 0) + Number(s.spendCad || 0) + Number(s.spendUsd || 0);
      }
      const inv = buildInventoryValues({
        skus30: presets.last30d[brandId]?.skus || [],
        spend7ByAsin,
        history: await fetchInventoryHistory(supabase, brandId, invFrom),
        invExtras: await fetchInvExtras(supabase, brandId, pstSubtractDays(todayStr, 7)),
        dataThrough, todayStr, lastSync: presets.lastSync,
      });
      await writeTab(sheets, spreadsheetId, TAB_INV, inv);

      console.log(`[MasterSheets] ${brandId}: ads ${ads.values.length} rows, inventory ${inv.values.length} rows (data through ${dataThrough})`);
      results.ok.push(brandId);
    } catch (e) {
      console.warn(`[MasterSheets] ${brandId} FAILED: ${e.message}`);
      results.failed.push({ brandId, error: e.message });
    }
  }
  console.log(`[MasterSheets] Done: ${results.ok.length} ok, ${results.failed.length} failed`);
  if (results.failed.length) {
    try {
      const { postSlackAlert } = require('../slack/alert');
      await postSlackAlert(
        `:warning: *Master-sheet write failed for ${results.failed.length} brand(s)* — those tabs still show LAST week's data.`,
        results.failed.map(f => `${f.brandId}: ${f.error}`).join('\n')
      );
    } catch (e) { console.warn('[MasterSheets] Slack alert failed:', e.message); }
  }
  return results;
}

module.exports = { syncMasterSheets, BRAND_SHEETS, TAB_ADS, TAB_INV };
