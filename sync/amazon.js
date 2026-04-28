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

  for (let attempt = 1; attempt <= 8; attempt++) {
    const currentToken = await getAccessToken();
    const res = await spRequest('POST', '/reports/2021-06-30/reports', currentToken, body);
    if (res.status === 202) return res.body.reportId;
    const errCode = res.body?.errors?.[0]?.code;
    const isQuota = errCode === 'QuotaExceeded' || res.status === 429;
    const isTransient = errCode === 'InternalFailure' || (res.status >= 500 && res.status !== 501);
    if (attempt < 8 && (isQuota || isTransient)) {
      const wait = isQuota ? attempt * 2 * 60000 : Math.min(attempt * 15000, 60000); // quota: 2-14m, transient: 15-60s
      const label = isQuota ? `${attempt * 2}m` : `${Math.round(wait / 1000)}s`;
      console.warn(`[Reports] ${errCode} for ${reportType} — retrying in ${label} (attempt ${attempt}/8)`);
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
      unfulfillable: existing.unfulfillable + (d.unfulfillableQuantity?.totalUnfulfillableQuantity || 0)
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
    last30d:   r(d30,            y,            'Last 30 Days'),
    thisMonth: r(thisMonthStart, y,            'This Month'),
    lastMonth: r(lastMonthStart, lastMonthEnd, 'Last Month')
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
        stData[asin] = { revenueCad: 0, revenueUsd: 0, units: 0, sessions: 0, pageViews: 0, buyBoxSamples: [], cvrSamples: [] };
      }
      if (currency === 'CAD') stData[asin].revenueCad += d.revenue;
      else stData[asin].revenueUsd += d.revenue;
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
        sessions: st.sessions || 0,
        pageViews: st.pageViews || 0,
        buyBox: st.buyBox ?? null,
        cvr: st.cvr ?? null,
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

module.exports = { syncBrandMetrics, importBrandsFromAmazon, fetchUpcsForAsins, fetchFinancialEvents };
