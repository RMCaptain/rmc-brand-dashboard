/**
 * Amazon Advertising API — Sponsored Products sync
 * Pulls ASIN-level: spend, attributed sales, ACOS, clicks, impressions
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const zlib  = require('zlib');

const MP = require('./marketplaces');
const TOKEN_URL    = 'https://api.amazon.com/auth/o2/token';

// Ads profile ids by marketplace code, driven by the registry's adsProfileEnv.
// Codes without a configured profile simply aren't present (UK appears the
// moment ADS_PROFILE_UK lands in env; Walmart has adsProfileEnv null).
const PROFILES = Object.fromEntries(
  MP.all().filter(m => m.adsProfileEnv && process.env[m.adsProfileEnv])
    .map(m => [m.code, process.env[m.adsProfileEnv]]));

// Region for a profile's marketplace (host + credential selection).
function adsRegionFor(code) { const m = MP.byCode(code); return (m && m.region) || 'na'; }
function adsHostFor(region = 'na') { return MP.ADS_HOSTS[region] || MP.ADS_HOSTS.na; }

// ── Auth ──────────────────────────────────────────────────────────────────────
// Per-region token cache. The UK ads login is a separate grant
// (ADS_REFRESH_TOKEN_EU); client id/secret fall back to the NA app's unless
// _EU variants are set (separate login usually means separate creds too).
const _tokenCaches = {}; // region -> { token, expires }

function adsClientId(region = 'na') {
  return (region !== 'na' && process.env['ADS_CLIENT_ID_' + region.toUpperCase()]) || process.env.ADS_CLIENT_ID;
}

async function getAdsToken(region = 'na') {
  const c = _tokenCaches[region];
  if (c && c.expires > Date.now()) return c.token;
  const suffix = region === 'na' ? '' : '_' + region.toUpperCase();
  const refreshToken = process.env['ADS_REFRESH_TOKEN' + suffix];
  if (!refreshToken) throw new Error(`Ads credentials for region '${region}' are not configured (need ADS_REFRESH_TOKEN${suffix})`);
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     adsClientId(region),
      client_secret: (region !== 'na' && process.env['ADS_CLIENT_SECRET' + suffix]) || process.env.ADS_CLIENT_SECRET,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('Ads token error: ' + JSON.stringify(d));
  _tokenCaches[region] = { token: d.access_token, expires: Date.now() + (d.expires_in - 60) * 1000 };
  return _tokenCaches[region].token;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function adsReq(method, path, profileId, token, body = null, extraHeaders = {}, region = 'na') {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Amazon-Advertising-API-ClientId': adsClientId(region),
    'Amazon-Advertising-API-Scope':    String(profileId),
    'Content-Type': 'application/json',
    ...extraHeaders,
  };

  const res = await fetch(`https://${adsHostFor(region)}${path}`, {
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
//
// Both attribution windows are pulled: the Ads console shows SELLERS a 7-day
// window for Sponsored Products, so sales7d/purchases7d are what May reconciles
// against campaign manager; sales14d/purchases14d remain the dashboard's
// historical convention. One report carries both — same cost, same bake time.
async function createDailyAdReport(profileId, token, startDate, endDate) {
  const res = await adsReq('POST', '/reporting/reports', profileId, token, {
    name:      `SP-ASIN-DAILY-${startDate}-${endDate}-${Date.now()}`,
    startDate,
    endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['advertiser'],
      columns:      ['date', 'advertisedAsin', 'cost', 'sales7d', 'sales14d', 'clicks', 'impressions', 'purchases7d', 'purchases14d'],
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

// Returns { [date]: { [asin]: { spend, sales, sales7, clicks, impressions, orders, orders7 } } }
function parseDailyAdReport(rows) {
  const byDate = {};
  for (const row of (rows || [])) {
    const date = row.date;
    const asin = row.advertisedAsin;
    if (!date || !asin) continue;
    if (!byDate[date])           byDate[date]           = {};
    if (!byDate[date][asin])     byDate[date][asin]     = { spend: 0, sales: 0, sales7: 0, clicks: 0, impressions: 0, orders: 0, orders7: 0 };
    const e = byDate[date][asin];
    e.spend       += Number(row.cost         || 0);
    e.sales       += Number(row.sales14d     || 0);
    e.sales7      += Number(row.sales7d      || 0);
    e.clicks      += Number(row.clicks       || 0);
    e.impressions += Number(row.impressions  || 0);
    e.orders      += Number(row.purchases14d || 0);
    e.orders7     += Number(row.purchases7d  || 0);
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
    sales7Cad: 0, sales7Usd: 0,
    clicks: 0, impressions: 0, orders: 0, orders7: 0,
  });
  for (const [date, asins] of Object.entries(caDaily)) {
    if (!merged[date]) merged[date] = {};
    for (const [asin, d] of Object.entries(asins)) {
      if (!merged[date][asin]) merged[date][asin] = newEntry();
      merged[date][asin].spendCad    += d.spend;
      merged[date][asin].salesCad    += d.sales;
      merged[date][asin].sales7Cad   += d.sales7;
      merged[date][asin].clicks      += d.clicks;
      merged[date][asin].impressions += d.impressions;
      merged[date][asin].orders      += d.orders;
      merged[date][asin].orders7     += d.orders7;
    }
  }
  for (const [date, asins] of Object.entries(usDaily)) {
    if (!merged[date]) merged[date] = {};
    for (const [asin, d] of Object.entries(asins)) {
      if (!merged[date][asin]) merged[date][asin] = newEntry();
      merged[date][asin].spendUsd    += d.spend;
      merged[date][asin].salesUsd    += d.sales;
      merged[date][asin].sales7Usd   += d.sales7;
      merged[date][asin].clicks      += d.clicks;
      merged[date][asin].impressions += d.impressions;
      merged[date][asin].orders      += d.orders;
      merged[date][asin].orders7     += d.orders7;
    }
  }
  let totDates = Object.keys(merged).length;
  let totAsins = 0;
  for (const d of Object.values(merged)) totAsins += Object.keys(d).length;
  console.log(`[Ads] Daily merged: ${totDates} dates, ${totAsins} (date,asin) rows`);
  return merged;
}

// ── Sponsored Brands / Sponsored Display (campaign-level) ────────────────────
// SB/SD campaigns aren't advertised-ASIN scoped, so they can't join
// daily_metrics — they roll up per (date, brand, product) into daily_brand_ads.
// Brand comes from the campaign-name prefix the team uses ("ACURE - …",
// "PW - …", "BLC - …"); unmapped names land on 'unknown-brand' so account
// totals still reconcile against the console. Retention is much shorter than
// SP (~60d); a 400 naming the retention start date clamps and retries.

const CAMPAIGN_BRAND_PREFIXES = {
  'ACURE': 'acure', 'PW': 'purewine', 'PUREWINE': 'purewine',
  'BLC': 'big-league-chew', 'ZELLIES': 'zellies', 'ZEL': 'zellies',
  'TRIMAX': 'trimax', 'SUPREME': 'supreme-petfoods', 'KS': 'kidstar-nutrients',
  'KIDSTAR': 'kidstar-nutrients', 'MO': 'maison-orph-e', 'MAISON': 'maison-orph-e',
  'VIVA': 'viva', 'ZEST': 'zest',
};

function brandFromCampaignName(name) {
  const prefix = String(name || '').split(/[\s_-]+/)[0].toUpperCase();
  return CAMPAIGN_BRAND_PREFIXES[prefix] || 'unknown-brand';
}

async function createBrandAdsReport(profileId, token, adProduct, reportTypeId, startDate, endDate) {
  const make = (s) => adsReq('POST', '/reporting/reports', profileId, token, {
    name: `${reportTypeId}-DAILY-${s}-${endDate}-${Date.now()}`,
    startDate: s,
    endDate,
    configuration: {
      adProduct,
      groupBy:      ['campaign'],
      columns:      ['date', 'campaignName', 'cost', 'sales', 'clicks', 'impressions', 'purchases'],
      reportTypeId,
      timeUnit:     'DAILY',
      format:       'GZIP_JSON',
    },
  }, { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' });

  let res = await make(startDate);
  if (res.status === 400) {
    // "startDate (…) must be equal to or after report type data retention start date (YYYY-MM-DD)"
    const m = String(res.body?.detail || '').match(/retention start date \((\d{4}-\d{2}-\d{2})\)/);
    if (m) {
      if (m[1] > endDate) return null; // whole window predates retention — nothing to pull
      console.log(`[Ads] ${reportTypeId}: clamping start ${startDate} → ${m[1]} (retention)`);
      res = await make(m[1]);
      startDate = m[1];
    }
  }
  // Report creation throttles when several report types queue at once (SP daily
  // + 4 SB/SD requests back-to-back). Creation is cheap to retry — back off.
  for (let attempt = 0; res.status === 429 && attempt < 4; attempt++) {
    const wait = 60000 * (attempt + 1);
    console.log(`[Ads] ${reportTypeId}: 429 throttled, retrying in ${wait / 1000}s...`);
    await sleep(wait);
    res = await make(startDate);
  }
  if (res.status === 200 && res.body.reportId) return res.body.reportId;
  if (res.status === 425) {
    const m = String(res.body?.detail || '').match(/([0-9a-f-]{36})/i);
    if (m) { console.log(`[Ads] Reusing existing ${reportTypeId} report ${m[1]}`); return m[1]; }
  }
  throw new Error(`${reportTypeId} report create failed (${res.status}): ${JSON.stringify(res.body)}`);
}

// Returns { [date]: { [brandId]: { SB: {spend,sales,clicks,impressions,orders}, SD: {...} } } }
// per marketplace-merged: spend/sales split CA/USD by caller via marketplace loop.
async function pullBrandAdsDaily(startDate, endDate) {
  const token = await getAdsToken();
  const KINDS = [
    ['SB', 'SPONSORED_BRANDS',  'sbCampaigns'],
    ['SD', 'SPONSORED_DISPLAY', 'sdCampaigns'],
  ];
  // { [date]: { [brand]: { [kind]: entry } } }
  const merged = {};
  const entry = () => ({ spendCad: 0, spendUsd: 0, salesCad: 0, salesUsd: 0, clicks: 0, impressions: 0, orders: 0 });

  for (const [mp, profileId] of Object.entries(PROFILES)) {
    for (const [kind, adProduct, reportTypeId] of KINDS) {
      const reportId = await createBrandAdsReport(profileId, token, adProduct, reportTypeId, startDate, endDate);
      if (!reportId) continue;
      const url  = await waitForAdReport(reportId, profileId, token);
      const rows = await downloadAdReport(url);
      for (const row of (rows || [])) {
        if (!row.date) continue;
        const cost = Number(row.cost || 0), sales = Number(row.sales || 0);
        const clicks = Number(row.clicks || 0), impressions = Number(row.impressions || 0), orders = Number(row.purchases || 0);
        if (!cost && !sales && !clicks && !impressions && !orders) continue;
        const brand = brandFromCampaignName(row.campaignName);
        const d = merged[row.date]      || (merged[row.date] = {});
        const b = d[brand]              || (d[brand] = {});
        const e = b[kind]               || (b[kind] = entry());
        if (mp === 'CA') { e.spendCad += cost; e.salesCad += sales; }
        else             { e.spendUsd += cost; e.salesUsd += sales; }
        e.clicks += clicks; e.impressions += impressions; e.orders += orders;
      }
    }
  }
  console.log(`[Ads] SB/SD daily merged: ${Object.keys(merged).length} dates`);
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

module.exports = {
  syncAdMetrics, startAdReports, finishAdReports, pullAdSpendDaily,
  pullBrandAdsDaily, brandFromCampaignName,
  // Low-level helpers shared by adsSearchTerms.js / adsCampaigns.js
  getAdsToken, adsReq, waitForAdReport, downloadAdReport, PROFILES,
};
