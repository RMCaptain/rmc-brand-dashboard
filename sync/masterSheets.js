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
async function fetchBrandDaily(supabase, brandId) {
  const byDate = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('date,spend_cad,spend_usd,attributed_sales_cad,attributed_sales_usd,ad_clicks,ad_impressions,ad_orders')
      .eq('brand_id', brandId)
      .gte('date', ADS_HISTORY_START)
      .order('date', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`daily_metrics fetch (${brandId}): ${error.message}`);
    for (const r of (data || [])) {
      const e = byDate[r.date] || (byDate[r.date] = { spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0 });
      e.spendCad    += Number(r.spend_cad            || 0);
      e.spendUsd    += Number(r.spend_usd            || 0);
      e.salesCad    += Number(r.attributed_sales_cad || 0);
      e.salesUsd    += Number(r.attributed_sales_usd || 0);
      e.clicks      += Number(r.ad_clicks            || 0);
      e.impressions += Number(r.ad_impressions       || 0);
      e.orders      += Number(r.ad_orders            || 0);
    }
    if (!data || data.length < PAGE) break;
  }
  return byDate;
}

function sumRange(byDate, from, to) {
  const t = { spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0, days: 0 };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const e = byDate[d];
    if (!e) continue;
    t.days++;
    for (const k of ['spendCad','spendUsd','salesCad','salesUsd','clicks','impressions','orders']) t[k] += e[k];
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

function buildTabValues(byDate, dataThrough, todayStr) {
  const values = [];
  const boldRows = [], headerRows = [], deltaRows = [];
  const push = row => { values.push(row); return values.length - 1; };
  const section = title => boldRows.push(push([title]));
  const header  = () => headerRows.push(push(HEADER));
  const blank   = () => push([]);

  boldRows.push(push(['SPONSORED PRODUCTS (CA + US) — AUTO-GENERATED. Do not edit: this tab is rebuilt every Monday by the RMC dashboard. Manual notes belong on your own tabs.']));
  push([`Updated ${todayStr} · data through ${dataThrough} · ads history starts ${ADS_HISTORY_START} · source: RMC dashboard daily_metrics (permanent record; last 30 days re-pulled daily so attribution self-corrects)`]);
  blank();

  // Month to date, paced against the same days of the prior month
  const ym = monthOf(dataThrough);
  const mtd = sumRange(byDate, monthStart(ym), dataThrough);
  const pm  = prevMonthOf(ym);
  const pmSameDay = `${pm}-${dataThrough.slice(8)}`; // same day-of-month, clamped to month length
  const pmPaceEnd = pmSameDay > monthEnd(pm) ? monthEnd(pm) : pmSameDay;
  const pmPace = sumRange(byDate, monthStart(pm), pmPaceEnd);
  section(`MONTH TO DATE — ${fmtDate(monthStart(ym))}–${fmtDate(dataThrough)}`);
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
  section('WEEK OVER WEEK — last complete week (Mon–Sun)');
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
  section('MONTH OVER MONTH — last complete month');
  header();
  push(metricRow(fmtMonth(lm), lmT));
  push(metricRow(fmtMonth(lm2), lm2T));
  deltaRows.push(push(deltaRow('Δ month over month', lmT, lm2T)));
  blank();

  // Weekly history — every complete Mon–Sun week, newest first
  section('WEEKLY HISTORY (Mon–Sun, newest first — rebuilt from the database each run)');
  header();
  for (let end = wkEnd; end >= ADS_HISTORY_START; end = addDays(end, -7)) {
    const start = addDays(end, -6);
    const partial = start < ADS_HISTORY_START;
    const t = sumRange(byDate, partial ? ADS_HISTORY_START : start, end);
    push(metricRow(`${fmtDate(start)}–${fmtDate(end)}${partial ? ' (partial — history starts Apr 11)' : ''}`, t));
  }
  blank();

  // Monthly history — complete months, newest first
  section('MONTHLY HISTORY (newest first)');
  header();
  for (let m = lm; m >= monthOf(ADS_HISTORY_START); m = prevMonthOf(m)) {
    const partial = m === monthOf(ADS_HISTORY_START);
    const t = sumRange(byDate, partial ? ADS_HISTORY_START : monthStart(m), monthEnd(m));
    push(metricRow(`${fmtMonth(m)}${partial ? ' (partial — history starts Apr 11)' : ''}`, t));
  }

  return { values, boldRows, headerRows, deltaRows, bands: ADS_BANDS, colWidths: ADS_WIDTHS };
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

const INV_HEADER = ['ASIN', 'Product', 'On hand', 'Inbound', 'Unfulfillable', 'Units/day (30d)', 'Days of cover', 'Ad spend 7d ($)', 'Flag'];
const INV_BANDS = [
  { c0: 2, c1: 5, pattern: '#,##0', type: 'NUMBER' },       // On hand, Inbound, Unfulfillable
  { c0: 5, c1: 6, pattern: '0.0',   type: 'NUMBER' },       // Units/day
  { c0: 6, c1: 7, pattern: '#,##0', type: 'NUMBER' },       // Days of cover
  { c0: 7, c1: 8, pattern: '$#,##0.00', type: 'CURRENCY' }, // Ad spend 7d
];
const INV_WIDTHS = [{ c0: 0, c1: 1, px: 110 }, { c0: 1, c1: 2, px: 340 }, { c0: 2, c1: 9, px: 100 }];
const RED   = { red: 0.96, green: 0.80, blue: 0.80 };
const AMBER = { red: 0.99, green: 0.90, blue: 0.80 };

function buildInventoryValues({ skus30, spend7ByAsin, history, dataThrough, todayStr, lastSync }) {
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
    const onHand  = e.inv?.onHand ?? null;
    const vel     = e.units30 / 30;
    const cover   = onHand != null && vel > 0 ? Math.round(onHand / vel) : null;
    const spend7  = Math.round((spend7ByAsin[e.asin] || 0) * 100) / 100;
    let flag = '';
    if (onHand === 0 && vel > 0)            flag = spend7 > 0 ? 'OOS + AD SPEND' : 'OOS';
    else if (cover != null && cover < 14)   flag = spend7 > 0 ? 'LOW (<14d) + AD SPEND' : 'LOW (<14d)';
    else if (cover != null && cover < 30)   flag = 'WATCH (<30d)';
    return { ...e, onHand, vel, cover, spend7, flag };
  });

  const FLAG_RANK = { 'OOS + AD SPEND': 0, 'OOS': 1, 'LOW (<14d) + AD SPEND': 2, 'LOW (<14d)': 3, 'WATCH (<30d)': 4, '': 9 };
  rows.sort((a, b) => (FLAG_RANK[a.flag] - FLAG_RANK[b.flag])
    || ((a.cover ?? 1e9) - (b.cover ?? 1e9))
    || (b.units30 - a.units30));

  const values = [];
  const boldRows = [], headerRows = [], highlights = [];
  const push = row => { values.push(row); return values.length - 1; };

  boldRows.push(push(['FBA INVENTORY (CA + US) — AUTO-GENERATED. Do not edit: this tab is rebuilt every Monday by the RMC dashboard. Manual notes belong on your own tabs.']));
  push([`Updated ${todayStr} · inventory as of last sync (${lastSync ? String(lastSync).slice(0, 16).replace('T', ' ') : 'unknown'} UTC) · velocity = units sold last 30d ÷ 30 · flags: OOS, LOW <14d cover, WATCH <30d · "+ AD SPEND" = ad spend in the last 7 days on that ASIN`]);
  push([]);
  headerRows.push(push(INV_HEADER));

  for (const r of rows) {
    const rowIdx = push([
      r.asin, r.title,
      r.onHand ?? '', r.inv?.inbound ?? '', r.inv?.unfulfillable ?? '',
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
      range: { sheetId, startRowIndex: h.row, endRowIndex: h.row + 1, startColumnIndex: 0, endColumnIndex: 9 },
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
      const ads = buildTabValues(byDate, dataThrough, todayStr);
      await writeTab(sheets, spreadsheetId, TAB_ADS, ads);

      const spend7ByAsin = {};
      for (const s of (presets.last7d[brandId]?.skus || [])) {
        if (s.asin) spend7ByAsin[s.asin] = (spend7ByAsin[s.asin] || 0) + Number(s.spendCad || 0) + Number(s.spendUsd || 0);
      }
      const inv = buildInventoryValues({
        skus30: presets.last30d[brandId]?.skus || [],
        spend7ByAsin,
        history: await fetchInventoryHistory(supabase, brandId, invFrom),
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
  return results;
}

module.exports = { syncMasterSheets, BRAND_SHEETS, TAB_ADS, TAB_INV };
