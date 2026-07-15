/**
 * Amazon Advertising API — Sponsored Products sync
 * Pulls ASIN-level: spend, attributed sales, ACOS, clicks, impressions
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const zlib  = require('zlib');

const ADS_HOST     = 'advertising-api.amazon.com';
const TOKEN_URL    = 'https://api.amazon.com/auth/o2/token';

const PROFILES = {
  CA: process.env.ADS_PROFILE_CA,
  US: process.env.ADS_PROFILE_US,
};

// ── Auth ──────────────────────────────────────────────────────────────────────

let _tokenCache = null;

async function getAdsToken() {
  if (_tokenCache && _tokenCache.expires > Date.now()) return _tokenCache.token;
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: process.env.ADS_REFRESH_TOKEN,
      client_id:     process.env.ADS_CLIENT_ID,
      client_secret: process.env.ADS_CLIENT_SECRET,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Ads token error: ' + JSON.stringify(d));
  _tokenCache = { token: d.access_token, expires: Date.now() + (d.expires_in - 60) * 1000 };
  return _tokenCache.token;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function adsReq(method, path, profileId, token, body = null, extraHeaders = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': process.env.ADS_CLIENT_ID,
    'Amazon-Advertising-API-Scope':    String(profileId),
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const res = await fetch(`https://${ADS_HOST}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch { return { status: res.status, body: text }; }
}

// ── Reports ───────────────────────────────────────────────────────────────────

async function createAdReport(profileId, token, startDate, endDate) {
  const res = await adsReq('POST', '/reporting/reports', profileId, token, {
    name:      `SP-ASIN-${startDate}-${endDate}-${Date.now()}`,
    startDate,
    endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['advertiser'],
      columns:      ['advertisedAsin', 'cost', 'sales14d', 'clicks', 'impressions', 'purchases14d'],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit:     'SUMMARY',
      format:       'GZIP_JSON',
    },
  }, { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' });

  if (res.status === 200 && res.body.reportId) return res.body.reportId;

  // 425 = duplicate request — Amazon returns the existing report ID in the detail message
  if (res.status === 425) {
    const match = String(res.body?.detail || '').match(/([0-9a-f-]{36})/i);
    if (match) { console.log(`[Ads] Reusing existing report ${match[1]}`); return match[1]; }
  }

  throw new Error(`Ads report create failed (${res.status}): ${JSON.stringify(res.body)}`);
}

// 20 minutes is fine for the recent windows the crons pull, but historical
// reports bake far slower — an April backfill took Amazon 28 MINUTES for CA
// while US sat PENDING for 50+ with no processing at all. The old ceiling gave
// up 8 minutes before ready data and reported a timeout, making a slow report
// look like a broken one. Override via ADS_REPORT_WAIT_MIN for backfills.
const ADS_REPORT_WAIT_MS = (parseInt(process.env.ADS_REPORT_WAIT_MIN || '20', 10)) * 60 * 1000;

async function waitForAdReport(reportId, profileId, token, maxWaitMs = ADS_REPORT_WAIT_MS) {
  const deadline = Date.now() + maxWaitMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    // Check immediately on first pass (no sleep), then every 30s
    if (attempt > 0) await sleep(30000);
    attempt++;
    const res = await adsReq('GET', `/reporting/reports/${reportId}`, profileId, token);
    const status = res.body?.status;
    if (attempt === 1 || attempt % 3 === 0) {
      console.log(`[Ads] Report ${reportId.slice(0,8)}… check ${attempt}: ${status}`);
    }
    if (status === 'COMPLETED') return res.body.url;
    if (status === 'FAILED')    throw new Error(`Ads report ${reportId} failed: ${JSON.stringify(res.body)}`);
  }
  throw new Error(`Ads report ${reportId} timed out after ${maxWaitMs / 60000}min`);
}

async function downloadAdReport(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        zlib.gunzip(buf, (err, out) => {
          if (err) return reject(err);
          try { resolve(JSON.parse(out.toString())); }
          catch (e) { reject(e); }
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── Parse ─────────────────────────────────────────────────────────────────────

function parseAdReport(rows) {
  // rows: [{ advertisedAsin, cost, sales14d, clicks, impressions, purchases14d }]
  const result = {};
  for (const row of (rows || [])) {
    const asin = row.advertisedAsin;
    if (!asin) continue;
    if (!result[asin]) result[asin] = { spend: 0, attributedSales: 0, clicks: 0, impressions: 0, orders: 0 };
    result[asin].spend          += Number(row.cost             || 0);
    result[asin].attributedSales += Number(row.sales14d || 0);
    result[asin].clicks         += Number(row.clicks           || 0);
    result[asin].impressions    += Number(row.impressions      || 0);
    result[asin].orders         += Number(row.purchases14d     || 0);
  }
  // Compute derived metrics per ASIN
  for (const d of Object.values(result)) {
    d.spend           = Math.round(d.spend * 100) / 100;
    d.attributedSales = Math.round(d.attributedSales * 100) / 100;
    // ACOS: ad spend / attributed sales
    d.acos   = d.attributedSales > 0 ? Math.round(d.spend / d.attributedSales * 10000) / 100 : null;
    // ROAS: attributed sales / ad spend (return per dollar spent)
    d.roas   = d.spend > 0 ? Math.round(d.attributedSales / d.spend * 100) / 100 : null;
    // CPC: cost per click
    d.cpc    = d.clicks > 0 ? Math.round(d.spend / d.clicks * 10000) / 10000 : null;
    // CTR: click-through rate (%)
    d.ctr    = d.impressions > 0 ? Math.round(d.clicks / d.impressions * 100000) / 1000 : null;
    // Ad CVR: orders per click (%)
    d.adCvr  = d.clicks > 0 ? Math.round(d.orders / d.clicks * 10000) / 100 : null;
  }
  return result;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Phase 1: kick off report creation for a date range. Returns handles to poll later.
 * Call this BEFORE your slow SP-API sync so reports bake in the background.
 */
async function startAdReports(startDate, endDate) {
  const token = await getAdsToken();
  console.log(`[Ads] Creating reports ${startDate} → ${endDate} (CA + US)...`);
  const [caReportId, usReportId] = await Promise.all([
    createAdReport(PROFILES.CA, token, startDate, endDate),
    createAdReport(PROFILES.US, token, startDate, endDate),
  ]);
  return { caReportId, usReportId, token };
}

/**
 * Phase 2: wait for + download reports created by startAdReports(). Returns merged ASIN map.
 */
async function finishAdReports({ caReportId, usReportId, token }, startDate, endDate) {
  console.log(`[Ads] Collecting reports ${startDate} → ${endDate}...`);
  const [caUrl, usUrl] = await Promise.all([
    waitForAdReport(caReportId, PROFILES.CA, token),
    waitForAdReport(usReportId, PROFILES.US, token),
  ]);
  const [caRows, usRows] = await Promise.all([
    downloadAdReport(caUrl),
    downloadAdReport(usUrl),
  ]);
  return mergeAdData(parseAdReport(caRows), parseAdReport(usRows));
}

/**
 * Convenience: create + wait + download in one call (used for one-off queries).
 */
async function syncAdMetrics(startDate, endDate) {
  const handles = await startAdReports(startDate, endDate);
  return finishAdReports(handles, startDate, endDate);
}

// ── Daily-granularity puller ─────────────────────────────────────────────────
// timeUnit:'DAILY' + 'date' column → one row per (asin, date, marketplace).
// Used by the dedicated daily ad-spend cron that writes to daily_metrics.
async function createDailyAdReport(profileId, token, startDate, endDate) {
  const res = await adsReq('POST', '/reporting/reports', profileId, token, {
    name:      `SP-ASIN-DAILY-${startDate}-${endDate}-${Date.now()}`,
    startDate,
    endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['advertiser'],
      columns:      ['date', 'advertisedAsin', 'cost', 'sales14d', 'clicks', 'impressions', 'purchases14d'],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit:     'DAILY',
      format:       'GZIP_JSON',
    },
  }, { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' });

  if (res.status === 200 && res.body.reportId) return res.body.reportId;
  if (res.status === 425) {
    const match = String(res.body?.detail || '').match(/([0-9a-f-]{36})/i);
    if (match) { console.log(`[Ads] Reusing existing daily report ${match[1]}`); return match[1]; }
  }
  throw new Error(`Ads daily report create failed (${res.status}): ${JSON.stringify(res.body)}`);
}

// Returns { [date]: { [asin]: { spend, sales, clicks, impressions, orders } } }
function parseDailyAdReport(rows) {
  const byDate = {};
  for (const row of (rows || [])) {
    const date = row.date;
    const asin = row.advertisedAsin;
    if (!date || !asin) continue;
    if (!byDate[date])           byDate[date]           = {};
    if (!byDate[date][asin])     byDate[date][asin]     = { spend: 0, sales: 0, clicks: 0, impressions: 0, orders: 0 };
    const e = byDate[date][asin];
    e.spend       += Number(row.cost         || 0);
    e.sales       += Number(row.sales14d     || 0);
    e.clicks      += Number(row.clicks       || 0);
    e.impressions += Number(row.impressions  || 0);
    e.orders      += Number(row.purchases14d || 0);
  }
  return byDate;
}

// Pull both marketplaces, return { [date]: { [asin]: { spendCad, spendUsd, salesCad, salesUsd, ... } } }
async function pullAdSpendDaily(startDate, endDate) {
  const token = await getAdsToken();
  console.log(`[Ads] Daily reports ${startDate} → ${endDate} (CA + US)...`);
  const [caId, usId] = await Promise.all([
    createDailyAdReport(PROFILES.CA, token, startDate, endDate),
    createDailyAdReport(PROFILES.US, token, startDate, endDate),
  ]);
  const [caUrl, usUrl] = await Promise.all([
    waitForAdReport(caId, PROFILES.CA, token),
    waitForAdReport(usId, PROFILES.US, token),
  ]);
  const [caRows, usRows] = await Promise.all([
    downloadAdReport(caUrl),
    downloadAdReport(usUrl),
  ]);
  const caDaily = parseDailyAdReport(caRows);
  const usDaily = parseDailyAdReport(usRows);

  // Merge into { [date]: { [asin]: { spendCad, spendUsd, salesCad, salesUsd, ... } } }
  const merged = {};
  const newEntry = () => ({
    spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0,
    clicks: 0, impressions: 0, orders: 0,
  });
  for (const [date, asins] of Object.entries(caDaily)) {
    if (!merged[date]) merged[date] = {};
    for (const [asin, d] of Object.entries(asins)) {
      if (!merged[date][asin]) merged[date][asin] = newEntry();
      merged[date][asin].spendCad    += d.spend;
      merged[date][asin].salesCad    += d.sales;
      merged[date][asin].clicks      += d.clicks;
      merged[date][asin].impressions += d.impressions;
      merged[date][asin].orders      += d.orders;
    }
  }
  for (const [date, asins] of Object.entries(usDaily)) {
    if (!merged[date]) merged[date] = {};
    for (const [asin, d] of Object.entries(asins)) {
      if (!merged[date][asin]) merged[date][asin] = newEntry();
      merged[date][asin].spendUsd    += d.spend;
      merged[date][asin].salesUsd    += d.sales;
      merged[date][asin].clicks      += d.clicks;
      merged[date][asin].impressions += d.impressions;
      merged[date][asin].orders      += d.orders;
    }
  }
  let totDates = Object.keys(merged).length;
  let totAsins = 0;
  for (const d of Object.values(merged)) totAsins += Object.keys(d).length;
  console.log(`[Ads] Daily merged: ${totDates} dates, ${totAsins} (date,asin) rows`);
  return merged;
}

function mergeAdData(caData, usData) {

  // Merge into unified ASIN map, keeping CA/US spend separate
  const result = {};
  const allAsins = new Set([...Object.keys(caData), ...Object.keys(usData)]);
  for (const asin of allAsins) {
    const ca = caData[asin] || {};
    const us = usData[asin] || {};
    const spendCad   = ca.spend           || 0;
    const spendUsd   = us.spend           || 0;
    const salesCad   = ca.attributedSales || 0;
    const salesUsd   = us.attributedSales || 0;
    const clicks      = (ca.clicks      || 0) + (us.clicks      || 0);
    const impressions = (ca.impressions || 0) + (us.impressions || 0);
    const orders      = (ca.orders      || 0) + (us.orders      || 0);
    const totalSales  = salesCad + salesUsd;
    const totalSpend  = spendCad + spendUsd;
    result[asin] = {
      spendCad,
      spendUsd,
      attributedSalesCad: salesCad,
      attributedSalesUsd: salesUsd,
      clicks,
      impressions,
      orders,
      // Combined metrics across CA + US
      acos:   totalSales > 0 ? Math.round(totalSpend / totalSales * 10000) / 100 : null,
      roas:   totalSpend > 0 ? Math.round(totalSales / totalSpend * 100) / 100 : null,
      cpc:    clicks > 0     ? Math.round(totalSpend / clicks * 10000) / 10000 : null,
      ctr:    impressions > 0 ? Math.round(clicks / impressions * 100000) / 1000 : null,
      adCvr:  clicks > 0     ? Math.round(orders / clicks * 10000) / 100 : null,
    };
  }

  console.log(`[Ads] Got ad data for ${Object.keys(result).length} ASINs`);
  return result;
}

module.exports = { syncAdMetrics, startAdReports, finishAdReports, pullAdSpendDaily };
