/**
 * Amazon SP-API Integration — Rocky Mountain Co.
 * Pulls: Sales & Traffic, Listing Status, FBA Inventory
 * Region: North America (US + CA)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const LISTINGS_CACHE_PATH = path.join(__dirname, '../data/listings-cache.json');
const LISTINGS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const SP_API_HOST = 'sellingpartnerapi-na.amazon.com';

const MARKETPLACE_CURRENCY = {
  'A2EUQ1WTGCTBG2': 'CAD', // Amazon.ca
  'ATVPDKIKX0DER':  'USD'  // Amazon.com
};

function getMarketplaceIds() {
  return (process.env.SP_API_MARKETPLACE_IDS || 'ATVPDKIKX0DER')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET
    }).toString();

    const req = https.request({
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode !== 200) reject(new Error(`LWA error: ${json.error_description || json.error}`));
        else resolve(json.access_token);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function spRequest(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = {
      'x-amz-access-token': token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({ hostname: SP_API_HOST, path, method, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Reports API ─────────────────────────────────────────────────────────────

async function createReport(reportType, marketplaceIds, reportOptions, dataRange, token) {
  const body = { reportType, marketplaceIds };
  if (reportOptions) body.reportOptions = reportOptions;
  if (dataRange) {
    body.dataStartTime = dataRange.start;
    body.dataEndTime = dataRange.end;
  }

  const res = await spRequest('POST', '/reports/2021-06-30/reports', token, body);
  if (res.status !== 202) {
    throw new Error(`Failed to create ${reportType}: ${JSON.stringify(res.body)}`);
  }
  return res.body.reportId;
}

async function waitForReport(reportId, token, maxWaitMs = 900000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await spRequest('GET', `/reports/2021-06-30/reports/${reportId}`, token);
    const { processingStatus, reportDocumentId } = res.body;

    if (processingStatus === 'DONE') return reportDocumentId;
    if (processingStatus === 'FATAL' || processingStatus === 'CANCELLED') {
      throw new Error(`Report ${reportId} ended with status: ${processingStatus}`);
    }

    console.log(`[Sync] Report ${reportId} status: ${processingStatus || JSON.stringify(res.body).slice(0, 100)}`);
    await sleep(15000); // Poll every 15 seconds
  }
  throw new Error(`Report ${reportId} timed out`);
}

async function downloadReport(documentId, token) {
  const res = await spRequest('GET', `/reports/2021-06-30/documents/${documentId}`, token);
  if (res.status !== 200) throw new Error(`Failed to get document ${documentId}: ${JSON.stringify(res.body)}`);

  const { url, compressionAlgorithm } = res.body;
  const buffer = await downloadUrl(url);

  if (compressionAlgorithm === 'GZIP') {
    return new Promise((resolve, reject) => {
      zlib.gunzip(buffer, (err, result) => {
        if (err) reject(err);
        else resolve(result.toString('utf8'));
      });
    });
  }
  return buffer.toString('utf8');
}

// ─── Report Parsers ──────────────────────────────────────────────────────────

function parseSalesTrafficReport(jsonStr) {
  const data = JSON.parse(jsonStr);
  const byAsin = {};

  // salesAndTrafficByAsin has one entry per child ASIN (aggregated across the date range)
  for (const item of (data.salesAndTrafficByAsin || [])) {
    const asin = item.childAsin || item.parentAsin;
    if (!asin) continue;

    const sales = item.salesByAsin || {};
    const traffic = item.trafficByAsin || {};

    if (!byAsin[asin]) byAsin[asin] = { revenue: 0, units: 0, sessions: 0, buyBoxPcts: [], cvrs: [] };

    byAsin[asin].revenue += sales.orderedProductSales?.amount || 0;
    byAsin[asin].units += sales.unitsOrdered || 0;
    byAsin[asin].sessions += traffic.sessions || 0;

    // API returns these as percentages (0–100), not decimals
    if (traffic.buyBoxPercentage != null) byAsin[asin].buyBoxPcts.push(traffic.buyBoxPercentage);
    if (traffic.unitSessionPercentage != null) byAsin[asin].cvrs.push(traffic.unitSessionPercentage);
  }

  const result = {};
  for (const [asin, d] of Object.entries(byAsin)) {
    result[asin] = {
      revenue: Math.round(d.revenue * 100) / 100,
      units: d.units,
      sessions: d.sessions,
      buyBox: d.buyBoxPcts.length ? avg(d.buyBoxPcts, 1) : null,
      cvr: d.cvrs.length ? avg(d.cvrs, 2) : null
    };
  }
  return result;
}

function parseListingsReport(tsvStr) {
  const lines = tsvStr.split('\n').filter(Boolean);
  if (lines.length < 2) return {};

  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const col = name => headers.indexOf(name);

  const result = {};
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    const asin = cols[col('asin1')]?.trim();
    if (!asin) continue;
    result[asin] = {
      title: cols[col('item-name')]?.trim() || '',
      status: (cols[col('status')]?.trim() || 'unknown').toLowerCase()
    };
  }
  return result;
}

// ─── Catalog Items API ───────────────────────────────────────────────────────

// Fetch brand names for a list of ASINs using Catalog Items API
// Pass 1: batch queries (faster) — Pass 2: individual lookups for anything still missing
async function getBrandsByAsin(asins, marketplaceIds, token) {
  const result = {};
  const batchSize = 20;

  // Pass 1 — batch queries per marketplace
  for (const marketplaceId of marketplaceIds) {
    const remaining = asins.filter(a => !result[a]);
    if (remaining.length === 0) break;

    for (let i = 0; i < remaining.length; i += batchSize) {
      const batch = remaining.slice(i, i + batchSize);
      const identifiers = batch.map(a => `identifiers=${encodeURIComponent(a)}`).join('&');
      const path = `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId}&${identifiers}&identifiersType=ASIN&includedData=summaries,attributes`;

      const res = await spRequest('GET', path, token);
      if (res.status !== 200) continue;

      for (const item of (res.body.items || [])) {
        const asin = item.asin;
        if (!asin || result[asin]) continue;
        const summary = item.summaries?.[0];
        const brand =
          summary?.brandName?.trim() ||
          item.attributes?.brand?.[0]?.value?.trim() ||
          null;
        const title = summary?.itemName?.trim() || '';
        if (brand) result[asin] = { brand, title };
        else if (title) result[asin] = { brand: null, title }; // save title even without brand
      }

      if (i + batchSize < remaining.length) await sleep(600);
    }
  }

  // Pass 2 — individual lookups for ASINs still missing brand data
  const stillMissing = asins.filter(a => !result[a] || !result[a].brand);
  if (stillMissing.length > 0) {
    console.log(`[Import] Batch missed ${stillMissing.length} ASINs — trying individual lookups...`);
    const mpParam = marketplaceIds.join(',');
    for (const asin of stillMissing) {
      try {
        const path = `/catalog/2022-04-01/items/${asin}?marketplaceIds=${mpParam}&includedData=summaries,attributes`;
        const res = await spRequest('GET', path, token);
        if (res.status !== 200) continue;
        const item = res.body;
        const summary = item.summaries?.[0];
        const brand =
          summary?.brandName?.trim() ||
          item.attributes?.brand?.[0]?.value?.trim() ||
          null;
        const title = summary?.itemName?.trim() || result[asin]?.title || '';
        if (brand || title) result[asin] = { brand: brand || null, title };
      } catch {}
      await sleep(500); // stay under 2 req/sec rate limit
    }
  }

  return result;
}

// Pull all active ASINs from listings + enrich with brand names from Catalog API
// Returns: { "Brand Name": ["ASIN1", "ASIN2", ...], ... }
async function importBrandsFromAmazon() {
  const token = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();

  // Get all active listings per marketplace
  console.log('[Import] Fetching listings from all marketplaces...');
  const listingsReportIds = await Promise.all(
    marketplaceIds.map(mpId => createReport('GET_MERCHANT_LISTINGS_ALL_DATA', [mpId], null, null, token))
  );
  const listingsDocIds = await Promise.all(listingsReportIds.map(id => waitForReport(id, token)));
  const listingsDatasets = await Promise.all(listingsDocIds.map(docId => downloadReport(docId, token).then(parseListingsReport)));

  // Merge listings — collect all unique active ASINs
  const allAsins = new Set();
  for (const dataset of listingsDatasets) {
    for (const [asin, d] of Object.entries(dataset)) {
      if (d.status === 'active') allAsins.add(asin);
    }
  }

  const asinList = [...allAsins];
  console.log(`[Import] Found ${asinList.length} active ASINs. Fetching brand names...`);

  // Build a title map from listings data (already fetched)
  const titleMap = {};
  for (const dataset of listingsDatasets) {
    for (const [asin, d] of Object.entries(dataset)) {
      if (d.title) titleMap[asin] = d.title;
    }
  }

  // Enrich with brand names — batch first, then individual lookups for misses
  const catalogData = await getBrandsByAsin(asinList, marketplaceIds, token);

  // Group by brand name — normalize to avoid "ACURE" vs "Acure" splits
  const grouped = {};
  for (const asin of asinList) {
    const info = catalogData[asin];
    const rawBrand = info?.brand || 'Unknown Brand';
    const brandName = rawBrand.trim().replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    if (!grouped[brandName]) grouped[brandName] = { asins: [], titles: {} };
    grouped[brandName].asins.push(asin);
    // Store title from catalog API or listings report fallback
    const title = info?.title || titleMap[asin] || '';
    if (title) grouped[brandName].titles[asin] = title;
  }

  console.log(`[Import] Grouped into ${Object.keys(grouped).length} brands.`);
  return grouped;
}

// ─── Inventory API ───────────────────────────────────────────────────────────

async function getInventory(marketplaceId, token) {
  const inventory = {};
  let nextToken = null;

  do {
    let path = `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;
    if (nextToken) path += `&nextToken=${encodeURIComponent(nextToken)}`;

    const res = await spRequest('GET', path, token);
    if (res.status !== 200) break;

    const { inventorySummaries, pagination } = res.body.payload || {};
    for (const item of (inventorySummaries || [])) {
      if (item.asin) inventory[item.asin] = (inventory[item.asin] || 0) + (item.fulfillableQuantity || 0);
    }

    nextToken = pagination?.nextToken || null;
  } while (nextToken);

  return inventory;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function avg(arr, decimals = 1) {
  const val = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

function getPresetRanges() {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const y = yesterday;

  const d7 = new Date(y); d7.setDate(y.getDate() - 6);
  const d14 = new Date(y); d14.setDate(y.getDate() - 13);
  const d30 = new Date(y); d30.setDate(y.getDate() - 29);

  const thisMonthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (thisMonthStart > y) thisMonthStart.setTime(y.getTime()); // guard: 1st of month
  const lastMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const lastMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);

  function r(start, end, label) {
    return {
      start: fmtDate(start) + 'T00:00:00Z',
      end:   fmtDate(end)   + 'T23:59:59Z',
      startDate: fmtDate(start),
      endDate:   fmtDate(end),
      label
    };
  }

  return {
    yesterday: r(y,              y,            'Yesterday'),
    thisMonth: r(thisMonthStart, y,            'This Month'),
    lastMonth: r(lastMonthStart, lastMonthEnd, 'Last Month')
  };
}

// ─── Main Sync ───────────────────────────────────────────────────────────────

function buildPresetMetrics(brands, stDatasets, marketplaceIds, listingsData, inventory) {
  // Merge S&T data — split revenue by currency
  const stData = {};
  for (let i = 0; i < stDatasets.length; i++) {
    const currency = MARKETPLACE_CURRENCY[marketplaceIds[i]] || 'USD';
    for (const [asin, d] of Object.entries(stDatasets[i])) {
      if (!stData[asin]) {
        stData[asin] = { revenueCad: 0, revenueUsd: 0, units: 0, sessions: 0, buyBoxSamples: [], cvrSamples: [] };
      }
      if (currency === 'CAD') stData[asin].revenueCad += d.revenue;
      else stData[asin].revenueUsd += d.revenue;
      stData[asin].units += d.units;
      stData[asin].sessions += d.sessions;
      if (d.buyBox != null) stData[asin].buyBoxSamples.push(d.buyBox);
      if (d.cvr != null) stData[asin].cvrSamples.push(d.cvr);
    }
  }
  for (const asin of Object.keys(stData)) {
    const d = stData[asin];
    stData[asin].buyBox = d.buyBoxSamples.length ? avg(d.buyBoxSamples, 1) : null;
    stData[asin].cvr = d.cvrSamples.length ? avg(d.cvrSamples, 2) : null;
  }

  const brandMetrics = {};
  for (const brand of brands) {
    const skus = brand.asins.map(asin => {
      const st = stData[asin] || {};
      const listing = listingsData[asin] || {};
      return {
        asin,
        title: listing.title || brand.asinTitles?.[asin] || '',
        status: listing.status || 'unknown',
        revenueCad: Math.round((st.revenueCad || 0) * 100) / 100,
        revenueUsd: Math.round((st.revenueUsd || 0) * 100) / 100,
        units: st.units || 0,
        sessions: st.sessions || 0,
        buyBox: st.buyBox ?? null,
        cvr: st.cvr ?? null,
        inventory: inventory[asin] || 0
      };
    });

    const totalRevCad = skus.reduce((s, x) => s + x.revenueCad, 0);
    const totalRevUsd = skus.reduce((s, x) => s + x.revenueUsd, 0);
    const totalUnits = skus.reduce((s, x) => s + x.units, 0);
    const totalSessions = skus.reduce((s, x) => s + x.sessions, 0);
    const bbValues = skus.filter(s => s.buyBox != null).map(s => s.buyBox);
    const suppressedListings = skus.filter(s => ['suppressed', 'inactive'].includes(s.status)).length;
    const lostBuyBox = skus.filter(s => s.buyBox != null && s.buyBox < 80).length;

    brandMetrics[brand.id] = {
      summary: {
        revenueCad: Math.round(totalRevCad * 100) / 100,
        revenueUsd: Math.round(totalRevUsd * 100) / 100,
        units: totalUnits,
        sessions: totalSessions,
        buyBox: bbValues.length ? avg(bbValues, 1) : null,
        alerts: { suppressedListings, lostBuyBox }
      },
      skus
    };
  }
  return brandMetrics;
}

async function syncBrandMetrics(brands) {
  console.log('[Sync] Starting SP-API sync...');

  const token = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const presets = getPresetRanges();
  const presetKeys = Object.keys(presets);

  // ── Listings + Inventory (cached 4h to avoid quota errors) ─────────────────
  let listingsData, inventory;
  try {
    const cache = JSON.parse(fs.readFileSync(LISTINGS_CACHE_PATH, 'utf8'));
    if (cache.fetched && (Date.now() - new Date(cache.fetched)) < LISTINGS_CACHE_TTL_MS) {
      console.log('[Sync] Using cached listings data (< 4h old)');
      listingsData = cache.listingsData;
      inventory = cache.inventory;
    }
  } catch {}

  if (!listingsData) {
    console.log('[Sync] Requesting listings + inventory reports...');
    const listingsReportIds = await Promise.all(
      marketplaceIds.map(mpId => createReport('GET_MERCHANT_LISTINGS_ALL_DATA', [mpId], null, null, token))
    );
    const listingsDocIds = await Promise.all(listingsReportIds.map(id => waitForReport(id, token)));
    const listingsDatasets = await Promise.all(listingsDocIds.map(docId => downloadReport(docId, token).then(parseListingsReport)));

    listingsData = {};
    for (const dataset of listingsDatasets) {
      for (const [asin, d] of Object.entries(dataset)) {
        if (!listingsData[asin] || d.status === 'active') listingsData[asin] = d;
      }
    }

    inventory = await getInventory(marketplaceIds[0], token);
    fs.writeFileSync(LISTINGS_CACHE_PATH, JSON.stringify({ fetched: new Date().toISOString(), listingsData, inventory }));
  }

  // ── S&T reports for all presets × all marketplaces (parallel) ───────────────
  console.log(`[Sync] Requesting S&T reports for ${presetKeys.length} presets × ${marketplaceIds.length} marketplaces...`);

  // Create all reports in parallel
  const stReportMap = {}; // key: "presetKey_mpId" → reportId
  await Promise.all(
    presetKeys.flatMap(presetKey =>
      marketplaceIds.map(async mpId => {
        const range = presets[presetKey];
        const id = await createReport(
          'GET_SALES_AND_TRAFFIC_REPORT', [mpId],
          { dateGranularity: 'SUMMARY', asinGranularity: 'CHILD' },
          range, token
        );
        stReportMap[`${presetKey}_${mpId}`] = id;
      })
    )
  );

  // Wait for all reports (all running in parallel on Amazon's side)
  // Use allSettled so a single stuck/failed report doesn't kill the whole sync
  console.log('[Sync] Waiting for all S&T reports...');
  const stDocMap = {};
  const waitResults = await Promise.allSettled(
    Object.entries(stReportMap).map(async ([key, reportId]) => ({ key, docId: await waitForReport(reportId, token) }))
  );
  for (const r of waitResults) {
    if (r.status === 'fulfilled') stDocMap[r.value.key] = r.value.docId;
    else console.warn(`[Sync] Report skipped: ${r.reason?.message}`);
  }

  // Download + parse all (skip any that failed above)
  console.log('[Sync] Downloading and parsing S&T reports...');
  const stParsedMap = {};
  const downloadResults = await Promise.allSettled(
    Object.entries(stDocMap).map(async ([key, docId]) => ({ key, data: await downloadReport(docId, token).then(parseSalesTrafficReport) }))
  );
  for (const r of downloadResults) {
    if (r.status === 'fulfilled') stParsedMap[r.value.key] = r.value.data;
    else console.warn(`[Sync] Download skipped: ${r.reason?.message}`);
  }

  // ── Add unassigned S&T ASINs to Unknown Brand ───────────────────────────────
  const allStAsins = new Set(Object.values(stParsedMap).flatMap(d => Object.keys(d)));
  const allBrandAsins = new Set(brands.flatMap(b => b.asins));
  const unassigned = [...allStAsins].filter(a => !allBrandAsins.has(a));

  if (unassigned.length > 0) {
    let unknownBrand = brands.find(b => b.id === 'unknown-brand');
    if (!unknownBrand) {
      unknownBrand = { id: 'unknown-brand', name: 'Unknown Brand', marketplace: 'CA', color: '#94a3b8', asins: [], asinTitles: {} };
      brands.push(unknownBrand);
    }
    for (const asin of unassigned) {
      if (!unknownBrand.asins.includes(asin)) {
        unknownBrand.asins.push(asin);
        const title = listingsData[asin]?.title;
        if (title) { unknownBrand.asinTitles = unknownBrand.asinTitles || {}; unknownBrand.asinTitles[asin] = title; }
      }
    }
    console.log(`[Sync] Added ${unassigned.length} unassigned ASINs to Unknown Brand`);
  }

  // ── Build per-preset brand metrics ──────────────────────────────────────────
  const result = {};
  for (const presetKey of presetKeys) {
    const stDatasets = marketplaceIds.map(mpId => stParsedMap[`${presetKey}_${mpId}`] || {});
    result[presetKey] = {
      label: presets[presetKey].label,
      startDate: presets[presetKey].startDate,
      endDate: presets[presetKey].endDate,
      brands: buildPresetMetrics(brands, stDatasets, marketplaceIds, listingsData, inventory)
    };
  }

  console.log('[Sync] Complete.');
  return { presets: result, updatedBrands: brands };
}

module.exports = { syncBrandMetrics, importBrandsFromAmazon };
