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
const { pstDateStr, pstSubtractDays, pstMidnightAsUTC, pstEndOfDayAsUTC } = require('./dateUtils');

const LISTINGS_CACHE_PATH = path.join(__dirname, '../data/listings-cache.json');
const LISTINGS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const IMAGE_CACHE_PATH = path.join(__dirname, '../data/image-cache.json');

const SP_API_HOST = 'sellingpartnerapi-na.amazon.com';

const MARKETPLACE_CURRENCY = {
  'A2EUQ1WTGCTBG2': 'CAD', // Amazon.ca
  'ATVPDKIKX0DER':  'USD'  // Amazon.com
};

const MARKETPLACE_CODE = {
  'A2EUQ1WTGCTBG2': 'CA',
  'ATVPDKIKX0DER':  'US'
};

function getMarketplaceIds() {
  return (process.env.SP_API_MARKETPLACE_IDS || 'ATVPDKIKX0DER')
    .split(',').map(s => s.trim()).filter(Boolean);
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiry = 0;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const token = await _fetchAccessToken();
  _cachedToken = token;
  _tokenExpiry = Date.now() + 50 * 60 * 1000; // refresh at 50min (tokens last 1h)
  return token;
}

async function _fetchAccessToken() {
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

async function spRequest(method, path, token, body = null, timeoutMs = 45000) {
  const request = new Promise((resolve, reject) => {
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
      res.on('error', reject);
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`SP-API request timed out after ${timeoutMs / 1000}s`)), timeoutMs)
  );
  return Promise.race([request, timeout]);
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

  for (let attempt = 1; attempt <= 5; attempt++) {
    const currentToken = await getAccessToken();
    const res = await spRequest('POST', '/reports/2021-06-30/reports', currentToken, body);
    if (res.status === 202) return res.body.reportId;
    const errCode = res.body?.errors?.[0]?.code;
    const isQuota = errCode === 'QuotaExceeded' || res.status === 429;
    const isTransient = errCode === 'InternalFailure' || (res.status >= 500 && res.status !== 501);
    if (attempt < 5 && (isQuota || isTransient)) {
      // Quota: short wait only — don't burn retries sitting in a loop for hours.
      // If quota is genuinely depleted, the backup cron (9am) will pick it up.
      const wait = isQuota ? 90000 : Math.min(attempt * 15000, 60000); // quota: 90s flat, transient: 15-60s
      const label = isQuota ? '90s' : `${Math.round(wait / 1000)}s`;
      console.warn(`[Reports] ${errCode} for ${reportType} — retrying in ${label} (attempt ${attempt}/5)`);
      await sleep(wait);
    } else {
      throw new Error(`Failed to create ${reportType}: ${JSON.stringify(res.body)}`);
    }
  }
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

    if (!byAsin[asin]) byAsin[asin] = { revenue: 0, units: 0, sessions: 0, pageViews: 0, buyBoxPcts: [], cvrs: [] };

    byAsin[asin].revenue += sales.orderedProductSales?.amount || 0;
    byAsin[asin].units += sales.unitsOrdered || 0;
    byAsin[asin].sessions += traffic.sessions || 0;
    byAsin[asin].pageViews += traffic.pageViews || 0;

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
      pageViews: d.pageViews,
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
    const productId   = cols[col('product-id')]?.trim() || '';
    const productType = cols[col('product-id-type')]?.trim() || '';
    // product-id-type: 1=ASIN, 2=ISBN, 3=UPC, 4=EAN
    const upc = (productType === '3' || productType === '4') ? productId : '';
    result[asin] = {
      title: cols[col('item-name')]?.trim() || '',
      status: (cols[col('status')]?.trim() || 'unknown').toLowerCase(),
      sellerSku: cols[col('seller-sku')]?.trim() || '',
      imageUrl: cols[col('image-url')]?.trim() || '',
      upc
    };
  }
  return result;
}

// ─── Catalog Items API ───────────────────────────────────────────────────────

// Fetch main product image URLs for a list of ASINs using individual lookups.
// Individual endpoint returns any catalog ASIN (not restricted to seller's active listings like the batch endpoint).
async function getAsinImages(asins, marketplaceIds, token) {
  const result = {};
  const mpIds = Array.isArray(marketplaceIds) ? marketplaceIds : [marketplaceIds];
  const mpParam = mpIds.join(',');
  let found = 0, missing = 0;

  console.log(`[Images] Fetching images for ${asins.length} ASINs (individual lookups)...`);

  for (const asin of asins) {
    if (result[asin]) continue;
    const path = `/catalog/2022-04-01/items/${encodeURIComponent(asin)}?marketplaceIds=${mpParam}&includedData=images`;
    try {
      const res = await spRequest('GET', path, token);
      if (res.status === 200 && res.body.images) {
        const allImgs = (res.body.images || []).flatMap(mp => mp.images || []);
        const main = allImgs.find(img => img.variant === 'MAIN') || allImgs[0];
        if (main?.link) { result[asin] = main.link; found++; }
        else missing++;
      } else if (res.status === 429) {
        console.warn(`[Images] Rate limited — waiting 5s`);
        await sleep(5000);
        const retry = await spRequest('GET', path, token);
        if (retry.status === 200 && retry.body.images) {
          const allImgs = (retry.body.images || []).flatMap(mp => mp.images || []);
          const main = allImgs.find(img => img.variant === 'MAIN') || allImgs[0];
          if (main?.link) { result[asin] = main.link; found++; }
        }
      }
    } catch (err) {
      console.warn(`[Images] ${asin} error: ${err.message}`);
    }
    await sleep(600); // 600ms between calls — stays within 2 req/s catalog limit
  }

  console.log(`[Images] Done: ${found} found, ${missing + (asins.length - found - missing)} not in catalog`);
  return result;
}

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

function parseInventoryItems(items, inventory) {
  for (const item of (items || [])) {
    if (!item.asin) continue;
    const d = item.inventoryDetails || {};
    const existing = inventory[item.asin] || { onHand: 0, inbound: 0, reserved: 0, researching: 0, unfulfillable: 0 };
    inventory[item.asin] = {
      onHand:        existing.onHand        + (d.fulfillableQuantity || 0),
      inbound:       existing.inbound       + (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0),
      reserved:      existing.reserved      + (d.reservedQuantity?.totalReservedQuantity || 0),
      researching:   existing.researching   + (d.researchingQuantity?.totalResearchingQuantity || 0),
      unfulfillable: existing.unfulfillable + (d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0),
      fbaTracked:    true, // ASIN appeared in FBA inventory response (vs absent = FBM-only)
    };
  }
}

// Fetch FBA inventory for a specific list of seller SKUs (up to 50 per call).
// Much faster than full pagination — use when seller SKUs are known.
async function getInventoryBySkus(marketplaceId, sellerSkus, token) {
  const inventory = {};
  const batchSize = 50;
  const base = `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}`;

  for (let i = 0; i < sellerSkus.length; i += batchSize) {
    if (i > 0) await sleep(600);
    const batch = sellerSkus.slice(i, i + batchSize);
    const skuParam = `sellerSkus=${encodeURIComponent(batch.join(','))}`;
    const path = `${base}&${skuParam}`;

    let res = await spRequest('GET', path, token);
    if (res.status === 429) {
      console.warn(`[Inventory] Rate limited — waiting 10s and retrying`);
      await sleep(10000);
      res = await spRequest('GET', path, token);
    }
    if (res.status !== 200) {
      console.warn(`[Inventory] HTTP ${res.status} for SKU batch ${Math.floor(i/batchSize)+1}`);
      continue;
    }
    parseInventoryItems(res.body.payload?.inventorySummaries, inventory);

    // Handle pagination within a SKU batch (rare but possible)
    let nextToken = res.body.pagination?.nextToken || null;
    while (nextToken) {
      await sleep(600);
      const pageRes = await spRequest('GET', `${base}&nextToken=${encodeURIComponent(nextToken)}`, token);
      if (pageRes.status !== 200) break;
      parseInventoryItems(pageRes.body.payload?.inventorySummaries, inventory);
      nextToken = pageRes.body.pagination?.nextToken || null;
    }
  }

  console.log(`[Inventory] ${marketplaceId}: ${Object.keys(inventory).length} ASINs via SKU lookup (${Math.ceil(sellerSkus.length/batchSize)} calls)`);
  return inventory;
}

// ─── Finances API ────────────────────────────────────────────────────────────

// Fee type → display group mapping
const FEE_GROUPS = {
  FBAPerUnitFulfillmentFee:          'FBA Fulfillment',
  FBAPerOrderFulfillmentFee:         'FBA Fulfillment',
  FBAWeightBasedFee:                 'FBA Fulfillment',
  Commission:                        'Referral Fee',
  FixedClosingFee:                   'Closing Fee',
  VariableClosingFee:                'Closing Fee',
  // Service fee types
  FBAStorageExpirationBillingFee:    'Storage',
  FBALongTermStorageFee:             'Storage',
  StorageRenewalBillingFee:          'Storage',
  FBAInboundTransportationFee:       'Inbound',
  FBAInboundTransportationProgramFee:'Inbound',
  FBAInboundConvenienceFee:          'Inbound',
  FBARemovalFee:                     'Removal',
  FBADisposalFee:                    'Removal',
  Vine:                              'Vine',
  CouponRedemptionFee:               'Coupons',
};

function feeGroup(type) {
  if (!type) return 'Other';
  for (const [key, group] of Object.entries(FEE_GROUPS)) {
    if (type.includes(key) || key.includes(type)) return group;
  }
  if (type.toLowerCase().includes('storage')) return 'Storage';
  if (type.toLowerCase().includes('inbound')) return 'Inbound';
  if (type.toLowerCase().includes('removal') || type.toLowerCase().includes('disposal')) return 'Removal';
  return 'Other';
}

async function getFinancialSummary(startDate, endDate, token) {
  const zero = () => ({ amazonFees: 0, serviceFees: 0, refundAmount: 0, refundFees: 0, adSpend: 0 });
  const result = { CAD: zero(), USD: zero(), refundCount: 0 };
  // feeBreakdown tracks totals per display group per currency
  const breakdown = { CAD: {}, USD: {} };
  const addBreakdown = (cur, group, amount) => {
    if (!breakdown[cur]) return;
    breakdown[cur][group] = (breakdown[cur][group] || 0) + amount;
  };
  let nextToken = null;
  let page = 0;

  do {
    const path = nextToken
      ? `/finances/v0/financialEvents?NextToken=${encodeURIComponent(nextToken)}&MaxResultsPerPage=100`
      : `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(startDate)}&PostedBefore=${encodeURIComponent(endDate)}&MaxResultsPerPage=100`;

    let res;
    try {
      res = await spRequest('GET', path, token, null, 90000); // 90s — API is slow on large result sets
    } catch (e) {
      console.warn(`[Finances] Request failed (page ${page}): ${e.message} — stopping pagination`);
      break;
    }
    if (res.status !== 200) {
      console.warn(`[Finances] HTTP ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      break;
    }

    const events = res.body.payload?.FinancialEvents || {};

    // FBA fulfillment fees + referral fees (per-order)
    for (const shipment of (events.ShipmentEventList || [])) {
      for (const item of (shipment.ShipmentItemList || [])) {
        for (const fee of (item.ItemFeeList || [])) {
          const amount = Math.abs(fee.FeeAmount?.CurrencyAmount || 0);
          const cur = fee.FeeAmount?.CurrencyCode;
          if (!cur || !result[cur] || amount === 0) continue;
          result[cur].amazonFees += amount;
          addBreakdown(cur, feeGroup(fee.FeeType), amount);
        }
      }
    }

    // Refunds — returned principal + refund processing fees
    for (const refund of (events.RefundEventList || [])) {
      for (const item of (refund.ShipmentItemAdjustmentList || [])) {
        result.refundCount++;
        for (const charge of (item.ItemChargeAdjustmentList || [])) {
          if (charge.ChargeType === 'Principal') {
            const amount = Math.abs(charge.ChargeAmount?.CurrencyAmount || 0);
            const cur = charge.ChargeAmount?.CurrencyCode;
            if (cur && result[cur]) result[cur].refundAmount += amount;
          }
        }
        for (const fee of (item.ItemFeeAdjustmentList || [])) {
          const raw = fee.FeeAmount?.CurrencyAmount || 0;
          if (raw < 0) {
            const cur = fee.FeeAmount?.CurrencyCode;
            if (cur && result[cur]) result[cur].refundFees += Math.abs(raw);
          }
        }
      }
    }

    // Service fees — storage, inbound, Vine, coupons, etc.
    for (const svc of (events.ServiceFeeEventList || [])) {
      for (const fee of (svc.FeeList || [])) {
        const amount = fee.FeeAmount?.CurrencyAmount || 0;
        const cur = fee.FeeAmount?.CurrencyCode;
        if (!cur || !result[cur] || amount >= 0) continue;
        result[cur].serviceFees += Math.abs(amount);
        addBreakdown(cur, feeGroup(fee.FeeType), Math.abs(amount));
      }
    }

    // Advertising spend — lives in ProductAdsPaymentEventList, not ServiceFeeEventList
    for (const adsEvent of (events.ProductAdsPaymentEventList || [])) {
      if ((adsEvent.TransactionType || '').toLowerCase() === 'charge') {
        const amount = Math.abs(adsEvent.TransactionValue?.CurrencyAmount || 0);
        const cur = adsEvent.TransactionValue?.CurrencyCode;
        if (cur && result[cur]) result[cur].adSpend += amount;
      }
    }

    nextToken = res.body.payload?.NextToken || res.body.nextToken || null;
    if (nextToken) {
      if (page % 10 === 0) console.log(`[Finances] Page ${page}...`);
      await sleep(4000); // 4s between pages — conservative to avoid rate-limit timeouts
    }
    page++;
  } while (nextToken && page < 100);

  for (const cur of Object.keys(result)) {
    for (const k of Object.keys(result[cur])) {
      result[cur][k] = Math.round(result[cur][k] * 100) / 100;
    }
  }
  // Round breakdown values
  for (const cur of Object.keys(breakdown)) {
    for (const k of Object.keys(breakdown[cur])) {
      breakdown[cur][k] = Math.round(breakdown[cur][k] * 100) / 100;
    }
  }
  result.CAD.breakdown = breakdown.CAD;
  result.USD.breakdown = breakdown.USD;
  return result;
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function avg(arr, decimals = 1) {
  const val = arr.reduce((a, b) => a + b, 0) / arr.length;
  return Math.round(val * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

function getPresetRanges() {
  const todayPst     = pstDateStr();
  const yest         = pstSubtractDays(todayPst, 1);

  // PST-aware month boundaries
  const [ty, tm] = todayPst.split('-').map(Number);
  const lastMonthStart = `${tm === 1 ? ty - 1 : ty}-${String(tm === 1 ? 12 : tm - 1).padStart(2, '0')}-01`;
  const lastMonthEndDate = pstSubtractDays(`${String(ty).padStart(4,'0')}-${String(tm).padStart(2,'0')}-01`, 1);
  const thisMonthStart = `${String(ty).padStart(4,'0')}-${String(tm).padStart(2,'0')}-01`;

  function r(startDate, endDate, label) {
    // Clamp start to yesterday if it somehow overshoots (e.g., MTD on the 1st)
    const s = startDate > yest ? yest : startDate;
    return {
      start:     pstMidnightAsUTC(s),
      end:       pstEndOfDayAsUTC(endDate),
      startDate: s,
      endDate,
      label
    };
  }

  // Keep to 5 core presets × 2 markets = 10 S&T reports per sync.
  // Wider ranges (last60d, last90d, ytd) burn API quota fast and rarely add
  // actionable insight over last30d. Add them back if quota allows.
  return {
    yesterday:  r(yest,                          yest,            'Yesterday'),
    last7d:     r(pstSubtractDays(yest, 6),      yest,            'Last 7 Days'),
    last30d:    r(pstSubtractDays(yest, 29),     yest,            'Last 30 Days'),
    mtd:        r(thisMonthStart,                yest,            'Month to Date'),
    lastMonth:  r(lastMonthStart,                lastMonthEndDate,'Last Month'),
  };
}

// ─── Main Sync ───────────────────────────────────────────────────────────────

function buildPresetMetrics(brands, stDatasets, marketplaceIds, listingsData, inventory, imageUrls = {}) {
  // Merge S&T data — split revenue by currency
  const stData = {};
  for (let i = 0; i < stDatasets.length; i++) {
    const currency = MARKETPLACE_CURRENCY[marketplaceIds[i]] || 'USD';
    for (const [asin, d] of Object.entries(stDatasets[i])) {
      if (!stData[asin]) {
        stData[asin] = { revenueCad: 0, revenueUsd: 0, units: 0, unitsCad: 0, unitsUsd: 0, sessions: 0, sessionsCad: 0, sessionsUsd: 0, pageViews: 0, buyBoxSamples: [], cvrSamples: [] };
      }
      if (currency === 'CAD') {
        stData[asin].revenueCad += d.revenue;
        stData[asin].unitsCad += d.units;
        stData[asin].sessionsCad += d.sessions;
      } else {
        stData[asin].revenueUsd += d.revenue;
        stData[asin].unitsUsd += d.units;
        stData[asin].sessionsUsd += d.sessions;
      }
      stData[asin].units += d.units;
      stData[asin].sessions += d.sessions;
      stData[asin].pageViews += (d.pageViews || 0);
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
      const inv = inventory[asin] || {};
      const effectiveStatus = (st.units > 0 || (inv.onHand > 0))
        ? 'active'
        : (listing.status || 'unknown');
      return {
        asin,
        sellerSku: listing.sellerSku || '',
        marketplace: listing.marketplace || brand.marketplace || 'CA',
        title: listing.title || brand.asinTitles?.[asin] || '',
        status: effectiveStatus,
        revenueCad: Math.round((st.revenueCad || 0) * 100) / 100,
        revenueUsd: Math.round((st.revenueUsd || 0) * 100) / 100,
        units: st.units || 0,
        unitsCad: st.unitsCad || 0,
        unitsUsd: st.unitsUsd || 0,
        sessions: st.sessions || 0,
        pageViews: st.pageViews || 0,
        buyBox: st.buyBox ?? null,
        cvr: st.cvr ?? null,
        marketplaces: [
          ...((st.unitsCad || 0) > 0 || (st.revenueCad || 0) > 0 ? ['CA'] : []),
          ...((st.unitsUsd || 0) > 0 || (st.revenueUsd || 0) > 0 ? ['US'] : [])
        ],
        inventory: inv.onHand !== undefined ? inv : { onHand: 0, inbound: 0, reserved: 0, researching: 0, unfulfillable: 0 },
        imageUrl: imageUrls[asin] || null
      };
    });

    const totalRevCad = skus.reduce((s, x) => s + x.revenueCad, 0);
    const totalRevUsd = skus.reduce((s, x) => s + x.revenueUsd, 0);
    const totalUnits = skus.reduce((s, x) => s + x.units, 0);
    const totalSessions = skus.reduce((s, x) => s + x.sessions, 0);
    const bbValues = skus.filter(s => s.buyBox != null).map(s => s.buyBox);
    const cvrValues = skus.filter(s => s.cvr != null).map(s => s.cvr);
    const suppressedListings = skus.filter(s => ['suppressed', 'inactive'].includes(s.status)).length;
    const lostBuyBox = skus.filter(s => s.buyBox != null && s.buyBox < 80).length;

    brandMetrics[brand.id] = {
      summary: {
        revenueCad: Math.round(totalRevCad * 100) / 100,
        revenueUsd: Math.round(totalRevUsd * 100) / 100,
        units: totalUnits,
        sessions: totalSessions,
        buyBox: bbValues.length ? avg(bbValues, 1) : null,
        avgCvr: cvrValues.length ? avg(cvrValues, 2) : null,
        alerts: { suppressedListings, lostBuyBox }
      },
      skus
    };
  }
  // Catch any ASINs in S&T data not assigned to any brand — fold into Unknown Brand
  // so aggregate revenue totals always match what Amazon reports
  const allTrackedAsins = new Set(brands.flatMap(b => b.asins));
  const orphaned = Object.entries(stData).filter(([asin]) => !allTrackedAsins.has(asin));

  if (orphaned.length > 0) {
    if (!brandMetrics['unknown-brand']) {
      brandMetrics['unknown-brand'] = {
        summary: { revenueCad: 0, revenueUsd: 0, units: 0, sessions: 0, buyBox: null, avgCvr: null, alerts: { suppressedListings: 0, lostBuyBox: 0 } },
        skus: []
      };
    }
    const ub = brandMetrics['unknown-brand'];
    for (const [asin, st] of orphaned) {
      ub.summary.revenueCad += st.revenueCad || 0;
      ub.summary.revenueUsd += st.revenueUsd || 0;
      ub.summary.units      += st.units || 0;
      ub.summary.sessions   += st.sessions || 0;
      ub.skus.push({
        asin,
        sellerSku:  listingsData[asin]?.sellerSku || '',
        marketplace: listingsData[asin]?.marketplace || 'CA',
        title:      listingsData[asin]?.title || '',
        status:     'untracked',
        revenueCad: Math.round((st.revenueCad || 0) * 100) / 100,
        revenueUsd: Math.round((st.revenueUsd || 0) * 100) / 100,
        units:      st.units || 0,
        unitsCad:   st.unitsCad || 0,
        unitsUsd:   st.unitsUsd || 0,
        sessions:   st.sessions || 0,
        pageViews:  st.pageViews || 0,
        buyBox:     st.buyBox ?? null,
        cvr:        st.cvr ?? null,
        marketplaces: [
          ...((st.unitsCad || 0) > 0 || (st.revenueCad || 0) > 0 ? ['CA'] : []),
          ...((st.unitsUsd || 0) > 0 || (st.revenueUsd || 0) > 0 ? ['US'] : [])
        ],
        inventory:  inventory[asin] || { onHand: 0, inbound: 0, reserved: 0, researching: 0, unfulfillable: 0 },
        imageUrl:   imageUrls[asin] || null
      });
    }
    ub.summary.revenueCad = Math.round(ub.summary.revenueCad * 100) / 100;
    ub.summary.revenueUsd = Math.round(ub.summary.revenueUsd * 100) / 100;
    console.log(`[Sync] ${orphaned.length} untracked ASINs folded into Unknown Brand metrics`);
  }

  return brandMetrics;
}

async function syncBrandMetrics(brands) {
  console.log('[Sync] Starting SP-API sync...');

  const token = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const presets = getPresetRanges();
  const presetKeys = Object.keys(presets);

  // ── Persistent image cache (merge-only, never overwritten) ──────────────────
  let persistedImages = {};
  try {
    persistedImages = JSON.parse(fs.readFileSync(IMAGE_CACHE_PATH, 'utf8'));
    console.log(`[Sync] Loaded ${Object.keys(persistedImages).length} images from persistent cache`);
  } catch {}

  // ── Listings + Inventory (cached 24h; stale fallback if Amazon reports hang) ──
  let listingsData, inventory, imageUrls;

  // Always load whatever cache exists so we have a fallback if fresh fetch times out
  let staleCache = null;
  try { staleCache = JSON.parse(fs.readFileSync(LISTINGS_CACHE_PATH, 'utf8')); } catch {}

  const cacheAgeMs = staleCache?.fetched ? Date.now() - new Date(staleCache.fetched) : Infinity;
  if (cacheAgeMs < LISTINGS_CACHE_TTL_MS) {
    console.log(`[Sync] Using cached listings data (${Math.round(cacheAgeMs / 3600000)}h old)`);
    listingsData = staleCache.listingsData;
    inventory    = staleCache.inventory;
    imageUrls    = { ...(staleCache.imageUrls || {}), ...persistedImages };
  }

  if (!listingsData) {
    console.log('[Sync] Requesting listings + inventory reports...');

    const LISTINGS_HARD_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — kills stuck reports
    const hardTimeout = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('Listings fetch timed out after 20min')), LISTINGS_HARD_TIMEOUT_MS)
    );

    try {
      await Promise.race([
        (async () => {
          const listingsReportIds = await Promise.all(
            marketplaceIds.map(mpId => createReport('GET_MERCHANT_LISTINGS_ALL_DATA', [mpId], null, null, token))
          );
          const listingsDocIds = await Promise.all(listingsReportIds.map(id => waitForReport(id, token)));
          const listingsDatasets = await Promise.all(
            listingsDocIds.map((docId, i) =>
              downloadReport(docId, token).then(raw => ({
                marketplace: MARKETPLACE_CODE[marketplaceIds[i]] || 'CA',
                data: parseListingsReport(raw)
              }))
            )
          );

          listingsData = {};
          for (const { marketplace, data } of listingsDatasets) {
            for (const [asin, d] of Object.entries(data)) {
              if (!listingsData[asin] || d.status === 'active') listingsData[asin] = { ...d, marketplace };
            }
          }

          const skusByMarketplace = {};
          for (const mpId of marketplaceIds) {
            const mpCode = MARKETPLACE_CODE[mpId] || 'CA';
            skusByMarketplace[mpId] = Object.values(listingsData)
              .filter(d => d.marketplace === mpCode && d.sellerSku)
              .map(d => d.sellerSku);
          }

          const inventoryResults = await Promise.all(
            marketplaceIds.map(mpId => getInventoryBySkus(mpId, skusByMarketplace[mpId], token))
          );
          inventory = {};
          for (const inv of inventoryResults) {
            for (const [asin, data] of Object.entries(inv)) {
              if (!inventory[asin]) inventory[asin] = { onHand: 0, inbound: 0, reserved: 0, researching: 0, unfulfillable: 0 };
              inventory[asin].onHand        += data.onHand;
              inventory[asin].inbound       += data.inbound;
              inventory[asin].reserved      += data.reserved;
              inventory[asin].researching   += data.researching;
              inventory[asin].unfulfillable += data.unfulfillable;
            }
          }

          let listingsUpcCount = 0;
          for (const brand of brands) {
            brand.upcs = brand.upcs || {};
            brand.asinSkus = brand.asinSkus || {};
            brand.asinMarketplaces = brand.asinMarketplaces || {};
            for (const asin of brand.asins) {
              const listing = listingsData[asin];
              if (!listing) continue;
              if (!(asin in brand.upcs) && listing.upc) { brand.upcs[asin] = listing.upc; listingsUpcCount++; }
              if (listing.sellerSku) brand.asinSkus[asin] = listing.sellerSku;
              if (listing.marketplace) brand.asinMarketplaces[asin] = listing.marketplace;
            }
          }
          if (listingsUpcCount > 0) console.log(`[Sync] Applied ${listingsUpcCount} UPCs from listings report`);

          imageUrls = {};
          for (const [asin, d] of Object.entries(listingsData)) {
            if (d.imageUrl) imageUrls[asin] = d.imageUrl;
          }
          console.log(`[Sync] Got ${Object.keys(imageUrls).length} images from listings report`);

          const allAsins = [...new Set(brands.flatMap(b => b.asins))];
          const catalogImages = await getAsinImages(allAsins, marketplaceIds, token);
          Object.assign(imageUrls, catalogImages);
          Object.assign(imageUrls, persistedImages);
          console.log(`[Sync] Total images after Catalog API overlay + persistent cache: ${Object.keys(imageUrls).length}`);

          fs.writeFileSync(LISTINGS_CACHE_PATH, JSON.stringify({ fetched: new Date().toISOString(), listingsData, inventory, imageUrls }));
        })(),
        hardTimeout,
      ]);
    } catch (listingsErr) {
      console.warn(`[Sync] Listings fetch failed: ${listingsErr.message}`);
      if (staleCache?.listingsData) {
        console.log('[Sync] Falling back to stale listings cache — revenue data unaffected');
        listingsData = staleCache.listingsData;
        inventory    = staleCache.inventory;
        imageUrls    = { ...(staleCache.imageUrls || {}), ...persistedImages };
      } else {
        console.warn('[Sync] No listings cache available — continuing with empty listings');
        listingsData = {};
        inventory    = {};
        imageUrls    = {};
      }
    }
  }

  imageUrls = imageUrls || {};

  // Financial events are fetched in the background after the sync completes
  // (see backgroundUpdateFinancials in server.js) to avoid blocking S&T reports.
  const financialsMap = {};

  // ── S&T reports for all presets × all marketplaces (parallel) ───────────────
  console.log(`[Sync] Requesting S&T reports for ${presetKeys.length} presets × ${marketplaceIds.length} marketplaces...`);

  // Create reports sequentially to avoid QuotaExceeded bursts
  const stReportMap = {}; // key: "presetKey_mpId" → reportId
  for (const presetKey of presetKeys) {
    for (const mpId of marketplaceIds) {
      const range = presets[presetKey];
      const id = await createReport(
        'GET_SALES_AND_TRAFFIC_REPORT', [mpId],
        { dateGranularity: 'SUMMARY', asinGranularity: 'CHILD' },
        range, token
      );
      stReportMap[`${presetKey}_${mpId}`] = id;
      await sleep(2000); // 2s between requests — well within quota
    }
  }

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

  // ── Auto-map + clean up unassigned ASINs ────────────────────────────────────
  const allStAsins = new Set(Object.values(stParsedMap).flatMap(d => Object.keys(d)));
  const allBrandAsins = new Set(brands.filter(b => b.id !== 'unknown-brand').flatMap(b => b.asins));
  const unassigned = [...allStAsins].filter(a => !allBrandAsins.has(a));

  // Real brands sorted longest-name-first to avoid "Acure" matching before "Acure Organics"
  const realBrands = brands
    .filter(b => b.id !== 'unknown-brand')
    .sort((a, b) => b.name.length - a.name.length);

  const CORP_SUFFIXES = /\s+(co\.?|inc\.?|ltd\.?|corp\.?|llc\.?|co\b)$/i;
  const APOS_RE = /[\u0027\u2018\u2019\u0060]/g; // ', ', ', `
  function normalizeForMatch(s) {
    return s.toLowerCase().trim().replace(APOS_RE, '');
  }

  function tryAutoMap(asin, title) {
    if (!title) return false;
    const t = normalizeForMatch(title);
    for (const brand of realBrands) {
      const bn = normalizeForMatch(brand.name);
      const bnShort = bn.replace(CORP_SUFFIXES, '').trim();
      for (const name of [...new Set([bn, bnShort])]) {
        if (!name) continue;
        // Primary match only: title must START WITH the brand name.
        // The secondary "whole-word anywhere in first 60 chars" match was removed because
        // it caused false positives — e.g. "Acure" matching against unrelated titles
        // that happened to contain the word somewhere near the start.
        if (t.startsWith(name + ' ') || t.startsWith(name + ',') || t.startsWith(name + '-') || t.startsWith(name + '|') || t === name) {
          if (!brand.asins.includes(asin)) {
            brand.asins.push(asin);
            brand.asinTitles = brand.asinTitles || {};
            brand.asinTitles[asin] = title;
          }
          return brand.name;
        }
      }
    }
    return false;
  }

  // 1. Re-check existing unknown-brand ASINs — some may now be mappable
  let unknownBrand = brands.find(b => b.id === 'unknown-brand');
  if (unknownBrand?.asins?.length > 0) {
    const remapped = [], remaining = [];
    for (const asin of unknownBrand.asins) {
      const title = listingsData[asin]?.title || unknownBrand.asinTitles?.[asin] || '';
      const matched = tryAutoMap(asin, title);
      if (matched) remapped.push({ asin, brand: matched });
      else remaining.push(asin);
    }
    if (remapped.length > 0) {
      unknownBrand.asins = remaining;
      console.log(`[Sync] Auto-mapped ${remapped.length} existing unknown-brand ASINs by title`);
    }
  }

  // 2. Process newly unassigned ASINs (not in ANY brand yet, including unknown-brand).
  // We re-check brands.flatMap here (not the pre-built allBrandAsins set) so that ASINs
  // already moved to a real brand in step 1 are excluded — prevents double-processing.
  // This also ensures ASINs already in unknown-brand are never re-added here.
  const allAssignedAfterStep1 = new Set(brands.flatMap(b => b.asins));
  const newUnassigned = unassigned.filter(a => !allAssignedAfterStep1.has(a));
  const autoMapped = [], stillUnknown = [];

  for (const asin of newUnassigned) {
    const title = listingsData[asin]?.title || '';
    const matched = tryAutoMap(asin, title);
    if (matched) autoMapped.push({ asin, brand: matched });
    else stillUnknown.push(asin);
  }
  if (autoMapped.length > 0)
    console.log(`[Sync] Auto-mapped ${autoMapped.length} new ASINs by brand name in title`);

  // 3. Fetch missing titles from Catalog API for anything still titleless
  const needTitles = [...newUnassigned, ...(unknownBrand?.asins || [])]
    .filter(a => !listingsData[a]?.title);
  if (needTitles.length > 0) {
    console.log(`[Sync] Fetching titles for ${needTitles.length} ASINs missing titles...`);
    const catalogData = await getBrandsByAsin(needTitles, marketplaceIds, token);
    for (const [asin, data] of Object.entries(catalogData)) {
      if (!data.title) continue;
      if (!listingsData[asin]) listingsData[asin] = { title: '', status: 'unknown', sellerSku: '', imageUrl: '', upc: '' };
      listingsData[asin].title = data.title;
      // Update any brand that already has this ASIN
      for (const brand of brands) {
        if (brand.asins.includes(asin)) {
          brand.asinTitles = brand.asinTitles || {};
          brand.asinTitles[asin] = data.title;
        }
      }
      // Re-try auto-map now that we have a title
      if (stillUnknown.includes(asin)) {
        const matched = tryAutoMap(asin, data.title);
        if (matched) {
          stillUnknown.splice(stillUnknown.indexOf(asin), 1);
          autoMapped.push({ asin, brand: matched });
        }
      }
    }
    console.log(`[Sync] Title fetch complete`);
  }

  // 3b. Backfill titles for brand ASINs missing titles from the listings report
  const brandMissingTitles = brands
    .filter(b => b.id !== 'unknown-brand')
    .flatMap(b => b.asins.filter(a => !listingsData[a]?.title && !b.asinTitles?.[a]));
  if (brandMissingTitles.length > 0) {
    console.log(`[Sync] Backfilling titles for ${brandMissingTitles.length} brand ASINs via Catalog API...`);
    const catalogData = await getBrandsByAsin([...new Set(brandMissingTitles)], marketplaceIds, token);
    for (const [asin, data] of Object.entries(catalogData)) {
      if (!data.title) continue;
      if (!listingsData[asin]) listingsData[asin] = { title: '', status: 'unknown', sellerSku: '', imageUrl: '', upc: '' };
      listingsData[asin].title = data.title;
      for (const brand of brands) {
        if (brand.asins.includes(asin)) {
          brand.asinTitles = brand.asinTitles || {};
          brand.asinTitles[asin] = data.title;
        }
      }
    }
    console.log(`[Sync] Brand title backfill complete`);
  }

  // 4. Fetch images for newly discovered ASINs (cap at 50 to keep sync time reasonable)
  const needImages = newUnassigned.filter(a => !imageUrls[a]).slice(0, 50);
  if (needImages.length > 0) {
    console.log(`[Sync] Fetching images for ${needImages.length} newly discovered ASINs...`);
    const newImages = await getAsinImages(needImages, marketplaceIds, token);
    Object.assign(imageUrls, newImages);
    console.log(`[Sync] Got ${Object.keys(newImages).length} new images`);
  }

  // 5. Backfill images for brand ASINs still missing them (cap at 50 per sync)
  const missingImages = brands
    .filter(b => b.id !== 'unknown-brand')
    .flatMap(b => b.asins)
    .filter(a => !imageUrls[a])
    .slice(0, 50);
  if (missingImages.length > 0) {
    console.log(`[Sync] Backfilling images for ${missingImages.length} brand ASINs missing images...`);
    const backfilled = await getAsinImages(missingImages, marketplaceIds, token);
    Object.assign(imageUrls, backfilled);
    console.log(`[Sync] Backfilled ${Object.keys(backfilled).length} images`);
  }

  // 6. Dump truly unassigned into Unknown Brand
  if (stillUnknown.length > 0) {
    if (!unknownBrand) {
      unknownBrand = { id: 'unknown-brand', name: 'Unknown Brand', marketplace: 'CA', color: '#f59e0b', asins: [], asinTitles: {} };
      brands.push(unknownBrand);
    }
    for (const asin of stillUnknown) {
      if (!unknownBrand.asins.includes(asin)) {
        unknownBrand.asins.push(asin);
        const title = listingsData[asin]?.title;
        if (title) { unknownBrand.asinTitles = unknownBrand.asinTitles || {}; unknownBrand.asinTitles[asin] = title; }
      }
    }
    console.log(`[Sync] ${stillUnknown.length} ASINs remain in Unknown Brand`);
  }

  // 7. Persist images to dedicated image cache (merge-only — never loses previous entries)
  try {
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(IMAGE_CACHE_PATH, 'utf8')); } catch {}
    const merged = { ...existing, ...imageUrls };
    fs.writeFileSync(IMAGE_CACHE_PATH, JSON.stringify(merged));
    console.log(`[Sync] Image cache saved: ${Object.keys(merged).length} total images`);
  } catch (e) {
    console.warn('[Sync] Could not save image cache:', e.message);
  }

  // Update listings cache titles so next sync benefits (imageUrls intentionally excluded — see IMAGE_CACHE_PATH)
  try {
    const cache = JSON.parse(fs.readFileSync(LISTINGS_CACHE_PATH, 'utf8'));
    cache.listingsData = listingsData;
    fs.writeFileSync(LISTINGS_CACHE_PATH, JSON.stringify(cache));
  } catch (e) {
    console.warn('[Sync] Could not update listings cache:', e.message);
  }

  // ── Build per-preset brand metrics ──────────────────────────────────────────
  const result = {};
  for (const presetKey of presetKeys) {
    const stDatasets = marketplaceIds.map(mpId => stParsedMap[`${presetKey}_${mpId}`] || {});
    result[presetKey] = {
      label: presets[presetKey].label,
      startDate: presets[presetKey].startDate,
      endDate: presets[presetKey].endDate,
      financials: financialsMap[presetKey] || {
        CAD: { amazonFees: 0, refundAmount: 0, refundFees: 0, adSpend: 0 },
        USD: { amazonFees: 0, refundAmount: 0, refundFees: 0, adSpend: 0 }
      },
      brands: buildPresetMetrics(brands, stDatasets, marketplaceIds, listingsData, inventory, imageUrls)
    };
  }

  // ── Active Promotions (COUPON + PED) ────────────────────────────────────────
  const asinPromos = await fetchActivePromotions(marketplaceIds, token).catch(e => {
    console.log('[Sync] Promotions fetch skipped:', e.message);
    return {};
  });
  for (const brand of brands) {
    brand.asinPromos = {};
    for (const asin of brand.asins) {
      if (asinPromos[asin]?.length) brand.asinPromos[asin] = asinPromos[asin];
    }
  }

  // ── Subscribe & Save subscriber counts ──────────────────────────────────────
  const asinSns = await fetchSnsSubscriptions(marketplaceIds, token).catch(e => {
    console.log('[Sync] S&S fetch skipped:', e.message);
    return {};
  });
  for (const brand of brands) {
    brand.asinSns = {};
    for (const asin of brand.asins) {
      if (asinSns[asin] > 0) brand.asinSns[asin] = asinSns[asin];
    }
  }

  console.log('[Sync] Complete.');
  return { presets: result, updatedBrands: brands };
}

// ─── UPC Scraper ─────────────────────────────────────────────────────────────

function extractUpcFromIdentifiers(identifiers) {
  const allIds = [];
  for (const mp of (identifiers || [])) {
    for (const id of (mp.identifiers || [])) allIds.push(id);
  }
  const priority = ['UPC', 'EAN', 'GTIN'];
  for (const type of priority) {
    const match = allIds.find(id => id.identifierType === type);
    if (match) {
      let val = match.identifier;
      if (type === 'GTIN' && val.length === 14 && val.startsWith('00')) val = val.slice(2);
      return val;
    }
  }
  return null;
}

async function fetchUpcsForAsins(asins) {
  const token = await getAccessToken();
  const marketplaceIds = getMarketplaceIds();
  const mpParam = marketplaceIds.join(',');
  const result = {};
  let found = 0;

  // Individual lookups only — batch endpoint misses non-seller catalog ASINs
  console.log(`[UPC] Fetching UPCs for ${asins.length} ASINs via individual lookups...`);
  for (const asin of asins) {
    try {
      const path = `/catalog/2022-04-01/items/${asin}?marketplaceIds=${mpParam}&includedData=identifiers`;
      const res = await spRequest('GET', path, token);
      if (res.status === 200) {
        const upc = extractUpcFromIdentifiers(res.body.identifiers);
        if (upc) { result[asin] = upc; found++; }
      } else if (res.status === 429) {
        await sleep(5000);
        const retry = await spRequest('GET', path, token);
        if (retry.status === 200) {
          const upc = extractUpcFromIdentifiers(retry.body.identifiers);
          if (upc) { result[asin] = upc; found++; }
        }
      }
    } catch (e) {
      console.warn(`[UPC] ${asin} error: ${e.message}`);
    }
    await sleep(300);
  }

  console.log(`[UPC] Done: ${found}/${asins.length} UPCs found`);
  return result;
}

async function fetchFinancialEvents() {
  const token = await getAccessToken();
  const presets = getPresetRanges();
  const emptyF = () => ({
    CAD: { amazonFees: 0, refundAmount: 0, refundFees: 0, adSpend: 0 },
    USD: { amazonFees: 0, refundAmount: 0, refundFees: 0, adSpend: 0 }
  });
  const financialsMap = {};
  for (const [presetKey, range] of Object.entries(presets)) {
    try {
      financialsMap[presetKey] = await getFinancialSummary(range.start, range.end, token);
      const f = financialsMap[presetKey];
      console.log(`[Finances] OK for ${presetKey}: fees CAD=${f.CAD.amazonFees} USD=${f.USD.amazonFees}`);
    } catch (err) {
      console.warn(`[Finances] Failed for ${presetKey}: ${err.message}`);
      financialsMap[presetKey] = emptyF();
    }
    await sleep(2100);
  }
  return financialsMap;
}

// ───────────────────────────────────────────────────────────────────────────────
// Listing Health enrichment — buy box owners, catalog content snapshots, variations
// ───────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');

// Fetch the buy-box winning seller + total offer count per ASIN.
// Uses /products/pricing/v0/items/.../offers per-ASIN (the batch endpoint is rate-limited
// more aggressively in practice). Returns { [asin]: { sellerId, sellerName, price, offerCount, isFba } }
async function getBuyBoxOwners(asins, marketplaceId, token) {
  const result = {};
  if (!asins?.length) return result;
  console.log(`[Health] Fetching buy-box owners for ${asins.length} ASINs on ${marketplaceId}...`);
  let ok = 0, miss = 0;
  for (const asin of asins) {
    const path = `/products/pricing/v0/items/${encodeURIComponent(asin)}/offers?MarketplaceId=${marketplaceId}&ItemCondition=New`;
    try {
      let res = await spRequest('GET', path, token);
      if (res.status === 429) {
        await sleep(5000);
        res = await spRequest('GET', path, token);
      }
      if (res.status !== 200) { miss++; continue; }
      const payload = res.body?.payload || res.body;
      const summary = payload?.Summary || {};
      const offers = payload?.Offers || [];
      const offerCount = summary?.TotalOfferCount ?? offers.length;
      const winner = offers.find(o => o?.IsBuyBoxWinner === true) || null;
      if (winner) {
        const price = (winner.ListingPrice?.Amount || 0) + (winner.Shipping?.Amount || 0);
        result[asin] = {
          sellerId:  winner.SellerId || null,
          sellerName: winner.SellerName || winner.SellerFeedbackRating?.SellerName || null,
          price,
          currency: winner.ListingPrice?.CurrencyCode || null,
          isFba: winner.IsFulfilledByAmazon === true,
          offerCount,
        };
      } else {
        result[asin] = { sellerId: null, sellerName: null, price: null, currency: null, isFba: null, offerCount };
      }
      ok++;
    } catch (err) {
      console.warn(`[Health] BB owner ${asin} error: ${err.message}`);
      miss++;
    }
    await sleep(700); // ~1.4 rps; Pricing API limit is 0.5 rps + burst 1
  }
  console.log(`[Health] Buy-box owners: ${ok} found, ${miss} missed`);
  return result;
}

// Fetch catalog content (title, bullets, main image, variation children) per ASIN.
// Uses searchCatalogItems batched up to 20 ASINs per call (2 rps limit).
async function getCatalogSnapshots(asins, marketplaceId, token) {
  const result = {};
  if (!asins?.length) return result;
  console.log(`[Health] Fetching catalog snapshots for ${asins.length} ASINs on ${marketplaceId}...`);

  const BATCH = 20;
  for (let i = 0; i < asins.length; i += BATCH) {
    const slice = asins.slice(i, i + BATCH);
    const ids = slice.join(',');
    const path = `/catalog/2022-04-01/items?identifiers=${ids}&identifiersType=ASIN&marketplaceIds=${marketplaceId}&includedData=attributes,images,relationships,summaries`;
    try {
      let res = await spRequest('GET', path, token);
      if (res.status === 429) {
        await sleep(5000);
        res = await spRequest('GET', path, token);
      }
      if (res.status !== 200) { console.warn(`[Health] Catalog batch failed: ${res.status}`); await sleep(600); continue; }
      const items = res.body?.items || [];
      for (const item of items) {
        const asin = item.asin;
        const summary = (item.summaries || []).find(s => s.marketplaceId === marketplaceId) || item.summaries?.[0] || {};
        const attrs = item.attributes || {};
        const title = summary.itemName || attrs.item_name?.[0]?.value || null;
        const bullets = (attrs.bullet_point || []).map(b => b.value).filter(Boolean);
        const imgs = (item.images || []).find(g => g.marketplaceId === marketplaceId)?.images || item.images?.[0]?.images || [];
        // Extract stable image ID from Amazon CDN URL (path /images/I/{id}.{ext}).
        const idOf = link => link?.match(/\/images\/I\/([A-Za-z0-9+-]+)/)?.[1] || null;
        // Amazon returns multiple MAIN entries at different resolutions, sometimes with
        // different actual image IDs. Order shuffles between API responses. Collect all
        // unique MAIN image IDs, sorted, so the set is stable across syncs.
        const mainIds = [...new Set(imgs.filter(i => i.variant === 'MAIN').map(i => idOf(i.link)).filter(Boolean))].sort();
        // Pick the largest MAIN for display (highest-resolution = original source).
        const mainSorted = imgs.filter(i => i.variant === 'MAIN').sort((a, b) => (b.height || 0) - (a.height || 0));
        const mainImage = mainSorted[0]?.link || imgs[0]?.link || null;
        const mainImageId = mainIds.length ? mainIds.join(',') : idOf(mainImage);
        // Variations: children of this parent
        const rels = (item.relationships || []).find(r => r.marketplaceId === marketplaceId)?.relationships || item.relationships?.[0]?.relationships || [];
        const varChildren = rels
          .filter(r => r.type === 'VARIATION' && Array.isArray(r.childAsins))
          .flatMap(r => r.childAsins)
          .filter(Boolean);

        const hash = crypto.createHash('sha256')
          .update(JSON.stringify({ title, bullets, mainImageId }))
          .digest('hex')
          .slice(0, 16);

        result[asin] = { title, bullets, mainImage, mainImageId, varChildren, hash };
      }
    } catch (err) {
      console.warn(`[Health] Catalog batch error: ${err.message}`);
    }
    await sleep(600); // 2 rps limit
  }
  console.log(`[Health] Catalog snapshots: ${Object.keys(result).length}/${asins.length}`);
  return result;
}

// Scrape seller display names from public Amazon seller profile pages.
// Returns { [sellerId]: { name, scrapedAt } }. Errors are caught per-seller; missing entries
// just stay un-named in the cache (caller falls back to seller ID).
async function scrapeSellerNames(sellerIds, marketplace) {
  const result = {};
  if (!sellerIds?.length) return result;
  const tld = marketplace === 'US' ? 'com' : 'ca';
  const host = `www.amazon.${tld}`;
  console.log(`[SellerScrape] Fetching ${sellerIds.length} seller names from ${host}...`);

  for (const sellerId of sellerIds) {
    try {
      const html = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: host,
          path: `/sp?seller=${encodeURIComponent(sellerId)}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-CA,en;q=0.9',
          }
        }, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => resolve(body));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('timeout')));
        req.end();
      });

      // Try several patterns — Amazon's profile page changes layout occasionally.
      let name = null;
      const h1 = html.match(/<h1[^>]*id=["']seller-name["'][^>]*>\s*([^<]+?)\s*<\/h1>/i);
      if (h1) name = h1[1];
      if (!name) {
        const t = html.match(/<title>\s*(?:Amazon\.[a-z.]+\s*Seller Profile:\s*)?([^<]+?)\s*(?:\s*[-:]\s*Amazon)?<\/title>/i);
        if (t) name = t[1];
      }
      if (!name) {
        // Some pages use a meta tag
        const meta = html.match(/<meta[^>]+name=["']title["'][^>]+content=["'](?:Amazon\.[a-z.]+\s*Seller Profile:\s*)?([^"']+?)["']/i);
        if (meta) name = meta[1];
      }
      // Sanitize: trim, collapse whitespace, drop trailing colons/separators
      if (name) {
        name = name.replace(/\s+/g, ' ').trim();
        if (/^amazon\b/i.test(name)) name = null; // generic "Amazon.ca" page = scrape failed
      }

      if (name) {
        result[sellerId] = { name, scrapedAt: new Date().toISOString(), marketplace };
        console.log(`[SellerScrape] ${sellerId} → ${name}`);
      } else {
        console.warn(`[SellerScrape] ${sellerId}: no name found in HTML`);
      }
    } catch (err) {
      console.warn(`[SellerScrape] ${sellerId} error: ${err.message}`);
    }
    await sleep(2000); // throttle — be polite + avoid bot detection
  }
  return result;
}

// Run the listing-health enrichment pass. Compares current snapshots to stored ones
// on each brand and emits change events. Returns the updated brands (caller persists).
//
// Mutates `brand.buyBoxOwners`, `brand.listingSnapshots`, and `brand.recentAlerts` (FIFO,
// capped at 500 per brand).
async function enrichListingHealth(brands) {
  const token = await getAccessToken();
  const mpIds = getMarketplaceIds();

  // Group ASINs by marketplace (CA brand → A2EUQ1WTGCTBG2, US brand → ATVPDKIKX0DER)
  const CA_MP = 'A2EUQ1WTGCTBG2';
  const US_MP = 'ATVPDKIKX0DER';
  const byMp = { [CA_MP]: new Set(), [US_MP]: new Set() };

  for (const brand of brands) {
    if (brand.id === 'unknown-brand') continue;
    const mp = brand.marketplace === 'US' ? US_MP : CA_MP;
    for (const asin of brand.asins || []) byMp[mp].add(asin);
  }

  // Per-marketplace fetches
  const buyBox = {};
  const catalog = {};
  for (const mp of [CA_MP, US_MP]) {
    if (!mpIds.includes(mp)) continue;
    const asins = [...byMp[mp]];
    if (!asins.length) continue;
    const [bb, cat] = await Promise.all([
      getBuyBoxOwners(asins, mp, token),
      getCatalogSnapshots(asins, mp, token),
    ]);
    Object.assign(buyBox, bb);
    Object.assign(catalog, cat);
  }

  // Fetch stranded inventory once for all marketplaces
  let strandedByAsin = {};
  try {
    strandedByAsin = await fetchStrandedInventory();
    console.log(`[Health] Stranded inventory: ${Object.keys(strandedByAsin).length} ASINs across all marketplaces`);
  } catch (err) {
    console.warn('[Health] Stranded inventory fetch failed (non-fatal):', err.message);
  }

  const now = new Date().toISOString();

  for (const brand of brands) {
    if (brand.id === 'unknown-brand') continue;
    brand.buyBoxOwners     = brand.buyBoxOwners     || {};
    brand.listingSnapshots = brand.listingSnapshots || {};
    brand.recentAlerts     = brand.recentAlerts     || [];
    brand.strandedInventory = brand.strandedInventory || {};

    brand.buyBoxOwnerHistory = brand.buyBoxOwnerHistory || {};

    for (const asin of brand.asins || []) {
      // ── Buy box owner update ────────────────────────────────────────────────
      if (buyBox[asin]) {
        brand.buyBoxOwners[asin] = { ...buyBox[asin], capturedAt: now };

        // Append to history (keep last 30 days; cap 50 entries per ASIN as safety)
        const hist = brand.buyBoxOwnerHistory[asin] = brand.buyBoxOwnerHistory[asin] || [];
        hist.push({
          sellerId: buyBox[asin].sellerId,
          sellerName: buyBox[asin].sellerName,
          isFba: buyBox[asin].isFba,
          price: buyBox[asin].price,
          capturedAt: now,
        });
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        brand.buyBoxOwnerHistory[asin] = hist
          .filter(h => new Date(h.capturedAt).getTime() > cutoff)
          .slice(-50);
      }

      // ── Catalog snapshot + change detection ─────────────────────────────────
      const cur = catalog[asin];
      if (!cur) continue;
      const prev = brand.listingSnapshots[asin];

      if (prev && prev.hash && prev.hash !== cur.hash) {
        const diff = [];
        if (prev.title !== cur.title) diff.push('title');
        const oldBullets = JSON.stringify(prev.bullets || []);
        const newBullets = JSON.stringify(cur.bullets || []);
        if (oldBullets !== newBullets) diff.push('bullets');
        // Only flag image changes when both snapshots have stable image IDs. Old snapshots
        // pre-dating the mainImageId field will silently re-baseline without alerting —
        // avoids a flood of false positives during migration.
        if (prev.mainImageId && cur.mainImageId && prev.mainImageId !== cur.mainImageId) {
          diff.push('main image');
        }
        if (diff.length > 0) {
          brand.recentAlerts.push({
            asin, severity: 'critical', type: 'content_changed',
            message: `Listing content changed (${diff.join(', ')})`,
            detail: { from: { title: prev.title }, to: { title: cur.title }, fields: diff },
            detectedAt: now,
          });
        }
      }

      // ── Variation tracking ──────────────────────────────────────────────────
      const prevKids = prev?.varChildren || [];
      const curKids  = cur.varChildren    || [];
      if (prevKids.length > 0 && curKids.length < prevKids.length) {
        const lost = prevKids.filter(c => !curKids.includes(c));
        brand.recentAlerts.push({
          asin, severity: 'critical', type: 'variation_broken',
          message: `Variation children dropped from ${prevKids.length} to ${curKids.length}` + (lost.length ? ` (lost: ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? '…' : ''})` : ''),
          detail: { prevCount: prevKids.length, curCount: curKids.length, lost },
          detectedAt: now,
        });
      }

      // ── General "no offers" check — listing is restricted on marketplace ────
      const offerCount = buyBox[asin]?.offerCount;
      if (offerCount === 0) {
        // Only alert once per state-change: previously had offers, now zero
        const prevCount = brand.buyBoxOwners[asin]?.offerCount;
        if (prevCount == null || prevCount > 0) {
          brand.recentAlerts.push({
            asin, severity: 'critical', type: 'general_inactive',
            message: `Listing has zero offers — restricted or delisted on marketplace`,
            detail: { offerCount: 0 },
            detectedAt: now,
          });
        }
      }

      brand.listingSnapshots[asin] = { ...cur, capturedAt: now };
    }

    // ── Stranded inventory — store snapshot per ASIN for this brand ─────────
    brand.strandedInventory = {};
    for (const asin of brand.asins || []) {
      const s = strandedByAsin[asin];
      if (s) brand.strandedInventory[asin] = s;
    }

    // Cap recentAlerts per brand at 500 (FIFO)
    if (brand.recentAlerts.length > 500) {
      brand.recentAlerts = brand.recentAlerts.slice(-500);
    }
  }

  return brands;
}

// Fetches Amazon's stranded inventory report for all active marketplaces.
// Returns { [asin]: { qty, reason, marketplace } } — ASIN-keyed, CA wins over US on collision.
async function fetchStrandedInventory() {
  const token = await getAccessToken();
  const mpIds = getMarketplaceIds();
  const result = {};

  for (const mpId of mpIds) {
    try {
      console.log(`[Stranded] Requesting stranded inventory report for ${mpId}…`);
      const reportId = await createReport('GET_STRANDED_INVENTORY_UI_DATA', [mpId], null, null, token);
      const docId = await waitForReport(reportId, token, 300000); // 5 min max
      const raw = await downloadReport(docId, token);

      // TSV: sku, fnsku, asin, product-name, condition, stranded-quantity, stranded-reason, ...
      const lines = raw.split('\n');
      if (lines.length < 2) continue;
      const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
      const col = h => headers.indexOf(h);

      const asinCol    = col('asin');
      const qtyCol     = col('stranded-quantity');
      const reasonCol  = col('stranded-reason');
      const mpCode     = mpId === 'ATVPDKIKX0DER' ? 'US' : 'CA';

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length < 3) continue;
        const asin = (parts[asinCol] || '').trim().toUpperCase();
        const qty  = parseInt(parts[qtyCol] || '0', 10);
        const reason = (parts[reasonCol] || '').trim();
        if (!asin || qty <= 0) continue;
        // CA wins on collision (primary marketplace)
        if (!result[asin] || mpCode === 'CA') {
          result[asin] = { qty, reason, marketplace: mpCode };
        }
      }
      console.log(`[Stranded] ${mpCode}: ${Object.values(result).filter(v => v.marketplace === mpCode).length} stranded ASINs`);
    } catch (err) {
      console.warn(`[Stranded] Failed for ${mpId}:`, err.message);
    }
    await sleep(2000);
  }

  return result;
}

async function fetchSnsSubscriptions(marketplaceIds, token) {
  const asinSubs = {};
  for (const mpId of marketplaceIds) {
    try {
      console.log(`[S&S] Requesting subscriber report for ${mpId}...`);
      const reportId = await createReport('GET_FBA_FULFILLMENT_SNSGMC_DATA', [mpId], null, null, token);
      const docId    = await waitForReport(reportId, token, 300000);
      const raw      = await downloadReport(docId, token);

      const lines   = raw.split('\n');
      if (lines.length < 2) continue;
      const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());

      const asinCol = headers.indexOf('asin');
      const subsCol = ['subscriber-download-count', 'subscribers', 'current-subscribers',
                       'subscriptions', 'active-subscribers', 'subscriber-count']
        .map(n => headers.indexOf(n)).find(i => i >= 0) ?? -1;

      if (asinCol < 0 || subsCol < 0) {
        console.warn(`[S&S] Unrecognised columns (asin:${asinCol}, subs:${subsCol}). Available: ${headers.join(', ')}`);
        continue;
      }

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split('\t');
        if (parts.length < 3) continue;
        const asin  = (parts[asinCol] || '').trim().toUpperCase();
        const count = parseInt(parts[subsCol] || '0', 10);
        if (!asin || isNaN(count) || count <= 0) continue;
        asinSubs[asin] = (asinSubs[asin] || 0) + count;
      }
      console.log(`[S&S] ${mpId}: ${Object.keys(asinSubs).length} ASINs with active subscribers`);
    } catch (e) {
      console.log(`[S&S] Report unavailable for ${mpId}: ${e.message}`);
    }
    await sleep(2000);
  }
  return asinSubs;
}

async function fetchActivePromotions(marketplaceIds, token) {
  const asinPromos = {};
  const now = Date.now();
  const TYPES = [['COUPON', 'COUPON'], ['PRIME_EXCLUSIVE_DISCOUNT', 'PED']];

  for (const mpId of marketplaceIds) {
    for (const [apiType, badge] of TYPES) {
      try {
        const data = await spRequest('GET', `/promotions/v2021-06-01/promotions?marketplaceId=${mpId}&promotionType=${apiType}`, token);
        const active = (data.promotions || []).filter(p => !p.endDate || new Date(p.endDate) > now);
        console.log(`[Promos] ${badge} ${mpId}: ${active.length} active`);
        for (const promo of active) {
          try {
            const detail = await spRequest('GET', `/promotions/v2021-06-01/promotions/${promo.promotionId}`, token);
            for (const cond of detail.promotion?.promotionApplicabilityModel?.promotionConditions || []) {
              for (const asin of cond.applicableProductCondition?.includedEntitlements?.asinList || []) {
                if (!asinPromos[asin]) asinPromos[asin] = new Set();
                asinPromos[asin].add(badge);
              }
            }
            await sleep(300);
          } catch {}
        }
      } catch (e) {
        console.log(`[Promos] ${apiType} unavailable for ${mpId}: ${e.message}`);
      }
    }
  }

  return Object.fromEntries(Object.entries(asinPromos).map(([k, v]) => [k, [...v]]));
}

// Fetch the seller's listing prices for up to 20 ASINs at once via the SP-API
// Product Pricing endpoint. Returns { [asin]: { amount, currency } } — keyed
// by ASIN, only entries with a real MyPrice are included.
// Used to estimate revenue for Pending orders whose ItemPrice is $0 in the
// Orders API response.
async function fetchListingPrices(asins, mpId, token) {
  if (!asins || asins.length === 0) return {};
  token = token || await getAccessToken();
  const out = {};
  const CHUNK = 20;
  for (let i = 0; i < asins.length; i += CHUNK) {
    const chunk = asins.slice(i, i + CHUNK);
    const qs = new URLSearchParams({
      MarketplaceId: mpId,
      ItemType: 'Asin',
    });
    for (const a of chunk) qs.append('Asins', a);
    const path = `/products/pricing/v0/price?${qs.toString()}`;
    try {
      const res = await spRequest('GET', path, token, null, 30000);
      if (res.status === 429) { await sleep(2000); i -= CHUNK; continue; }
      if (res.status !== 200) { console.warn(`[Pricing] HTTP ${res.status}: ${JSON.stringify(res.body || {}).slice(0, 200)}`); continue; }
      for (const item of (res.body?.payload || [])) {
        const asin = item.ASIN;
        const offer = item.Product?.Offers?.[0];
        const price = offer?.BuyingPrice?.ListingPrice || offer?.BuyingPrice?.LandedPrice;
        if (asin && price && price.Amount > 0) {
          out[asin] = { amount: Number(price.Amount), currency: price.CurrencyCode };
        }
      }
      await sleep(500); // 2 req/sec
    } catch (e) {
      console.warn(`[Pricing] batch failed: ${e.message}`);
    }
  }
  return out;
}

module.exports = { syncBrandMetrics, importBrandsFromAmazon, fetchUpcsForAsins, fetchFinancialEvents, enrichListingHealth, scrapeSellerNames, fetchStrandedInventory, getAccessToken, spRequest, getMarketplaceIds, MARKETPLACE_CODE, sleep, createReport, waitForReport, downloadReport, fetchListingPrices };
