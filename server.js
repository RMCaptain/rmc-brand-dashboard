require('dotenv').config();
if (process.stdout._handle) process.stdout._handle.setBlocking(true);
if (process.stderr._handle) process.stderr._handle.setBlocking(true);
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const ordersPoller = require('./sync/orders');
const { pstDateStr, pstSubtractDays } = require('./sync/dateUtils');
const { loadAllImages, setImageManual, backfillMissingImages, migrateLegacyImages } = require('./sync/images');

// In-memory image map, refreshed from Supabase. Used by /api/metrics responses
// to attach imageUrl to every SKU without a per-request DB roundtrip.
let imagesByAsin = {};
let imagesLastLoaded = 0;
async function refreshImagesCache() {
  try {
    const fresh = await loadAllImages(supabase);
    imagesByAsin = Object.fromEntries(Object.entries(fresh).map(([asin, v]) => [asin, v.url]));
    imagesLastLoaded = Date.now();
    console.log(`[Images] In-memory cache refreshed: ${Object.keys(imagesByAsin).length} ASINs`);
  } catch (e) {
    console.warn('[Images] Cache refresh failed (keeping old cache):', e.message);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Supabase client (service role — server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory sync state (resets on redeploy, which is fine)
let syncState = { status: 'idle', lastSync: null, error: null };

app.use(cors());

// HTTP Basic Auth — gates the entire dashboard. Skipped if AUTH_USERNAME / AUTH_PASSWORD
// are unset (local dev). Temporary measure until Cloudflare Access (internal team) and
// Supabase Auth (external brand portal) replace it.
function basicAuth(req, res, next) {
  const expectedUser = process.env.AUTH_USERNAME;
  const expectedPass = process.env.AUTH_PASSWORD;
  if (!expectedUser || !expectedPass) return next();

  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="RMC Dashboard"');
    return res.status(401).send('Authentication required');
  }

  let user = '', pass = '';
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const idx = decoded.indexOf(':');
    user = decoded.slice(0, idx);
    pass = decoded.slice(idx + 1);
  } catch {}

  const crypto = require('crypto');
  const a = Buffer.from(user);
  const b = Buffer.from(expectedUser);
  const c = Buffer.from(pass);
  const d = Buffer.from(expectedPass);
  const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passOk = c.length === d.length && crypto.timingSafeEqual(c, d);

  if (!userOk || !passOk) {
    res.setHeader('WWW-Authenticate', 'Basic realm="RMC Dashboard"');
    return res.status(401).send('Invalid credentials');
  }
  next();
}
app.use(basicAuth);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Data helpers (Supabase) ---

async function loadBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('data')
    .eq('id', 'main')
    .single();
  if (error || !data?.data?.brands) return { brands: [] };
  return data.data;
}

async function saveBrands(payload) {
  await supabase
    .from('brands')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .eq('id', 'main');
}

async function loadPresetMetrics() {
  const { data, error } = await supabase
    .from('preset_metrics')
    .select('data')
    .eq('id', 'main')
    .single();
  if (error || !data?.data) return { lastSync: null, presets: {} };
  return data.data;
}

async function savePresetMetrics(payload) {
  await supabase
    .from('preset_metrics')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .eq('id', 'main');
}

// Reload the latest brands from Supabase and merge only what the sync produced.
// This prevents a long-running sync from overwriting user changes made during it.
async function saveSyncResults(syncBrands) {
  const fresh = await loadBrands();

  const syncById = {};
  for (const b of syncBrands) syncById[b.id] = b;

  // Merge asinTitles and upcs into the fresh brands (add-only, never overwrite)
  for (const fb of fresh.brands) {
    const sb = syncById[fb.id];
    if (!sb) continue;
    fb.asinTitles = fb.asinTitles || {};
    fb.upcs = fb.upcs || {};
    for (const asin of fb.asins) {
      if (sb.asinTitles?.[asin] && !fb.asinTitles[asin]) fb.asinTitles[asin] = sb.asinTitles[asin];
      if (asin in (sb.upcs || {}) && !(asin in fb.upcs)) fb.upcs[asin] = sb.upcs[asin];
    }
    if (sb.asinPromos) fb.asinPromos = sb.asinPromos;
    if (sb.asinSns)   fb.asinSns   = sb.asinSns;
  }

  // Merge unknown-brand: only add ASINs not already tracked anywhere in fresh data
  const syncUnknown = syncById['unknown-brand'];
  if (syncUnknown?.asins?.length) {
    const allFreshAsins = new Set(fresh.brands.filter(b => b.id !== 'unknown-brand').flatMap(b => b.asins));
    let freshUnknown = fresh.brands.find(b => b.id === 'unknown-brand');
    if (!freshUnknown) {
      freshUnknown = { id: 'unknown-brand', name: 'Unknown Brand', marketplace: 'CA', color: '#f59e0b', asins: [], asinTitles: {}, createdAt: new Date().toISOString().split('T')[0] };
      fresh.brands.push(freshUnknown);
    }
    freshUnknown.asinTitles = freshUnknown.asinTitles || {};
    for (const asin of syncUnknown.asins) {
      if (!allFreshAsins.has(asin) && !freshUnknown.asins.includes(asin)) {
        freshUnknown.asins.push(asin);
        if (syncUnknown.asinTitles?.[asin]) freshUnknown.asinTitles[asin] = syncUnknown.asinTitles[asin];
      }
    }
  }

  await saveBrands(fresh);
  return fresh;
}

// --- FX (still file-cached locally — avoids hammering external API) ---

function loadFx() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fx.json'), 'utf8'));
    if (data.fetched && (Date.now() - new Date(data.fetched)) < 24 * 60 * 60 * 1000) return data;
  } catch {}
  return null;
}

function saveFx(data) {
  try { fs.writeFileSync(path.join(DATA_DIR, 'fx.json'), JSON.stringify(data, null, 2)); } catch {}
}

// Enrich a completed day's daily_metrics rows with S&T TRAFFIC only —
// sessions, page views, buy box, inventory snapshot. Called after each sync
// for "yesterday".
//
// AUTHORITY MODEL: the Orders API is the single source of truth for units &
// revenue (it matches Sellerboard). S&T lags 24-48h and counts differently, so
// this writer must NEVER touch units/revenue columns — it only upserts traffic
// columns. On conflict, Supabase updates only the provided columns, leaving the
// orders-sourced units/revenue intact.
async function writeDailyMetrics(yesterdayBrands, date) {
  if (!yesterdayBrands || !date) return;

  const rows = [];
  for (const [brandId, brandData] of Object.entries(yesterdayBrands)) {
    for (const sku of (brandData.skus || [])) {
      const hasTraffic =
        sku.sessions != null || sku.pageViews != null || sku.buyBox != null ||
        sku.inventory?.onHand != null;
      if (!hasTraffic) continue;
      rows.push({
        asin:              sku.asin,
        date,
        brand_id:          brandId,
        sessions:          sku.sessions         ?? null,
        page_views:        sku.pageViews        ?? null,
        buy_box_pct:       sku.buyBox           ?? null,
        inventory_on_hand: sku.inventory?.onHand  ?? null,
        inventory_inbound: sku.inventory?.inbound ?? null,
      });
    }
  }
  if (rows.length === 0) return;
  const { error } = await supabase.from('daily_metrics').upsert(rows, { onConflict: 'asin,date' });
  if (error) console.warn('[DailyMetrics] Traffic write error:', error.message);
  else console.log(`[DailyMetrics] Wrote traffic for ${rows.length} rows on ${date} (units/revenue owned by Orders API)`);
}

async function fetchFxRate() {
  const cached = loadFx();
  if (cached) return cached;
  return new Promise(resolve => {
    const https = require('https');
    https.get('https://open.er-api.com/v6/latest/USD', res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          const usdToCad = json.rates?.CAD || 1.38;
          const result = { usdToCad, cadToUsd: Math.round(1 / usdToCad * 10000) / 10000, fetched: new Date().toISOString() };
          saveFx(result);
          resolve(result);
        } catch { resolve({ usdToCad: 1.38, cadToUsd: 0.724, fetched: new Date().toISOString() }); }
      });
    }).on('error', () => resolve({ usdToCad: 1.38, cadToUsd: 0.724, fetched: new Date().toISOString() }));
  });
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// HTML-escape for safe interpolation into PDF template literals
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Prevent Excel/CSV formula injection — prefix risky leading chars with '
function safeExcelString(s) {
  if (s == null) return '';
  const str = String(s);
  if (/^[=+\-@\t\r]/.test(str)) return "'" + str;
  return str;
}

const BRAND_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7'
];

// --- Brand Routes ---

app.get('/api/brands', async (req, res) => {
  const { brands } = await loadBrands();
  const pm = await loadPresetMetrics();
  const presetKey = req.query.preset || 'last7d';
  const presetData = pm.presets?.[presetKey]?.brands || {};
  const result = brands.map(b => ({ ...b, metrics: presetData[b.id] || null }));
  const presetMeta = Object.fromEntries(
    Object.entries(pm.presets || {}).map(([k, v]) => [k, { label: v.label, startDate: v.startDate, endDate: v.endDate }])
  );
  res.json({ brands: result, lastSync: pm.lastSync, presets: presetMeta });
});

app.get('/api/brands/:id', async (req, res) => {
  const { brands } = await loadBrands();
  const pm = await loadPresetMetrics();
  const presetKey = req.query.preset || 'last7d';
  const presetData = pm.presets?.[presetKey]?.brands || {};
  const brand = brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const presetMeta = Object.fromEntries(
    Object.entries(pm.presets || {}).map(([k, v]) => [k, { label: v.label, startDate: v.startDate, endDate: v.endDate }])
  );

  // Inbound inventory snapshot per ASIN — most recent non-null
  // inventory_inbound value from daily_metrics. Used by the PO Builder so
  // auto-suggested quantities subtract what's already on the way to Amazon
  // (don't over-order what we already have in transit).
  const inboundByAsin = {};
  if (brand.asins?.length) {
    const todayPst = pstDateStr();
    const since = pstSubtractDays(todayPst, 14); // most recent 2 weeks is enough
    const { data: invRows } = await supabase
      .from('daily_metrics')
      .select('asin,inventory_inbound,date')
      .in('asin', brand.asins)
      .gte('date', since)
      .order('date', { ascending: false });
    for (const r of (invRows || [])) {
      if (r.inventory_inbound == null) continue;
      // First (newest) non-null per ASIN wins; subsequent rows ignored
      if (inboundByAsin[r.asin] == null) inboundByAsin[r.asin] = r.inventory_inbound;
    }
  }

  res.json({
    ...brand,
    metrics: presetData[brand.id] || null,
    lastSync: pm.lastSync,
    presets: presetMeta,
    inboundByAsin,
  });
});

app.post('/api/brands', async (req, res) => {
  const { name, marketplace } = req.body;
  if (!name) return res.status(400).json({ error: 'Brand name is required' });

  const data = await loadBrands();
  const id = slugify(name);

  if (data.brands.find(b => b.id === id)) {
    return res.status(409).json({ error: 'A brand with that name already exists' });
  }

  const color = BRAND_COLORS[data.brands.length % BRAND_COLORS.length];
  const newBrand = {
    id, name,
    marketplace: marketplace || 'CA',
    color, asins: [],
    createdAt: new Date().toISOString().split('T')[0]
  };

  data.brands.push(newBrand);
  await saveBrands(data);
  res.json(newBrand);
});

app.put('/api/brands/:id', async (req, res) => {
  const data = await loadBrands();
  const idx = data.brands.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  const { name, marketplace, color } = req.body;
  if (name) data.brands[idx].name = name;
  if (marketplace) data.brands[idx].marketplace = marketplace;
  if (color) data.brands[idx].color = color;

  await saveBrands(data);
  res.json(data.brands[idx]);
});

app.delete('/api/brands/:id', async (req, res) => {
  const data = await loadBrands();
  data.brands = data.brands.filter(b => b.id !== req.params.id);
  await saveBrands(data);
  res.json({ success: true });
});

app.post('/api/brands/:id/asins', async (req, res) => {
  const { asin } = req.body;
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ASIN format (must be 10 alphanumeric characters)' });
  }

  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  const normalized = asin.trim().toUpperCase();
  const conflict = data.brands.find(b => b.id !== req.params.id && b.asins.includes(normalized));
  if (conflict) {
    return res.status(409).json({ error: `ASIN already assigned to "${conflict.name}"` });
  }

  if (!brand.asins.includes(normalized)) {
    brand.asins.push(normalized);
    await saveBrands(data);
  }

  res.json(brand);
});

app.put('/api/brands/:id/asins/:asin/move', async (req, res) => {
  const { toBrandId } = req.body;
  if (!toBrandId) return res.status(400).json({ error: 'toBrandId required' });

  const data = await loadBrands();
  const fromBrand = data.brands.find(b => b.id === req.params.id);
  const toBrand = data.brands.find(b => b.id === toBrandId);

  if (!fromBrand) return res.status(404).json({ error: 'Source brand not found' });
  if (!toBrand) return res.status(404).json({ error: 'Destination brand not found' });

  const asin = req.params.asin.toUpperCase();
  fromBrand.asins = fromBrand.asins.filter(a => a !== asin);
  if (!toBrand.asins.includes(asin)) toBrand.asins.push(asin);

  await saveBrands(data);
  res.json({ success: true, from: fromBrand, to: toBrand });
});

app.post('/api/brands/:id/asins/bulk-move', async (req, res) => {
  const { asins, toBrandId } = req.body;
  if (!Array.isArray(asins) || !toBrandId) return res.status(400).json({ error: 'Invalid payload' });

  const data = await loadBrands();
  const fromBrand = data.brands.find(b => b.id === req.params.id);
  const toBrand = data.brands.find(b => b.id === toBrandId);

  if (!fromBrand) return res.status(404).json({ error: 'Source brand not found' });
  if (!toBrand) return res.status(404).json({ error: 'Destination brand not found' });

  for (const asin of asins) {
    const upper = asin.toUpperCase();
    fromBrand.asins = fromBrand.asins.filter(a => a !== upper);
    if (!toBrand.asins.includes(upper)) toBrand.asins.push(upper);
    if (fromBrand.asinTitles?.[upper]) {
      toBrand.asinTitles = toBrand.asinTitles || {};
      toBrand.asinTitles[upper] = fromBrand.asinTitles[upper];
      delete fromBrand.asinTitles[upper];
    }
  }

  await saveBrands(data);
  res.json({ success: true, from: fromBrand, to: toBrand });
});

app.delete('/api/brands/:id/asins/:asin', async (req, res) => {
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  brand.asins = brand.asins.filter(a => a !== req.params.asin.toUpperCase());
  await saveBrands(data);
  res.json(brand);
});

// PUT set per-marketplace COGS for an ASIN
app.put('/api/brands/:id/asins/:asin/cogs-marketplace', async (req, res) => {
  const { marketplace, cost } = req.body;
  if (!marketplace || cost == null || isNaN(cost) || cost < 0) return res.status(400).json({ error: 'Invalid input' });

  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  brand.cogsPerMarketplace = brand.cogsPerMarketplace || {};
  const asin = req.params.asin.toUpperCase();
  brand.cogsPerMarketplace[asin] = brand.cogsPerMarketplace[asin] || {};
  brand.cogsPerMarketplace[asin][marketplace] = Number(cost);
  await saveBrands(data);
  res.json({ success: true });
});

// PUT set COGS (cost per unit) for an ASIN
app.put('/api/brands/:id/asins/:asin/cogs', async (req, res) => {
  const { cost } = req.body;
  if (cost == null || isNaN(cost) || cost < 0) return res.status(400).json({ error: 'Invalid cost value' });

  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  brand.cogs = brand.cogs || {};
  brand.cogs[req.params.asin.toUpperCase()] = Number(cost);
  await saveBrands(data);
  res.json({ success: true });
});

// PUT set buy cost (supplier invoice price) for an ASIN
app.put('/api/brands/:id/asins/:asin/buy-cost', async (req, res) => {
  const { cost } = req.body;
  if (cost == null || isNaN(cost) || cost < 0) return res.status(400).json({ error: 'Invalid cost value' });
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.buyCost = brand.buyCost || {};
  brand.buyCost[req.params.asin.toUpperCase()] = Number(cost);
  await saveBrands(data);
  res.json({ success: true });
});

// PUT set lead time for an ASIN
app.put('/api/brands/:id/asins/:asin/leadtime', async (req, res) => {
  const { days } = req.body;
  if (days == null || isNaN(days) || days < 0) return res.status(400).json({ error: 'Invalid days value' });

  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  brand.leadTimes = brand.leadTimes || {};
  brand.leadTimes[req.params.asin.toUpperCase()] = Number(days);
  await saveBrands(data);
  res.json({ success: true });
});

// PUT set UPC for an ASIN
app.put('/api/brands/:id/asins/:asin/upc', async (req, res) => {
  const { upc } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.upcs = brand.upcs || {};
  brand.upcs[req.params.asin.toUpperCase()] = (upc || '').trim();
  await saveBrands(data);
  res.json({ success: true });
});

// PUT set case pack size for an ASIN
app.put('/api/brands/:id/asins/:asin/casepack', async (req, res) => {
  const { size } = req.body;
  if (size == null || isNaN(size) || size < 1) return res.status(400).json({ error: 'Invalid case pack size' });
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.casePacks = brand.casePacks || {};
  brand.casePacks[req.params.asin.toUpperCase()] = Number(size);
  await saveBrands(data);
  res.json({ success: true });
});

// POST scrape UPCs for all ASINs in a brand (or all brands if no id)
app.post('/api/brands/:id/scrape-upcs', async (req, res) => {
  try {
    const { fetchUpcsForAsins } = require('./sync/amazon');
    const data = await loadBrands();
    const brand = data.brands.find(b => b.id === req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Only scrape ASINs not yet checked (key absence = never checked; "" = checked, not found)
    brand.upcs = brand.upcs || {};
    const missing = brand.asins.filter(a => !(a in brand.upcs));
    if (missing.length === 0) return res.json({ updated: 0, message: 'All ASINs already checked' });

    const upcMap = await fetchUpcsForAsins(missing);
    let updated = 0;
    for (const asin of missing) {
      const upc = upcMap[asin];
      brand.upcs[asin] = upc || '';  // mark as checked even if not found
      if (upc) updated++;
    }
    await saveBrands(data);
    res.json({ updated, total: missing.length });
  } catch (err) {
    console.error('[scrape-upcs]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST scrape UPCs for ALL brands
app.post('/api/scrape-upcs', async (req, res) => {
  try {
    const { fetchUpcsForAsins } = require('./sync/amazon');
    const data = await loadBrands();

    // Scrape any ASIN with no UPC yet (missing key OR empty string from a previous failed attempt)
    const toScrape = [];
    for (const brand of data.brands) {
      brand.upcs = brand.upcs || {};
      for (const asin of brand.asins) {
        if (!brand.upcs[asin]) toScrape.push(asin);
      }
    }

    if (toScrape.length === 0) return res.json({ updated: 0, message: 'All ASINs have UPCs already' });

    const uniqueAsins = [...new Set(toScrape)];
    const upcMap = await fetchUpcsForAsins(uniqueAsins);

    let updated = 0;
    for (const brand of data.brands) {
      for (const asin of brand.asins) {
        if (!brand.upcs[asin]) {
          brand.upcs[asin] = upcMap[asin] || '';
          if (upcMap[asin]) updated++;
        }
      }
    }
    await saveBrands(data);
    res.json({ updated, total: uniqueAsins.length });
  } catch (err) {
    console.error('[scrape-upcs-all]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT set ASIN config (type: single | multipack | bundle)
app.put('/api/brands/:id/asins/:asin/config', async (req, res) => {
  const { type, unitsPerPack, baseProductAsin, components } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.asinConfig = brand.asinConfig || {};
  brand.asinConfig[req.params.asin.toUpperCase()] = {
    type: type || 'single',
    unitsPerPack: unitsPerPack ? Number(unitsPerPack) : null,
    baseProductAsin: baseProductAsin || null,
    components: components || []
  };
  await saveBrands(data);
  res.json({ success: true });
});

// PUT supplier name for an ASIN
app.put('/api/brands/:id/asins/:asin/suppliername', async (req, res) => {
  const { supplierName } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.asinConfig = brand.asinConfig || {};
  const asin = req.params.asin.toUpperCase();
  brand.asinConfig[asin] = brand.asinConfig[asin] || {};
  brand.asinConfig[asin].supplierName = supplierName || '';
  await saveBrands(data);
  res.json({ success: true });
});

// PUT stock number for an ASIN
app.put('/api/brands/:id/asins/:asin/stocknumber', async (req, res) => {
  const { stockNumber } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.asinConfig = brand.asinConfig || {};
  const asin = req.params.asin.toUpperCase();
  brand.asinConfig[asin] = brand.asinConfig[asin] || {};
  brand.asinConfig[asin].stockNumber = stockNumber || '';
  await saveBrands(data);
  res.json({ success: true });
});

// PUT vendor info for a brand
app.put('/api/brands/:id/vendor', async (req, res) => {
  const { name, address, city, phone } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.vendor = { name: name || '', address: address || '', city: city || '', phone: phone || '' };
  await saveBrands(data);
  res.json({ success: true });
});

// PUT reorder buffer days for a brand
app.put('/api/brands/:id/reorder-buffer', async (req, res) => {
  const { days } = req.body;
  if (days == null || isNaN(days) || days < 0) return res.status(400).json({ error: 'Invalid days value' });
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.reorderBuffer = Number(days);
  await saveBrands(data);
  res.json({ success: true });
});

// --- PO Settings ---

async function loadPoSettings() {
  const defaults = {
    lastPoNumber: 6065,
    billTo: { name: '2207192 Alberta Ltd.', address: '3620 98 Street NW', city: 'Edmonton, Alberta T6E 6B4', phone: '780-218-7540', email: 'finance@rockymountainco.ca' },
    shipTo: { name: 'RockyMountainCo', address: '3620 98 Street NW', city: 'Edmonton, Alberta T6E 6B4', phone: '780-218-7540', email: 'niklas@rockymountainco.ca' }
  };
  const { data, error } = await supabase.from('po_settings').select('data').eq('id', 'main').maybeSingle();
  // PGRST116 = no rows; otherwise it's a real DB error and we should fail loud
  if (error) throw new Error('po_settings unavailable: ' + error.message);
  if (!data?.data) return defaults;
  return {
    ...defaults,
    ...data.data,
    billTo: { ...defaults.billTo, ...(data.data.billTo || {}) },
    shipTo: { ...defaults.shipTo, ...(data.data.shipTo || {}) },
  };
}

async function savePoSettings(payload) {
  const { error } = await supabase.from('po_settings').upsert({ id: 'main', data: payload, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// ─── Seller Names Cache ────────────────────────────────────────────────────────
// Caches seller IDs → display names so the digest can render "Won by QuickShip" instead
// of "Won by A1LKQ3UQVG7Q72". Populated by scraping Amazon seller profile pages
// (SP-API doesn't return seller display names).
async function loadSellerNames() {
  const { data, error } = await supabase.from('po_settings').select('data').eq('id', 'seller_names').maybeSingle();
  if (error) {
    console.warn('[SellerNames] load error:', error.message);
    return {};
  }
  return data?.data || {};
}

async function saveSellerNames(map) {
  const { error } = await supabase.from('po_settings').upsert({ id: 'seller_names', data: map, updated_at: new Date().toISOString() });
  if (error) throw error;
}

// Brands to exclude from the health digest entirely (still tracked elsewhere in dashboard,
// just not noisy in the daily Slack ping).
const DIGEST_EXCLUDE_BRANDS = new Set(['unknown-brand', 'general-wholesale']);

// Atomic optimistic update of lastPoNumber. Returns true on success, false on conflict
// (someone else changed lastPoNumber between our read and write). The single UPDATE with
// a WHERE on the current value is atomic at the DB level — no two callers can both succeed.
async function tryCommitLastPoNumber(expectedCurrent, newValue) {
  const current = await loadPoSettings();
  const newSettings = { ...current, lastPoNumber: newValue };
  const { data, error } = await supabase
    .from('po_settings')
    .update({ data: newSettings, updated_at: new Date().toISOString() })
    .eq('id', 'main')
    .eq('data->>lastPoNumber', String(expectedCurrent))
    .select();
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

app.get('/api/po/settings', async (req, res) => {
  res.json(await loadPoSettings());
});

app.put('/api/po/settings', async (req, res) => {
  // Only billTo / shipTo are editable here. lastPoNumber is managed atomically inside
  // the PO generation routes via tryCommitLastPoNumber — accepting it from a request body
  // would let any caller rewind or skip the counter.
  const settings = await loadPoSettings();
  const { billTo, shipTo } = req.body;
  if (billTo) settings.billTo = { ...settings.billTo, ...billTo };
  if (shipTo) settings.shipTo = { ...settings.shipTo, ...shipTo };
  await savePoSettings(settings);
  res.json(settings);
});

// ── Purchase Order CRUD ──────────────────────────────────────────────────────

// Caller identity for audit log. Express's HTTP Basic Auth populates req.user
// (when the auth middleware extracts it); fall back to anonymous label.
function actorFrom(req) {
  return req.user || req.headers['x-rmc-user'] || 'anonymous';
}

// Append an entry to a PO's audit_log JSONB array. Each entry: who, when, what.
// Action: 'create' | 'update' | 'soft_delete' | 'restore' | 'generate_pdf' | 'generate_xlsx' | 'force_save'.
// For 'update', diff is { changedFields: ['status', 'lines', ...] } so we can show what changed in the UI.
async function appendAuditEntry(poId, actor, action, diff = {}) {
  if (!poId) return;
  const { data: row } = await supabase
    .from('purchase_orders')
    .select('audit_log')
    .eq('id', poId)
    .maybeSingle();
  const log = Array.isArray(row?.audit_log) ? row.audit_log : [];
  log.push({ at: new Date().toISOString(), actor, action, ...diff });
  // Cap at 200 entries per PO to keep row size bounded; oldest entries trimmed first.
  const trimmed = log.length > 200 ? log.slice(-200) : log;
  await supabase.from('purchase_orders').update({ audit_log: trimmed }).eq('id', poId);
}

// Rebuild the purchase_order_lines projection for a PO from its data.lines.
// The lines table is a derived read-model for reporting; purchase_orders.data
// stays the source of truth. We delete + reinsert from the in-memory array we
// just persisted, so the projection can never drift from the blob. Strips the
// display-only _-prefixed meta fields, keeping the queryable business fields.
async function syncPoLines(poId, data) {
  if (!poId) return;
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const { error: delErr } = await supabase.from('purchase_order_lines').delete().eq('po_id', poId);
  if (delErr) throw delErr;
  if (!lines.length) return;
  const toInt = (v) => (v != null && v !== '' ? Math.round(Number(v)) : null);
  const rows = lines.map((ln, i) => ({
    po_id:        poId,
    seq:          i,
    line_type:    ln._type || 'single',
    asin:         ln.asin || null,
    description:  ln.description || null,
    upc:          ln.upc || null,
    stock_number: ln.stockNumber || null,
    unit_price:   Number(ln.price) || 0,
    quantity:     toInt(ln.quantity) || 0,
    case_pack:    toInt(ln.casePack),
    cases:        toInt(ln.cases),
  }));
  const { error: insErr } = await supabase.from('purchase_order_lines').insert(rows);
  if (insErr) throw insErr;
}

// Best-effort wrapper: the projection is secondary to the data blob, so a sync
// failure (e.g. table not yet migrated) must never fail the PO save. The
// projection self-heals on the next save or a backfill re-run.
async function syncPoLinesSafe(poId, data) {
  try { await syncPoLines(poId, data); }
  catch (err) { console.warn(`[POLines] projection sync failed for ${poId}:`, err.message); }
}

// Compare two PO records and return the list of fields that meaningfully changed.
// Used by the update handler to record what an actor edited.
function poDiff(prev, next) {
  const changed = [];
  for (const k of ['po_number', 'brand_id', 'brand_name', 'status']) {
    if ((prev?.[k] ?? null) !== (next?.[k] ?? null)) changed.push(k);
  }
  // data is a JSONB blob — compare serialized
  const prevD = JSON.stringify(prev?.data || {});
  const nextD = JSON.stringify(next?.data || {});
  if (prevD !== nextD) changed.push('data');
  return changed;
}

// All listings exclude soft-deleted rows by default. Pass ?includeDeleted=true to see them.
app.get('/api/pos', async (req, res) => {
  try {
    const includeDeleted = req.query.includeDeleted === 'true';
    let q = supabase
      .from('purchase_orders')
      .select('id, po_number, brand_id, brand_name, status, created_at, updated_at, deleted_at, deleted_by')
      .order('updated_at', { ascending: false });
    if (!includeDeleted) q = q.is('deleted_at', null);
    const { data, error } = await q;
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pos', async (req, res) => {
  try {
    const { po_number, brand_id, brand_name, status, data } = req.body;
    const poNum = po_number != null && po_number !== '' ? Number(po_number) : null;
    if (poNum != null && (!Number.isFinite(poNum) || poNum < 0)) {
      return res.status(400).json({ error: 'po_number must be a non-negative number' });
    }
    const actor = actorFrom(req);

    // Idempotency guard: if a non-deleted row with the same po_number + brand exists, update it.
    if (poNum != null && brand_id) {
      const { data: existing } = await supabase
        .from('purchase_orders')
        .select('id, po_number, brand_id, brand_name, status, data')
        .eq('po_number', poNum)
        .eq('brand_id', brand_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (existing?.id) {
        const changed = poDiff(existing, { po_number: poNum, brand_id, brand_name, status: status || 'draft', data });
        const { data: updated, error: uerr } = await supabase
          .from('purchase_orders')
          .update({ brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .select().single();
        if (uerr) throw uerr;
        await appendAuditEntry(existing.id, actor, 'update', { changedFields: changed });
        await syncPoLinesSafe(existing.id, data);
        return res.json(updated);
      }
    }

    const { data: row, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number: poNum, brand_id, brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() })
      .select().single();
    if (error) throw error;
    await appendAuditEntry(row.id, actor, 'create', { po_number: poNum });
    await syncPoLinesSafe(row.id, data);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// NOTE: /api/pos/trash must be declared BEFORE /api/pos/:id since Express
// matches routes in order — otherwise :id matches "trash" literally.
app.get('/api/pos/trash', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, po_number, brand_id, brand_name, status, created_at, updated_at, deleted_at, deleted_by')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pos/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('purchase_orders').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lightweight audit history — returns just the audit_log array (newest first),
// avoiding the full PO data blob. Powers the per-PO History modal.
app.get('/api/pos/:id/audit', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('audit_log')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    const log = Array.isArray(data?.audit_log) ? data.audit_log : [];
    res.json(log.slice().reverse());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── P3: PO spend reporting ──────────────────────────────────────────────────
// Spend grouped by brand over a date range. Joins the line projection to parent
// POs in app code (low PO volume; avoids an RPC migration). The PO date lives in
// data->>'date'; soft-deleted POs are excluded. Bundle-header rows carry $0 so
// summing extended_cost never double-counts; they're also excluded from units.
app.get('/api/po-report/spend-by-brand', async (req, res) => {
  try {
    const { from, to, status } = req.query;

    let pq = supabase
      .from('purchase_orders')
      .select('id, brand_id, brand_name, status, podate:data->>date')
      .is('deleted_at', null);
    if (status) pq = pq.eq('status', status);
    const { data: pos, error: perr } = await pq;
    if (perr) throw perr;

    const inRange = (d) => (!from || (d && d >= from)) && (!to || (d && d <= to));
    const poMeta = new Map();
    for (const po of pos) {
      if (inRange(po.podate)) poMeta.set(po.id, po);
    }

    // Lines for in-range POs — paginate past Supabase's 1000-row cap.
    const lines = [];
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase
        .from('purchase_order_lines')
        .select('po_id, line_type, extended_cost, quantity')
        .range(off, off + 999);
      if (error) throw error;
      lines.push(...data);
      if (data.length < 1000) break;
    }

    const byBrand = new Map();
    for (const ln of lines) {
      const po = poMeta.get(ln.po_id);
      if (!po) continue;
      const key = po.brand_id || 'unknown';
      if (!byBrand.has(key)) byBrand.set(key, { brand_id: po.brand_id, brand_name: po.brand_name || 'Unknown', spend: 0, units: 0, poIds: new Set() });
      const b = byBrand.get(key);
      b.spend += Number(ln.extended_cost || 0);
      if (ln.line_type !== 'bundle-header') b.units += Number(ln.quantity || 0);
      b.poIds.add(ln.po_id);
    }

    const brands = [...byBrand.values()]
      .map(b => ({ brand_id: b.brand_id, brand_name: b.brand_name, spend: b.spend, units: b.units, po_count: b.poIds.size }))
      .sort((a, b) => b.spend - a.spend || b.units - a.units);

    res.json({
      from: from || null, to: to || null, status: status || null,
      brands,
      totals: {
        spend: brands.reduce((s, r) => s + r.spend, 0),
        units: brands.reduce((s, r) => s + r.units, 0),
        po_count: brands.reduce((s, r) => s + r.po_count, 0),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pos/:id', async (req, res) => {
  try {
    const { po_number, brand_id, brand_name, status, data } = req.body;
    const poNum = po_number != null && po_number !== '' ? Number(po_number) : null;
    if (poNum != null && (!Number.isFinite(poNum) || poNum < 0)) {
      return res.status(400).json({ error: 'po_number must be a non-negative number' });
    }
    const actor = actorFrom(req);
    // Pull prior state for diff
    const { data: prev } = await supabase.from('purchase_orders').select('po_number,brand_id,brand_name,status,data').eq('id', req.params.id).maybeSingle();
    const next = { po_number: poNum, brand_id, brand_name, status, data };
    const changed = poDiff(prev, next);

    const { data: row, error } = await supabase
      .from('purchase_orders')
      .update({ po_number: poNum, brand_id, brand_name, status, data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    if (changed.length) await appendAuditEntry(row.id, actor, 'update', { changedFields: changed });
    await syncPoLinesSafe(row.id, data);
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Soft-delete: marks deleted_at, preserves row. Recoverable via /api/pos/:id/restore.
app.delete('/api/pos/:id', async (req, res) => {
  try {
    const actor = actorFrom(req);
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .update({ deleted_at: new Date().toISOString(), deleted_by: actor })
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .select().maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'PO not found or already deleted' });
    await appendAuditEntry(row.id, actor, 'soft_delete');
    res.json({ success: true, id: row.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Restore a soft-deleted PO. Admin recovery.
app.post('/api/pos/:id/restore', async (req, res) => {
  try {
    const actor = actorFrom(req);
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .update({ deleted_at: null, deleted_by: null })
      .eq('id', req.params.id)
      .not('deleted_at', 'is', null)
      .select().maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'PO not found or not deleted' });
    await appendAuditEntry(row.id, actor, 'restore');
    res.json({ success: true, po: row });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Hard-purge — permanent delete. Only allowed for already-soft-deleted POs.
app.delete('/api/pos/:id/purge', async (req, res) => {
  try {
    const actor = actorFrom(req);
    const { data: existing } = await supabase
      .from('purchase_orders')
      .select('id, deleted_at, po_number, brand_id')
      .eq('id', req.params.id)
      .maybeSingle();
    if (!existing) return res.status(404).json({ error: 'PO not found' });
    if (!existing.deleted_at) return res.status(400).json({ error: 'PO must be soft-deleted before purge' });
    const { error } = await supabase.from('purchase_orders').delete().eq('id', req.params.id);
    if (error) throw error;
    console.log(`[PO] ${actor} purged PO ${existing.po_number} (${existing.brand_id})`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Refresh bundle-component prices from live brand data. Each bundle component's
// `buyCost` (per the brand record) is the source of truth at PO generation time.
// Without this, a bundle generated today and again next month would use the same
// captured price even if the underlying buy cost changed.
//
// Only touches bundle-component lines. Single + multipack rows keep whatever
// price was set on the PO (operator can override manually in the line editor).
function refreshBundleComponentPrices(lines, brands) {
  if (!Array.isArray(lines) || !brands?.length) return lines || [];
  return lines.map(line => {
    if (line._type !== 'bundle-component' || !line.asin) return line;
    const compBrand = brands.find(b => b.asins?.includes(line.asin));
    if (!compBrand) return line;
    const fresh = compBrand.buyCost?.[line.asin] ?? compBrand.cogs?.[line.asin];
    if (fresh == null) return line;
    return { ...line, price: Number(fresh) };
  });
}

// POST generate PO PDF
// Consolidates PO lines for supplier download:
// - Strips bundle-header rows (display only)
// - Merges lines by Stock # → ASIN → description (UPC dropped — too unreliable when stored as scientific notation)
function consolidatePOLines(lines) {
  const supplierLines = (lines || []).filter(l => l._type !== 'bundle-header');
  const groups = new Map();
  let blankCounter = 0;
  for (const line of supplierLines) {
    if (!line.description && !line.asin) continue;
    // Composite key: stockNumber|upc|asin|description. Each part is included so two lines
    // only merge if every key field matches. A blank line (no stock#, no UPC, no ASIN, no
    // description) gets a unique counter so blank rows don't collapse into each other.
    const stockNumber = (line.stockNumber || '').trim();
    const upc = (line.upc || '').trim();
    const asin = (line.asin || '').trim();
    const description = (line.description || '').trim();
    if (!stockNumber && !upc && !asin && !description) continue;
    let key = `${stockNumber}|${upc}|${asin}|${description}`;
    if (!stockNumber && !upc && !asin) key = `${key}|__blank_${blankCounter++}`;
    if (!groups.has(key)) {
      groups.set(key, { ...line, quantity: 0, cases: 0 });
    }
    const g = groups.get(key);
    g.quantity += Number(line.quantity) || 0;
    const cp = Number(g.casePack) || 1;
    g.cases = cp > 0 ? Math.ceil(g.quantity / cp) : 0;
  }
  return [...groups.values()];
}

async function renderPoPdf({ brand, settings, poNum, lines, status, notes, date, optionalCols }) {
  const puppeteer = require('puppeteer');
  const poDate = date || new Date().toLocaleDateString('en-CA');
    const statusVal = status || 'Working';
    const isSubmitted = statusVal.toLowerCase() === 'submitted';
    const currency = brand.marketplace === 'US' ? 'USD' : 'CAD';

    const extras = optionalCols || {};
    const colHeaders = ['Item Description', 'UPC'];
    if (extras.stockNumber) colHeaders.push('Stock #');
    colHeaders.push('# of Cases', 'Price');
    if (extras.qtyPerCase)  colHeaders.push('Qty/Case');
    colHeaders.push('Quantity', 'Total');

    let subtotal = 0;
    const validLines = consolidatePOLines(lines).filter(l => l.description || l.asin);
    const lineRows = validLines.map(line => {
      const qty   = Number(line.quantity) || 0;
      const price = Number(line.price)    || 0;
      const total = qty * price;
      subtotal += total;
      const fmt = v => '$' + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const cells = [
        `<td class="desc">${escapeHtml(line.description || line.asin || '')}</td>`,
        `<td>${escapeHtml(line.upc || '')}</td>`,
        extras.stockNumber ? `<td>${escapeHtml(line.stockNumber || '')}</td>` : '',
        `<td>${line.cases || 0}</td>`,
        `<td>${fmt(price)}</td>`,
        extras.qtyPerCase  ? `<td>${line.casePack || ''}</td>` : '',
        `<td>${qty}</td>`,
        `<td>${fmt(total)}</td>`,
      ].join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    const fmt = v => '$' + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    const logoPath = path.join(__dirname, 'public', 'rmc-logo.png');
    let logoDataUrl = '';
    try {
      const imgBuf = fs.readFileSync(logoPath);
      logoDataUrl = `data:image/png;base64,${imgBuf.toString('base64')}`;
    } catch (e) {
      console.warn('[PO PDF] Logo not found at', logoPath, '-', e.message);
    }

    const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Calibri', Arial, sans-serif; font-size: 10pt; color: #1a1a1a; background: white; }
  .page { padding: 28px 32px; }

  /* Header */
  .header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
  .logo { height: 112px; width: auto; }
  .po-meta { display: flex; align-items: center; gap: 24px; flex: 1; justify-content: flex-end; }
  .po-number-block { display: flex; align-items: baseline; gap: 10px; }
  .po-number-label { font-size: 11pt; font-weight: 700; color: #1a1a1a; }
  .po-number-val { font-size: 16pt; font-weight: 700; color: #1a1a1a; border-bottom: 2px solid #333; padding-bottom: 1px; min-width: 60px; }
  .status-block { display: flex; align-items: center; gap: 8px; }
  .status-label { font-size: 10pt; font-weight: 700; color: #1a1a1a; }
  .status-badge { padding: 3px 14px; border-radius: 3px; font-size: 10pt; font-weight: 700;
    background: ${isSubmitted ? '#70AD47' : '#D9E1F2'}; color: ${isSubmitted ? '#fff' : '#1F3864'}; }
  .date-block { display: flex; align-items: baseline; gap: 8px; }
  .date-label { font-size: 10pt; font-weight: 700; color: #1a1a1a; }
  .date-val { font-size: 10pt; color: #1a1a1a; }

  /* Info grid */
  .info-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; border: 1px solid #ccc; margin-bottom: 16px; }
  .info-col { padding: 0; }
  .info-col + .info-col { border-left: 1px solid #ccc; }
  .info-row { display: flex; border-bottom: 1px solid #eee; min-height: 22px; }
  .info-row:last-child { border-bottom: none; }
  .info-lbl { font-size: 8.5pt; font-weight: 700; color: #555; text-align: right; padding: 3px 6px; width: 46%; white-space: nowrap; }
  .info-val { font-size: 9pt; color: #1a1a1a; padding: 3px 6px; flex: 1; }

  /* Table */
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  thead tr { background: #1F3864; color: white; }
  thead th { padding: 6px 8px; font-size: 9.5pt; font-weight: 700; text-align: center; }
  thead th.desc { text-align: left; }
  tbody tr:nth-child(even) { background: #f8f9fb; }
  tbody td { padding: 4px 8px; font-size: 9pt; text-align: center; border-bottom: 1px solid #e8edf3; }
  tbody td.desc { text-align: left; }

  /* Totals */
  .totals { display: flex; justify-content: flex-end; margin-bottom: 16px; }
  .totals-table { width: 260px; border-collapse: collapse; }
  .totals-table td { padding: 4px 10px; font-size: 10pt; }
  .totals-table .lbl { text-align: right; color: #444; }
  .totals-table .val { text-align: right; font-family: 'Courier New', monospace; font-size: 9.5pt; }
  .totals-table .grand { background: #D9E1F2; font-weight: 700; }

  /* Notes */
  .notes-header { background: #1F3864; color: white; font-weight: 700; font-size: 9.5pt; padding: 5px 10px; }
  .notes-body { background: #FCE4D6; min-height: 60px; padding: 8px 10px; font-size: 9.5pt; color: #333; }
</style>
</head>
<body>
<div class="page">

  <!-- Header row -->
  <div class="header">
    ${logoDataUrl ? `<img class="logo" src="${logoDataUrl}">` : '<div style="width:80px"></div>'}
    <div class="po-meta">
      <div class="po-number-block">
        <span class="po-number-label">Purchase Order #:</span>
        <span class="po-number-val">${poNum}</span>
      </div>
      <div class="status-block">
        <span class="status-label">PO Status</span>
        <span class="status-badge">${escapeHtml(statusVal)}</span>
      </div>
      <div class="date-block">
        <span class="date-label">Date:</span>
        <span class="date-val">${escapeHtml(poDate)}</span>
      </div>
    </div>
  </div>

  <!-- Info grid -->
  <div class="info-grid">
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Name of Vendor:</span><span class="info-val">${escapeHtml(brand.vendor?.name || '')}</span></div>
      <div class="info-row"><span class="info-lbl">Vendor Address:</span><span class="info-val">${escapeHtml(brand.vendor?.address || '')}</span></div>
      <div class="info-row"><span class="info-lbl">City/Province/Postal:</span><span class="info-val">${escapeHtml(brand.vendor?.city || '')}</span></div>
      <div class="info-row"><span class="info-lbl">Vendor Phone:</span><span class="info-val">${escapeHtml(brand.vendor?.phone || '')}</span></div>
      <div class="info-row"><span class="info-lbl">&nbsp;</span><span class="info-val"></span></div>
    </div>
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Bill To (Name):</span><span class="info-val">${escapeHtml(settings.billTo.name)}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Address:</span><span class="info-val">${escapeHtml(settings.billTo.address)}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To City/State/Zip:</span><span class="info-val">${escapeHtml(settings.billTo.city)}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Phone:</span><span class="info-val">${escapeHtml(settings.billTo.phone)}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Email:</span><span class="info-val">${escapeHtml(settings.billTo.email)}</span></div>
    </div>
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Ship To (Name):</span><span class="info-val">${escapeHtml(settings.shipTo.name)}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Address:</span><span class="info-val">${escapeHtml(settings.shipTo.address)}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To City/State/Zip:</span><span class="info-val">${escapeHtml(settings.shipTo.city)}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Phone:</span><span class="info-val">${escapeHtml(settings.shipTo.phone)}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Email:</span><span class="info-val">${escapeHtml(settings.shipTo.email)}</span></div>
    </div>
  </div>

  <!-- Line items table -->
  <table>
    <thead>
      <tr>
        <th class="desc">Item Description</th>
        <th>UPC</th>
        ${extras.stockNumber ? '<th>Stock #</th>' : ''}
        <th># of Cases</th>
        <th>Price</th>
        ${extras.qtyPerCase  ? '<th>Qty/Case</th>' : ''}
        <th>Quantity</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <table class="totals-table">
      <tr><td class="lbl">Currency</td><td class="val">${currency}</td></tr>
      <tr><td class="lbl">Subtotal</td><td class="val">${fmt(subtotal)}</td></tr>
      <tr><td class="lbl">Tax</td><td class="val">$0.00</td></tr>
      <tr><td class="lbl">Shipping</td><td class="val">$0.00</td></tr>
      <tr class="grand"><td class="lbl">Grand Total</td><td class="val">${fmt(subtotal)}</td></tr>
    </table>
  </div>

  <!-- Notes -->
  <div class="notes-header">Comments / Notes</div>
  <div class="notes-body">${escapeHtml(notes || '')}</div>

</div>
</body>
</html>`;

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath()
    });
    const page = await browser.newPage();
    // 'load' is enough — HTML has no external resources (logo is inlined base64).
    await page.setContent(html, { waitUntil: 'load' });
    // Measure actual content height so PDF never clips regardless of item count
    const contentHeight = await page.evaluate(() => document.body.scrollHeight);
    const pdfData = await page.pdf({
      width: '8.5in',
      height: (contentHeight + 40) + 'px',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    await browser.close();

    return Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
}

// Force-save the PO record before returning a generated file. Production guarantee:
// any PO that gets emailed to a supplier MUST exist in the database. Caller passes
// existingPoId when updating an existing PO; otherwise we create a new row.
async function forceSavePO({ existingPoId, po_number, brand_id, brand_name, status, data, actor, generatedFormat }) {
  const update = { brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() };
  if (po_number != null) update.po_number = po_number;

  if (existingPoId) {
    const { data: prev } = await supabase.from('purchase_orders').select('po_number,brand_id,brand_name,status,data').eq('id', existingPoId).maybeSingle();
    const changed = poDiff(prev, { po_number, brand_id, brand_name, status, data });
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .update(update)
      .eq('id', existingPoId)
      .select().single();
    if (error) throw error;
    if (changed.length) await appendAuditEntry(row.id, actor, 'update', { changedFields: changed });
    await appendAuditEntry(row.id, actor, generatedFormat === 'pdf' ? 'generate_pdf' : 'generate_xlsx', { po_number });
    await syncPoLinesSafe(row.id, data);
    return row;
  }

  // Look for an existing non-deleted PO with this (po_number, brand_id) to avoid duplicates
  if (po_number != null && brand_id) {
    const { data: existing } = await supabase
      .from('purchase_orders')
      .select('id, po_number, brand_id, brand_name, status, data')
      .eq('po_number', po_number)
      .eq('brand_id', brand_id)
      .is('deleted_at', null)
      .maybeSingle();
    if (existing?.id) {
      const changed = poDiff(existing, { po_number, brand_id, brand_name, status, data });
      const { data: row, error } = await supabase
        .from('purchase_orders').update(update).eq('id', existing.id).select().single();
      if (error) throw error;
      if (changed.length) await appendAuditEntry(row.id, actor, 'update', { changedFields: changed });
      await appendAuditEntry(row.id, actor, generatedFormat === 'pdf' ? 'generate_pdf' : 'generate_xlsx', { po_number });
      await syncPoLinesSafe(row.id, data);
      return row;
    }
  }

  const { data: row, error } = await supabase
    .from('purchase_orders')
    .insert({ po_number, brand_id, brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() })
    .select().single();
  if (error) throw error;
  await appendAuditEntry(row.id, actor, 'create', { po_number, viaForceSave: true });
  await appendAuditEntry(row.id, actor, generatedFormat === 'pdf' ? 'generate_pdf' : 'generate_xlsx', { po_number });
  await syncPoLinesSafe(row.id, data);
  return row;
}

app.post('/api/po/generate-pdf', async (req, res) => {
  try {
    const { brandId, lines: rawLines, status, notes, poNumber, date, optionalCols, existingPoId } = req.body;
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    // Refresh bundle component prices from live brand data right before render
    const lines = refreshBundleComponentPrices(rawLines, brands);

    for (let attempt = 0; attempt < 5; attempt++) {
      const settings = await loadPoSettings();
      const expected = settings.lastPoNumber;
      const poNum = poNumber || (expected + 1);

      const pdfBuf = await renderPoPdf({ brand, settings, poNum, lines, status, notes, date, optionalCols });

      // Atomically commit the new lastPoNumber. If user provided a custom poNumber, only bump
      // the counter forward (never roll back). Skip the commit if no bump is needed.
      const targetLastPo = poNumber ? Math.max(expected, Number(poNum)) : poNum;
      if (targetLastPo > expected) {
        const committed = await tryCommitLastPoNumber(expected, targetLastPo);
        if (!committed) {
          console.warn(`[PO PDF] PO# ${poNum} conflict on attempt ${attempt + 1}, retrying`);
          continue;
        }
      }

      // FORCE SAVE — every generated PO writes to the database so the supplier copy
      // is always traceable. Failure here doesn't block the download but is logged.
      try {
        const saved = await forceSavePO({
          existingPoId,
          po_number: Number(poNum),
          brand_id:  brand.id,
          brand_name: brand.name,
          status,
          data: { lines, notes, date, optionalCols, poDate: date, poStatus: status, poNumber: poNum },
          actor: actorFrom(req),
          generatedFormat: 'pdf',
        });
        res.setHeader('X-PO-Saved-Id', saved.id);
      } catch (saveErr) {
        console.error('[PO PDF] Force-save failed (file still returned):', saveErr.message);
        res.setHeader('X-PO-Save-Error', saveErr.message);
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuf.length);
      res.setHeader('Content-Disposition', `attachment; filename="PO-${poNum}-${brand.name.replace(/[^a-z0-9]/gi, '-')}.pdf"`);
      return res.end(pdfBuf);
    }

    res.status(409).json({ error: 'Could not allocate PO number due to concurrent updates. Please try again.' });
  } catch (err) {
    console.error('[PO PDF] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

async function renderPoExcel({ brand, settings, poNum, lines, status, notes, date, optionalCols }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Purchase Order');
    const currency = brand.marketplace === 'US' ? 'USD' : 'CAD';

    // Optional columns config
    const extras = optionalCols || {};

    // Build column header list early so we can calculate lastDataCol
    const colHeaders = ['Item Description', 'UPC'];
    if (extras.stockNumber)    colHeaders.push('Stock #');
    colHeaders.push('# of Cases', 'Price');
    if (extras.qtyPerCase) colHeaders.push('Qty/Case');
    colHeaders.push('Quantity', 'Total');
    const lastDataCol = 2 + colHeaders.length; // data cols start at 3, so last = 2 + count

    // ── Column widths ────────────────────────────────────────────────
    const colDefs = [
      { key: 'a', width: 2 },
      { key: 'b', width: 16 },  // logo column
      { key: 'c', width: 38 },  // Item Description
      { key: 'd', width: 18 },  // UPC
      ...(extras.stockNumber ? [{ key: 'sn', width: 14 }] : []),
      { key: 'e', width: 12 },  // # of Cases
      { key: 'f', width: 14 },  // Price
      ...(extras.qtyPerCase  ? [{ key: 'qc', width: 14 }] : []),
      { key: 'g', width: 12 },  // Quantity
      { key: 'h', width: 16 },  // Total
    ];
    // Info block (rows 5-9) extends to col K(11) — pad so those cells exist
    while (colDefs.length < 11) colDefs.push({ width: 14 });
    ws.columns = colDefs;

    const BLUE   = '1F3864';
    const LBLUE  = 'D9E1F2';
    const GREEN  = '70AD47';
    const WHITE  = 'FFFFFF';
    const SALMON = 'FCE4D6';

    const hdrFont  = { name: 'Calibri', bold: true, color: { argb: 'FF' + WHITE }, size: 10 };
    const bodyFont = { name: 'Calibri', size: 10 };
    const labelFont = { name: 'Calibri', bold: true, size: 9, color: { argb: 'FF555555' } };
    const mono = { name: 'Courier New', size: 9 };

    const money = '"$"#,##0.00';
    const center = { horizontal: 'center', vertical: 'middle' };
    const left   = { horizontal: 'left',   vertical: 'middle' };
    const right  = { horizontal: 'right',  vertical: 'middle' };

    function cell(r, c) { return ws.getCell(r, c); }
    function mergeStyle(r, c1, c2, value, font, fill, alignment, numFmt) {
      ws.mergeCells(r, c1, r, c2);
      const cl = cell(r, c1);
      cl.value = value;
      if (font) cl.font = font;
      if (fill) cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + fill } };
      if (alignment) cl.alignment = alignment;
      if (numFmt) cl.numFmt = numFmt;
    }

    const totalCols = ws.columns.length;
    const lastCol   = totalCols;

    // ── Logo ─────────────────────────────────────────────────────────
    const logoPath = path.join(__dirname, 'public', 'rmc-logo.png');
    try {
      const logoId = wb.addImage({ filename: logoPath, extension: 'png' });
      ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 5 }, editAs: 'oneCell' });
    } catch (e) {
      console.warn('[PO Excel] Logo not found at', logoPath, '-', e.message);
    }

    // ── Row 1: blank ─────────────────────────────────────────────────
    ws.getRow(1).height = 8;

    // ── Row 2: PO number, status, date ───────────────────────────────
    ws.getRow(2).height = 22;
    mergeStyle(2, 1, 2, null, null, null, null);

    // "Purchase Order #:" label in C only, number in D
    const poLabelCell = cell(2, 3);
    poLabelCell.value = 'Purchase Order #:';
    poLabelCell.font = { name: 'Calibri', bold: true, size: 11 };
    poLabelCell.alignment = left;
    const poNumCell = cell(2, 4);
    poNumCell.value = poNum;
    poNumCell.font = { name: 'Calibri', bold: true, size: 14 };
    poNumCell.alignment = left;
    poNumCell.border = { bottom: { style: 'medium', color: { argb: 'FF333333' } } };

    // "PO Status" label in F(6), colored status value merged G-H(7-8)
    const statusColor = (status || '').toLowerCase() === 'submitted' ? GREEN : LBLUE;
    const statusTextColor = (status || '').toLowerCase() === 'submitted' ? WHITE : '1F3864';
    const poStatusLabel = cell(2, 6);
    poStatusLabel.value = 'PO Status';
    poStatusLabel.font = { name: 'Calibri', bold: true, size: 10 };
    poStatusLabel.alignment = right;
    mergeStyle(2, 7, 8, safeExcelString(status || 'Working'), { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + statusTextColor } }, statusColor, center);

    // "Date:" label in I(9), date value in J(10)
    const dateLabelCell = cell(2, 9);
    dateLabelCell.value = 'Date:';
    dateLabelCell.font = { name: 'Calibri', bold: true, size: 10 };
    dateLabelCell.alignment = right;
    const dateValCell = cell(2, 10);
    dateValCell.value = safeExcelString(date || new Date().toLocaleDateString('en-CA'));
    dateValCell.font = { name: 'Calibri', bold: true, size: 10 };
    dateValCell.alignment = left;

    // ── Rows 3-4: blank ──────────────────────────────────────────────
    ws.getRow(3).height = 6;
    ws.getRow(4).height = 6;

    // ── Rows 5-9: Vendor | Bill To | Ship To ─────────────────────────
    const infoRows = [
      ['Name of Vendor:', safeExcelString(brand.vendor?.name || ''), 'Bill To (Name):', safeExcelString(settings.billTo.name), 'Ship To (Name):', safeExcelString(settings.shipTo.name)],
      ['Vendor Address:', safeExcelString(brand.vendor?.address || ''), 'Bill To Address:', safeExcelString(settings.billTo.address), 'Ship To Address:', safeExcelString(settings.shipTo.address)],
      ['Vendor City/Province/Area Code:', safeExcelString(brand.vendor?.city || ''), 'Bill To City/State/Zip:', safeExcelString(settings.billTo.city), 'Ship To City/State/Zip:', safeExcelString(settings.shipTo.city)],
      ['Vendor Phone:', safeExcelString(brand.vendor?.phone || ''), 'Bill To Phone:', safeExcelString(settings.billTo.phone), 'Ship To Phone:', safeExcelString(settings.shipTo.phone)],
      ['', '', 'Bill To Email:', safeExcelString(settings.billTo.email), 'Ship To Email:', safeExcelString(settings.shipTo.email)],
    ];

    // 3-block layout: [labelCol, valStart, valEnd]
    // Block 1: label in C(3), value in D-E(4-5)
    // Block 2: label in F(6), value in G-H(7-8)
    // Block 3: label in I(9), value in J-K(10-11)
    const infoBlocks = [[3, 4, 5], [6, 7, 8], [9, 10, 11]];
    infoRows.forEach((rowData, i) => {
      const r = 5 + i;
      ws.getRow(r).height = 18;
      infoBlocks.forEach(([lc, vs, ve], bi) => {
        const label = rowData[bi * 2];
        const value = rowData[bi * 2 + 1];

        const labelCell = cell(r, lc);
        labelCell.value = label;
        labelCell.font = labelFont;
        labelCell.alignment = right;

        ws.mergeCells(r, vs, r, ve);
        const valCell = cell(r, vs);
        valCell.value = value;
        valCell.font = bodyFont;
        valCell.alignment = left;
      });
    });

    // ── Row 10-11: spacer ────────────────────────────────────────────
    ws.getRow(10).height = 6;
    ws.getRow(11).height = 6;

    // ── Row 12: column headers ────────────────────────────────────────
    const headerRow = 12;
    ws.getRow(headerRow).height = 20;

    // Map header labels to actual column indices (starting at col 3)
    let ci = 3;
    const colMap = {}; // label → col index
    colHeaders.forEach(h => { colMap[h] = ci; ci++; });

    colHeaders.forEach((h, idx) => {
      const c = cell(headerRow, 3 + idx);
      c.value = h;
      c.font = hdrFont;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + BLUE } };
      c.alignment = center;
      c.border = { bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
    });

    // ── Rows 13+: line items ──────────────────────────────────────────
    let dataRow = headerRow + 1;
    let subtotal = 0;

    for (const line of consolidatePOLines(lines)) {
      if (!line.description && !line.asin) continue;
      ws.getRow(dataRow).height = 16;

      const qty    = Number(line.quantity) || 0;
      const price  = Number(line.price)    || 0;
      const total  = qty * price;
      subtotal += total;

      const setCell = (label, value, fmt) => {
        const c = colMap[label];
        if (!c) return;
        const cl = cell(dataRow, c);
        cl.value = value;
        cl.font = label === 'Item Description' ? bodyFont : mono;
        cl.alignment = ['Item Description'].includes(label) ? left : center;
        if (fmt) cl.numFmt = fmt;
        cl.border = { bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } } };
      };

      setCell('Item Description', safeExcelString(line.description || line.asin));
      setCell('UPC', safeExcelString(line.upc || ''));
      if (extras.stockNumber)    setCell('Stock #',         safeExcelString(line.stockNumber || ''));
      setCell('# of Cases',      line.cases || 0);
      setCell('Price',           price,  money);
      if (extras.qtyPerCase)     setCell('Qty/Case',        line.casePack || '');
      setCell('Quantity',        qty);
      setCell('Total',           total, money);

      dataRow++;
    }

    // ── Spacer ────────────────────────────────────────────────────────
    dataRow++;

    // ── Totals block ──────────────────────────────────────────────────
    // Rows: ['label', value, isMoney]
    const totals = [
      ['Currency', currency, false],
      ['Subtotal', subtotal, true],
      ['Tax', 0, true],
      ['Shipping', 0, true],
      ['Grand Total', subtotal, true],
    ];

    const totalLabelCol = lastDataCol - 1;  // Quantity col = second-to-last data col
    const totalValueCol = lastDataCol;      // Total col = last data col

    totals.forEach(([label, value, isMoney], i) => {
      const r = dataRow + i;
      ws.getRow(r).height = 16;
      const lc = cell(r, totalLabelCol);
      lc.value = label;
      lc.font = { name: 'Calibri', bold: label === 'Grand Total', size: 10 };
      lc.alignment = right;

      const vc = cell(r, totalValueCol);
      vc.value = value;
      vc.font = { name: 'Calibri', bold: label === 'Grand Total', size: 10 };
      if (isMoney) vc.numFmt = money;
      vc.alignment = right;

      if (label === 'Grand Total') {
        lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LBLUE } };
        vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + LBLUE } };
      }
    });

    dataRow += totals.length + 1;

    // ── Comments / Notes ──────────────────────────────────────────────
    ws.getRow(dataRow).height = 18;
    mergeStyle(dataRow, 3, lastDataCol, 'Comments / Notes', hdrFont, BLUE, left);
    dataRow++;
    ws.getRow(dataRow).height = 60;
    mergeStyle(dataRow, 3, lastDataCol, safeExcelString(notes || ''), bodyFont, SALMON, { ...left, wrapText: true });

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

app.post('/api/po/generate', async (req, res) => {
  try {
    const { brandId, lines: rawLines, status, notes, poNumber, date, optionalCols, existingPoId } = req.body;
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    const lines = refreshBundleComponentPrices(rawLines, brands);

    for (let attempt = 0; attempt < 5; attempt++) {
      const settings = await loadPoSettings();
      const expected = settings.lastPoNumber;
      const poNum = poNumber || (expected + 1);

      const xlsxBuf = await renderPoExcel({ brand, settings, poNum, lines, status, notes, date, optionalCols });

      const targetLastPo = poNumber ? Math.max(expected, Number(poNum)) : poNum;
      if (targetLastPo > expected) {
        const committed = await tryCommitLastPoNumber(expected, targetLastPo);
        if (!committed) {
          console.warn(`[PO Excel] PO# ${poNum} conflict on attempt ${attempt + 1}, retrying`);
          continue;
        }
      }

      // FORCE SAVE — every generated PO writes to the database. Same guarantee
      // as the PDF route: no PO can leave the system without a record.
      try {
        const saved = await forceSavePO({
          existingPoId,
          po_number: Number(poNum),
          brand_id:  brand.id,
          brand_name: brand.name,
          status,
          data: { lines, notes, date, optionalCols, poDate: date, poStatus: status, poNumber: poNum },
          actor: actorFrom(req),
          generatedFormat: 'xlsx',
        });
        res.setHeader('X-PO-Saved-Id', saved.id);
      } catch (saveErr) {
        console.error('[PO Excel] Force-save failed (file still returned):', saveErr.message);
        res.setHeader('X-PO-Save-Error', saveErr.message);
      }

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Length', xlsxBuf.length);
      res.setHeader('Content-Disposition', `attachment; filename="PO-${poNum}-${brand.name.replace(/[^a-z0-9]/gi, '-')}.xlsx"`);
      return res.end(xlsxBuf);
    }

    res.status(409).json({ error: 'Could not allocate PO number due to concurrent updates. Please try again.' });
  } catch (err) {
    console.error('[PO Excel] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Cloud drafts — replaces localStorage so drafts work cross-machine ───────
// Keyed by 'new:<brandId>' (fresh draft) or 'po:<poId>' (editing existing).
// One row per key; latest data wins (no concurrent-edit protection — by design).
app.get('/api/po-drafts/:key', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('po_drafts').select('*').eq('key', req.params.key).maybeSingle();
    if (error) throw error;
    res.json(data || null);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/po-drafts/:key', async (req, res) => {
  try {
    const { brand_id, current_po_id, data } = req.body;
    const row = {
      key: req.params.key,
      brand_id: brand_id || null,
      current_po_id: current_po_id || null,
      data,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('po_drafts').upsert(row, { onConflict: 'key' });
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/po-drafts/:key', async (req, res) => {
  try {
    const { error } = await supabase.from('po_drafts').delete().eq('key', req.params.key);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List all drafts (for "pick up where you left off" UI). Returns newest first.
app.get('/api/po-drafts', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('po_drafts').select('key, brand_id, current_po_id, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Import Routes ---

app.get('/api/import/preview', async (req, res) => {
  try {
    const { importBrandsFromAmazon } = require('./sync/amazon');
    const grouped = await importBrandsFromAmazon();
    res.json({ success: true, grouped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/import/all', async (req, res) => {
  try {
    const { importBrandsFromAmazon } = require('./sync/amazon');
    const grouped = await importBrandsFromAmazon();
    const data = await loadBrands();

    const alreadyAssigned = new Set(data.brands.flatMap(b => b.asins));

    for (const [brandName, info] of Object.entries(grouped)) {
      const id = brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const newAsins = info.asins.filter(a => !alreadyAssigned.has(a));
      if (newAsins.length === 0) continue;

      const newTitles = Object.fromEntries(newAsins.filter(a => info.titles?.[a]).map(a => [a, info.titles[a]]));
      const existing = data.brands.find(b => b.id === id);
      if (existing) {
        existing.asins = [...new Set([...existing.asins, ...newAsins])];
        existing.asinTitles = { ...(existing.asinTitles || {}), ...newTitles };
      } else {
        const color = BRAND_COLORS[data.brands.length % BRAND_COLORS.length];
        data.brands.push({
          id, name: brandName, marketplace: 'CA', color,
          asins: newAsins, asinTitles: newTitles,
          createdAt: new Date().toISOString().split('T')[0]
        });
      }
    }

    await saveBrands(data);
    res.json({ success: true, brands: data.brands, imported: Object.keys(grouped).length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/import/confirm', async (req, res) => {
  const { brands: incoming } = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid payload' });

  const data = await loadBrands();

  for (const item of incoming) {
    const id = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = data.brands.find(b => b.id === id);

    if (existing) {
      existing.asins = [...new Set([...existing.asins, ...item.asins])];
    } else {
      const color = BRAND_COLORS[data.brands.length % BRAND_COLORS.length];
      data.brands.push({
        id, name: item.name,
        marketplace: item.marketplace || 'CA',
        color, asins: item.asins,
        createdAt: new Date().toISOString().split('T')[0]
      });
    }
  }

  await saveBrands(data);
  res.json({ success: true, brands: data.brands });
});

// --- Sync Routes ---

app.post('/api/sync', (req, res) => {
  const hasCredentials =
    process.env.SP_API_CLIENT_ID &&
    process.env.SP_API_CLIENT_SECRET &&
    process.env.SP_API_REFRESH_TOKEN;

  if (!hasCredentials) {
    return res.status(503).json({ success: false, message: 'SP-API credentials not configured.' });
  }

  if (syncState.status === 'syncing') {
    return res.json({ success: true, status: 'syncing', message: 'Sync already in progress' });
  }

  res.json({ success: true, status: 'started' });
  runFullSync('Sync');
});

app.get('/api/sync/status', (req, res) => {
  res.json(syncState);
});

// One-time patch: re-derive preset-level adSpend from brand adSummary already in Supabase
app.post('/api/patch-ad-spend', async (req, res) => {
  try {
    const pm = await loadPresetMetrics();
    let patched = 0;
    for (const [presetKey, preset] of Object.entries(pm.presets || {})) {
      let totalCad = 0, totalUsd = 0;
      for (const bm of Object.values(preset.brands || {})) {
        totalCad += bm.adSummary?.spendCad || 0;
        totalUsd += bm.adSummary?.spendUsd || 0;
      }
      if (totalCad > 0 || totalUsd > 0) {
        preset.financials = preset.financials || {};
        preset.financials.CAD = preset.financials.CAD || {};
        preset.financials.USD = preset.financials.USD || {};
        preset.financials.CAD.adSpend = Math.round(totalCad * 100) / 100;
        preset.financials.USD.adSpend = Math.round(totalUsd * 100) / 100;
        patched++;
        console.log(`[patch-ad-spend] ${presetKey}: CAD=${preset.financials.CAD.adSpend} USD=${preset.financials.USD.adSpend}`);
      }
    }
    await savePresetMetrics(pm);
    res.json({ success: true, patched, message: `Updated adSpend for ${patched} preset(s)` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/fx', async (req, res) => res.json(await fetchFxRate()));

app.get('/api/download/settlement', (req, res) => {
  const filePath = path.join(DATA_DIR, 'settlement-report.txt');
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No settlement report found. Run the download script first.' });
  res.setHeader('Content-Type', 'text/tab-separated-values');
  res.setHeader('Content-Disposition', 'attachment; filename="settlement-report.tsv"');
  res.sendFile(filePath);
});

app.get('/api/preset-metrics', async (req, res) => {
  res.json(await loadPresetMetrics());
});

// Yesterday data — sourced from daily_metrics (Supabase). Persistent across restarts.
// Sync writes daily_metrics 3x/day (6/9/12 UTC crons). For listing-health alerts and
// title/image fallbacks, we still consult the S&T preset cache.
app.get('/api/metrics/yesterday', async (req, res) => {
  const yest = pstSubtractDays(pstDateStr(), 1);
  const { brands } = await loadBrands();
  const pm = await loadPresetMetrics();
  const fx = await fetchFxRate();
  const stPreset = pm.presets?.yesterday || {};

  const { data: rows, error } = await supabase
    .from('daily_metrics')
    .select('*')
    .eq('date', yest);

  if (error) {
    console.error('[YesterdayAPI] daily_metrics query failed:', error.message);
    return res.status(500).json({ error: 'Failed to load yesterday data' });
  }

  // Index by ASIN for O(1) lookup
  const dmByAsin = {};
  for (const r of (rows || [])) dmByAsin[r.asin] = r;

  // Find any preset that has imageUrl/title for an ASIN (last30d is most populated)
  function lookupSkuMeta(brandId, asin) {
    for (const key of ['last30d', 'last7d', 'lastMonth', 'mtd']) {
      const sku = (pm.presets?.[key]?.brands?.[brandId]?.skus || []).find(s => s.asin === asin);
      if (sku && (sku.title || sku.imageUrl)) return sku;
    }
    return {};
  }

  const byBrand = {};
  for (const brand of brands) {
    const stBrand   = stPreset.brands?.[brand.id] || {};
    const stSummary = stBrand.summary || {};
    let units = 0, unitsCa = 0, unitsUs = 0, revCad = 0, revUsd = 0, sessions = 0;
    let spendCad = 0, spendUsd = 0, attrSalesCad = 0, attrSalesUsd = 0;
    const buyBoxSamples = [];
    const skus = [];

    for (const asin of (brand.asins || [])) {
      const dm   = dmByAsin[asin];
      const meta = lookupSkuMeta(brand.id, asin);

      const u    = dm?.units        || 0;
      const ca   = dm?.units_ca     || 0;
      const us   = dm?.units_us     || 0;
      const rc   = dm?.revenue_cad  || 0;
      const ru   = dm?.revenue_usd  || 0;
      const sess = dm?.sessions     || 0;
      const sCad = dm?.spend_cad    || 0;
      const sUsd = dm?.spend_usd    || 0;
      const aCad = dm?.attributed_sales_cad || 0;
      const aUsd = dm?.attributed_sales_usd || 0;
      const bb   = dm?.buy_box_pct;

      units += u; unitsCa += ca; unitsUs += us; revCad += rc; revUsd += ru;
      sessions += sess; spendCad += sCad; spendUsd += sUsd;
      attrSalesCad += aCad; attrSalesUsd += aUsd;
      if (bb != null && bb > 0) buyBoxSamples.push(bb);

      const spendTotal = sCad + sUsd * fx.usdToCad;
      const attrTotal  = aCad + aUsd * fx.usdToCad;

      skus.push({
        asin,
        units: u,
        // Frontend (COGS calc) reads unitsCad/unitsUsd; keep both naming styles for safety.
        unitsCa: ca, unitsUs: us, unitsCad: ca, unitsUsd: us,
        revenueCad:         Math.round(rc * 100) / 100,
        revenueUsd:         Math.round(ru * 100) / 100,
        sessions:           sess || null,
        pageViews:          dm?.page_views || null,
        buyBox:             bb,
        cvr:                (u && sess) ? Math.round(u / sess * 10000) / 100 : null,
        spendCad:           sCad,
        spendUsd:           sUsd,
        attributedSalesCad: aCad,
        attributedSalesUsd: aUsd,
        acos:               (spendTotal > 0 && attrTotal > 0)
                              ? Math.round(spendTotal / attrTotal * 10000) / 100
                              : null,
        title:              meta.title    || brand.asinTitles?.[asin] || '',
        imageUrl:           imagesByAsin[asin] || meta.imageUrl || null,
        inventory:          dm?.inventory_on_hand != null
                              ? { onHand: dm.inventory_on_hand, inbound: dm.inventory_inbound || 0 }
                              : (meta.inventory ?? null),
        marketplaces:       [...(ca > 0 ? ['CA'] : []), ...(us > 0 ? ['US'] : [])],
      });
    }

    const avgBuyBox = buyBoxSamples.length
      ? Math.round(buyBoxSamples.reduce((a, b) => a + b, 0) / buyBoxSamples.length * 10) / 10
      : null;

    byBrand[brand.id] = {
      summary: {
        units, unitsCa, unitsUs,
        revenueCad: Math.round(revCad * 100) / 100,
        revenueUsd: Math.round(revUsd * 100) / 100,
        sessions:   sessions || null,
        buyBox:     avgBuyBox,
        avgCvr:     (units && sessions) ? Math.round(units / sessions * 10000) / 100 : null,
        adSummary:  (spendCad + spendUsd) > 0 ? {
          spendCad:           Math.round(spendCad * 100) / 100,
          spendUsd:           Math.round(spendUsd * 100) / 100,
          attributedSalesCad: Math.round(attrSalesCad * 100) / 100,
          attributedSalesUsd: Math.round(attrSalesUsd * 100) / 100,
        } : null,
        alerts:     stSummary.alerts ?? {},
      },
      skus,
    };
  }

  // Safety net: roll up any ASINs with daily_metrics rows that aren't mapped to a brand,
  // so unmapped sales still show up in the top-line totals. These should be assigned via
  // the Mapping tab — this bucket just prevents silent revenue loss.
  const mappedAsins = new Set();
  for (const brand of brands) for (const a of (brand.asins || [])) mappedAsins.add(a);

  let uUnits = 0, uCa = 0, uUs = 0, uRevCad = 0, uRevUsd = 0;
  const uSkus = [];
  for (const r of (rows || [])) {
    if (mappedAsins.has(r.asin)) continue;
    if (!r.units && !r.revenue_cad && !r.revenue_usd) continue;
    uUnits  += r.units       || 0;
    uCa     += r.units_ca    || 0;
    uUs     += r.units_us    || 0;
    uRevCad += r.revenue_cad || 0;
    uRevUsd += r.revenue_usd || 0;
    uSkus.push({
      asin:       r.asin,
      units:      r.units || 0,
      unitsCa:    r.units_ca || 0, unitsUs: r.units_us || 0,
      unitsCad:   r.units_ca || 0, unitsUsd: r.units_us || 0,
      revenueCad: Math.round((r.revenue_cad || 0) * 100) / 100,
      revenueUsd: Math.round((r.revenue_usd || 0) * 100) / 100,
      sessions:   r.sessions || null,
      pageViews:  r.page_views || null,
      buyBox:     r.buy_box_pct,
      cvr: null, spendCad: null, spendUsd: null, attributedSalesCad: null, attributedSalesUsd: null, acos: null,
      title: '', imageUrl: imagesByAsin[r.asin] || null,
      inventory: r.inventory_on_hand != null ? { onHand: r.inventory_on_hand, inbound: r.inventory_inbound || 0 } : null,
      marketplaces: [...((r.units_ca||0) > 0 ? ['CA'] : []), ...((r.units_us||0) > 0 ? ['US'] : [])],
    });
  }
  if (uSkus.length > 0) {
    byBrand['unknown-brand'] = {
      summary: {
        units: uUnits, unitsCa: uCa, unitsUs: uUs,
        revenueCad: Math.round(uRevCad * 100) / 100,
        revenueUsd: Math.round(uRevUsd * 100) / 100,
        sessions: null, buyBox: null, avgCvr: null, adSummary: null, alerts: {},
      },
      skus: uSkus,
    };
  }

  // Roll up daily_metrics into the financials block the tile expects.
  // Ad spend + refunds come from daily_metrics (authoritative). amazonFees +
  // serviceFees still passthrough from preset_metrics until financial events
  // get persisted per-day.
  let topSpendCad=0, topSpendUsd=0, topRefundCad=0, topRefundUsd=0, topRefundCount=0;
  for (const r of (rows || [])) {
    topSpendCad    += r.spend_cad           || 0;
    topSpendUsd    += r.spend_usd           || 0;
    topRefundCad   += r.refund_amount_cad   || 0;
    topRefundUsd   += r.refund_amount_usd   || 0;
    topRefundCount += r.refund_count        || 0;
  }
  const ystFinancialsPT = stPreset.financials || {};
  const financialsOut = {
    CAD: {
      adSpend:      Math.round(topSpendCad * 100) / 100,
      refundAmount: Math.round(topRefundCad * 100) / 100,
      amazonFees:   ystFinancialsPT.CAD?.amazonFees  || 0,
      serviceFees:  ystFinancialsPT.CAD?.serviceFees || 0,
      refundFees:   ystFinancialsPT.CAD?.refundFees  || 0,
      breakdown:    ystFinancialsPT.CAD?.breakdown   || {},
    },
    USD: {
      adSpend:      Math.round(topSpendUsd * 100) / 100,
      refundAmount: Math.round(topRefundUsd * 100) / 100,
      amazonFees:   ystFinancialsPT.USD?.amazonFees  || 0,
      serviceFees:  ystFinancialsPT.USD?.serviceFees || 0,
      refundFees:   ystFinancialsPT.USD?.refundFees  || 0,
      breakdown:    ystFinancialsPT.USD?.breakdown   || {},
    },
    refundCount: topRefundCount,
  };

  res.json({
    date:       yest,
    updatedAt:  new Date().toISOString(),
    label:      'Yesterday',
    startDate:  yest,
    endDate:    yest,
    brands:     byBrand,
    financials: financialsOut,
  });
});

// Today data — prefers in-memory orders poller state (most current), falls back to
// daily_metrics (persisted across restarts) when the in-memory state hasn't rebuilt yet.
// Persistence is written after every poll/rebuild via persistOrdersTodayState().
app.get('/api/metrics/today', async (req, res) => {
  const today      = pstDateStr();
  const todayState = ordersPoller.getState();
  const { brands } = await loadBrands();

  // Build ASIN lookup — prefer in-memory if populated, else load from daily_metrics
  let byAsin = {};
  const hasInMemory = todayState.date === today && Object.keys(todayState.byAsin).length > 0;
  if (hasInMemory) {
    byAsin = todayState.byAsin;
  } else {
    const { data: rows } = await supabase
      .from('daily_metrics')
      .select('asin,units,units_ca,units_us,revenue_cad,revenue_usd')
      .eq('date', today);
    for (const r of (rows || [])) {
      byAsin[r.asin] = {
        units:      r.units,
        unitsCa:    r.units_ca,
        unitsUs:    r.units_us,
        revenueCad: r.revenue_cad,
        revenueUsd: r.revenue_usd,
      };
    }
  }

  const byBrand = {};
  for (const brand of brands) {
    let units = 0, unitsCa = 0, unitsUs = 0, revCad = 0, revUsd = 0;
    const skus = [];
    for (const asin of (brand.asins || [])) {
      const d = byAsin[asin];
      const u = d?.units || 0, ca = d?.unitsCa || 0, us = d?.unitsUs || 0;
      const rc = d?.revenueCad || 0, ru = d?.revenueUsd || 0;
      units += u; unitsCa += ca; unitsUs += us; revCad += rc; revUsd += ru;
      skus.push({
        asin,
        units: u,
        unitsCa: ca, unitsUs: us, unitsCad: ca, unitsUsd: us,
        revenueCad: Math.round(rc * 100) / 100,
        revenueUsd: Math.round(ru * 100) / 100,
        // Fields not available intraday — frontend shows —
        sessions: null, pageViews: null, buyBox: null, cvr: null,
        spendCad: null, spendUsd: null, attributedSalesCad: null, attributedSalesUsd: null, acos: null,
        title: brand.asinTitles?.[asin] || '',
        imageUrl: imagesByAsin[asin] || null,
        marketplaces: [...(ca > 0 ? ['CA'] : []), ...(us > 0 ? ['US'] : [])],
        inventory: null,
      });
    }
    byBrand[brand.id] = {
      summary: {
        units, unitsCa, unitsUs,
        revenueCad: Math.round(revCad * 100) / 100,
        revenueUsd: Math.round(revUsd * 100) / 100,
        sessions: null, buyBox: null, avgCvr: null,
        adSummary: null, alerts: {},
      },
      skus,
    };
  }

  // Safety net: roll up unmapped ASINs (any asin with data not in a brand's asins[]).
  const mappedAsins = new Set();
  for (const b of brands) for (const a of (b.asins || [])) mappedAsins.add(a);
  let uUnits = 0, uCa = 0, uUs = 0, uRevCad = 0, uRevUsd = 0;
  const uSkus = [];
  for (const [asin, d] of Object.entries(byAsin)) {
    if (mappedAsins.has(asin)) continue;
    const u = d?.units || 0, ca = d?.unitsCa || 0, us = d?.unitsUs || 0;
    const rc = d?.revenueCad || 0, ru = d?.revenueUsd || 0;
    if (!u && !rc && !ru) continue;
    uUnits += u; uCa += ca; uUs += us; uRevCad += rc; uRevUsd += ru;
    uSkus.push({
      asin, units: u,
      unitsCa: ca, unitsUs: us, unitsCad: ca, unitsUsd: us,
      revenueCad: Math.round(rc * 100) / 100,
      revenueUsd: Math.round(ru * 100) / 100,
      sessions: null, pageViews: null, buyBox: null, cvr: null,
      spendCad: null, spendUsd: null, attributedSalesCad: null, attributedSalesUsd: null, acos: null,
      title: '', imageUrl: imagesByAsin[asin] || null, inventory: null,
      marketplaces: [...(ca > 0 ? ['CA'] : []), ...(us > 0 ? ['US'] : [])],
    });
  }
  if (uSkus.length > 0) {
    byBrand['unknown-brand'] = {
      summary: {
        units: uUnits, unitsCa: uCa, unitsUs: uUs,
        revenueCad: Math.round(uRevCad * 100) / 100,
        revenueUsd: Math.round(uRevUsd * 100) / 100,
        sessions: null, buyBox: null, avgCvr: null, adSummary: null, alerts: {},
      },
      skus: uSkus,
    };
  }

  res.json({
    date:      today,
    updatedAt: todayState.updatedAt,
    label:     'Today',
    startDate: today,
    endDate:   today,
    brands:    byBrand,
  });
});

// Upsert orders-sourced units/revenue for a single day into daily_metrics.
// This is the AUTHORITATIVE write for units/revenue (matches Sellerboard).
// Writes only the units/revenue columns — leaves S&T traffic columns intact.
async function persistOrdersDay(date, byAsin) {
  if (!date || !byAsin || Object.keys(byAsin).length === 0) return 0;
  const { brands } = await loadBrands();
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  // SKU-based price resolution already happens inside computeDayFromOrders,
  // so byAsin's revenue is largely correct. Any remaining unpriced units —
  // SKUs the Pricing API couldn't resolve — get same-marketplace avg
  // extrapolation as a final fallback.
  const rows = Object.entries(byAsin)
    .filter(([, d]) => (d.units || 0) > 0 || (d.revenueCad || 0) > 0 || (d.revenueUsd || 0) > 0)
    .map(([asin, d]) => {
      const unitsCa  = d.unitsCa  || 0;
      const unitsUs  = d.unitsUs  || 0;
      const pricedCa = d.pricedCa || 0;
      const pricedUs = d.pricedUs || 0;
      const unpricedCa = Math.max(0, unitsCa - pricedCa);
      const unpricedUs = Math.max(0, unitsUs - pricedUs);
      let revCad = d.revenueCad || 0;
      let revUsd = d.revenueUsd || 0;
      if (unpricedCa > 0 && pricedCa > 0) revCad += (revCad / pricedCa) * unpricedCa;
      if (unpricedUs > 0 && pricedUs > 0) revUsd += (revUsd / pricedUs) * unpricedUs;
      return {
        asin,
        date,
        brand_id:    asinBrand[asin] || 'unknown-brand',
        units:       d.units || 0,
        units_ca:    unitsCa,
        units_us:    unitsUs,
        revenue_cad: Math.round(revCad * 100) / 100,
        revenue_usd: Math.round(revUsd * 100) / 100,
      };
    });
  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from('daily_metrics')
    .upsert(rows, { onConflict: 'asin,date' });
  if (error) { console.warn('[Orders] persist error:', error.message); return 0; }
  return rows.length;
}

// Write the orders poller's current today state into daily_metrics. Lets the today
// endpoint serve persisted data immediately on restart, no waiting for rebuild.
//
// Stale-state guard: if state.date doesn't match the current PST date, the
// in-memory state is left over from a prior day (e.g., resetIfNewDay hasn't
// fired yet during a midnight rollover). Writing it to daily_metrics would
// pin yesterday's running totals to today's row — abort.
async function persistOrdersTodayState() {
  try {
    const st = ordersPoller.getState();
    const today = pstDateStr();
    if (st.date && st.date !== today) {
      console.warn(`[Orders] Skipping persist — state.date=${st.date} but today=${today} (stale state, rollover pending)`);
      return;
    }
    const n = await persistOrdersDay(st.date, st.byAsin);
    if (n > 0) console.log(`[Orders] Persisted ${n} today rows for ${st.date}`);
  } catch (e) {
    console.warn('[Orders] persist exception:', e.message);
  }
}

// Re-pull yesterday in full from the Orders API and persist as the authoritative
// units/revenue for that day. Runs nightly after the PST rollover to capture the
// final orders of the day plus any late status changes the 15-min poller missed.
//
// NO ZERO-STALE. The zero-stale step (zeroing existing rows whose ASIN isn't in
// the new pull) was repeatedly the source of catastrophic wipes when SP-API
// returned partial data. My threshold-based safeguards kept getting bypassed:
//   - Jun 10: incoming=17 ASINs slipped past asin-count threshold
//   - Jun 16: existingCount<50 because previous partial had narrowed it,
//             so threshold never fired
//
// Cosmetic cost of removing it: an ASIN whose orders were all cancelled
// between two finalizes shows stale (non-zero) units for ~24h until the
// next finalize confirms. Trivial vs the wipe risk.
//
// All we do now: bail if empty, otherwise upsert. The "zero" path is gone.
async function finalizeYesterdayFromOrders() {
  try {
    const yest = pstSubtractDays(pstDateStr(), 1);
    const { byAsin, orderCount } = await ordersPoller.computeDayFromOrders(yest);

    const realEntries = Object.values(byAsin || {}).filter(d =>
      (d.units || 0) > 0 || (d.revenueCad || 0) > 0 || (d.revenueUsd || 0) > 0
    );
    if (realEntries.length === 0) {
      console.warn(`[Orders] Finalize ${yest}: Orders API returned no usable rows. NOT writing — preserving prior data.`);
      return;
    }

    const n = await persistOrdersDay(yest, byAsin);
    console.log(`[Orders] Finalized yesterday ${yest}: ${n} ASIN rows written, ${orderCount} orders`);
  } catch (e) {
    console.warn('[Orders] finalize yesterday failed:', e.message);
  }
}

// Trigger historical daily_metrics backfill — responds immediately, runs in background
// Manually trigger the daily data-integrity audit + self-improvement loop.
// Findings + Claude review + proposed code improvements all written to
// audit/history/<date>/ on disk. Returns a summary.
app.post('/api/audit/run', async (req, res) => {
  try {
    const { runDailyAudit } = require('./audit');
    const result = await runDailyAudit(supabase);
    res.json({
      ok: true,
      runDir:          result.runDir,
      findings:        result.audit.findings,
      findingsBySev:   result.audit.findingsBySeverity,
      totals:          result.audit.totals,
      agent: {
        skipped: result.agentResult?.skipped ?? true,
        text:    result.agentResult?.text || null,
      },
      improvements: {
        skipped: result.improvements?.skipped ?? true,
        reason:  result.improvements?.reason || null,
        filesReviewed: result.improvements?.filesReviewed || [],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Image management endpoints ───────────────────────────────────────────────

// Return the full ASIN → imageUrl map. Used by the dashboard to populate
// images independent of which preset is active.
app.get('/api/asins/images', (req, res) => {
  res.json({
    images: imagesByAsin,
    count: Object.keys(imagesByAsin).length,
    lastLoaded: imagesLastLoaded ? new Date(imagesLastLoaded).toISOString() : null,
  });
});

// Manual override — set an image URL for one ASIN. Locks it from automated overwrite.
app.put('/api/asins/:asin/image', async (req, res) => {
  const { asin } = req.params;
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url required in body' });
  try {
    await setImageManual(supabase, asin, url);
    imagesByAsin[asin] = url; // hot-update local cache
    res.json({ ok: true, asin, url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual trigger for catalog API backfill — fetches up to N missing/stale ASINs.
app.post('/api/asins/images/backfill', async (req, res) => {
  if (process.env.SYNC_ENABLED !== 'true') return res.status(403).json({ error: 'SYNC_ENABLED is false' });
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 200);
  res.json({ status: 'started', limit });
  setImmediate(async () => {
    try {
      const { brands } = await loadBrands();
      const result = await backfillMissingImages(supabase, brands, { limit });
      await refreshImagesCache();
      console.log('[Images] Backfill complete:', JSON.stringify(result));
    } catch (e) { console.error('[Images] Backfill error:', e.message); }
  });
});

// One-shot migration — seed asin_images from existing preset_metrics + image-cache.json.
app.post('/api/asins/images/migrate', async (req, res) => {
  try {
    const result = await migrateLegacyImages(supabase);
    await refreshImagesCache();
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Daily ad-spend sync — pulls Amazon Ads with timeUnit:DAILY for a window,
// then upserts spend_cad / spend_usd / attributed_sales_* / ad_clicks /
// ad_impressions / ad_orders per (asin, date) into daily_metrics. Sales/
// refund columns are preserved via Supabase's column-level upsert.
// Persisting clicks/impressions/orders (added 2026-06-30) means reports can
// read them instantly instead of triggering a fresh 1-5 min Ads API bake.
async function syncDailyAdSpend({ windowDays = 30, includeToday = true } = {}) {
  const { pullAdSpendDaily } = require('./sync/ads');
  const today = pstDateStr();
  const endDate = includeToday ? today : pstSubtractDays(today, 1);
  const from    = pstSubtractDays(today, windowDays);
  const merged  = await pullAdSpendDaily(from, endDate);

  const { brands } = await loadBrands();
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  let rowCount = 0;
  for (const [date, asins] of Object.entries(merged)) {
    const rows = Object.entries(asins).map(([asin, d]) => ({
      asin, date,
      brand_id: asinBrand[asin] || 'unknown-brand',
      spend_cad:            Math.round((d.spendCad || 0) * 100) / 100,
      spend_usd:            Math.round((d.spendUsd || 0) * 100) / 100,
      attributed_sales_cad: Math.round((d.salesCad || 0) * 100) / 100,
      attributed_sales_usd: Math.round((d.salesUsd || 0) * 100) / 100,
      ad_clicks:      d.clicks      || 0,
      ad_impressions: d.impressions || 0,
      ad_orders:      d.orders      || 0,
      ntb_sales_cad:  Math.round((d.ntbSalesCad || 0) * 100) / 100,
      ntb_sales_usd:  Math.round((d.ntbSalesUsd || 0) * 100) / 100,
      ntb_orders:     d.ntbOrders   || 0,
      ntb_units:      d.ntbUnits    || 0,
    })).filter(r =>
      r.spend_cad > 0 || r.spend_usd > 0 ||
      r.ad_clicks > 0 || r.ad_impressions > 0 || r.ad_orders > 0
    );
    if (rows.length === 0) continue;
    const { error } = await supabase.from('daily_metrics').upsert(rows, { onConflict: 'asin,date' });
    if (error) console.warn(`[AdsDaily] ${date} upsert error:`, error.message);
    else { rowCount += rows.length; }
  }
  console.log(`[AdsDaily] Wrote ad spend + engagement on ${rowCount} (asin,date) rows`);
  return { rowCount, datesTouched: Object.keys(merged).length };
}

// Manual trigger
app.post('/api/ads/sync-daily', async (req, res) => {
  if (process.env.SYNC_ENABLED !== 'true') return res.status(403).json({ error: 'SYNC_ENABLED is false' });
  const windowDays = Math.min(parseInt(req.query.windowDays || '30', 10), 90);
  res.json({ status: 'started', windowDays });
  setImmediate(async () => {
    try { const r = await syncDailyAdSpend({ windowDays }); console.log('[AdsDaily] Done:', JSON.stringify(r)); }
    catch (e) { console.error('[AdsDaily] Manual sync error:', e.message); }
  });
});

// Manually trigger refund sync. Returns when complete (can take ~5-15 min depending
// on how many fresh refund events). For ad-hoc runs after the initial schema migration.
app.post('/api/refunds/sync', async (req, res) => {
  if (process.env.SYNC_ENABLED !== 'true') {
    return res.status(403).json({ error: 'SYNC_ENABLED is false — refunds sync disabled locally' });
  }
  const windowDays = Math.min(parseInt(req.query.windowDays || '60', 10), 180);
  res.json({ status: 'started', windowDays, message: 'Refund sync running in background — check server logs' });
  setImmediate(async () => {
    try {
      const { syncRefunds } = require('./sync/refunds');
      const { brands } = await loadBrands();
      const r = await syncRefunds(supabase, brands, { windowDays });
      console.log('[Refunds] Manual sync complete:', JSON.stringify(r));
    } catch (e) {
      console.error('[Refunds] Manual sync error:', e.message);
    }
  });
});

app.post('/api/backfill', async (req, res) => {
  if (process.env.SYNC_ENABLED !== 'true') {
    return res.status(403).json({ error: 'SYNC_ENABLED is false — backfill disabled locally' });
  }
  const { backfillDays, isBackfillRunning } = require('./sync/backfill');
  if (isBackfillRunning()) {
    return res.json({ status: 'already_running', message: 'A backfill job is already in progress — wait for it to complete' });
  }
  const limit = Math.min(parseInt(req.query.limit || '7', 10), 7);
  res.json({ status: 'started', limit, message: 'Backfill running in background — check server logs for progress' });
  setImmediate(async () => {
    try {
      const { brands } = await loadBrands();
      const result = await backfillDays(supabase, brands, limit);
      console.log('[Backfill] Complete:', JSON.stringify(result));
    } catch (err) {
      console.error('[Backfill] Error:', err.message);
    }
  });
});

// Shared aggregation: builds per-brand summary + skus + financials from daily_metrics
// for any date range. Used by /api/metrics (live request) AND by the preset rebuild
// (which corrects the cached preset_metrics summaries that were drifting from
// daily_metrics). The aggregation is the canonical "what does daily_metrics say"
// computation — anything else that needs per-brand totals should call this.
async function buildBrandMetricsForRange(from, to, presetKey = null) {
  const { brands } = await loadBrands();
  const pm = await loadPresetMetrics();

    // Paginate explicitly — Supabase caps responses at 1000 rows by default.
    // A 30-day window with ~400 rows/day = 12k rows; without pagination we'd
    // silently truncate and dramatically under-report totals.
    const PAGE = 1000;
    const rows = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('daily_metrics')
        .select('*')
        .gte('date', from)
        .lte('date', to)
        .order('date', { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(error.message);
      if (!data || data.length === 0) break;
      rows.push(...data);
      if (data.length < PAGE) break;
      offset += PAGE;
      if (offset > 100000) { console.warn('[Metrics] Pagination safety cap hit'); break; }
    }

    // Sum all fields per ASIN across days
    const byAsin = {};
    for (const row of (rows || [])) {
      if (!byAsin[row.asin]) {
        byAsin[row.asin] = {
          brand_id: row.brand_id,
          units: 0, units_ca: 0, units_us: 0,
          revenue_cad: 0, revenue_usd: 0,
          sessions: 0, page_views: 0,
          bb_sum: 0, bb_count: 0,
          spend_cad: 0, spend_usd: 0,
          attr_sales_cad: 0, attr_sales_usd: 0,
          ad_clicks: 0, ad_impressions: 0, ad_orders: 0,
          ntb_sales_cad: 0, ntb_sales_usd: 0, ntb_orders: 0, ntb_units: 0,
          inv_onhand: null, inv_inbound: null,
        };
      }
      const a = byAsin[row.asin];
      a.units       += row.units       || 0;
      a.units_ca    += row.units_ca    || 0;
      a.units_us    += row.units_us    || 0;
      a.revenue_cad += row.revenue_cad || 0;
      a.revenue_usd += row.revenue_usd || 0;
      a.spend_cad      += row.spend_cad             || 0;
      a.spend_usd      += row.spend_usd             || 0;
      a.attr_sales_cad += row.attributed_sales_cad  || 0;
      a.attr_sales_usd += row.attributed_sales_usd  || 0;
      a.ad_clicks      += row.ad_clicks             || 0;
      a.ad_impressions += row.ad_impressions        || 0;
      a.ad_orders      += row.ad_orders             || 0;
      a.ntb_sales_cad  += row.ntb_sales_cad         || 0;
      a.ntb_sales_usd  += row.ntb_sales_usd         || 0;
      a.ntb_orders     += row.ntb_orders            || 0;
      a.ntb_units      += row.ntb_units             || 0;
      a.refunded_units     = (a.refunded_units     || 0) + (row.refunded_units    || 0);
      a.refund_amount_cad  = (a.refund_amount_cad  || 0) + (row.refund_amount_cad || 0);
      a.refund_amount_usd  = (a.refund_amount_usd  || 0) + (row.refund_amount_usd || 0);
      a.refund_count       = (a.refund_count       || 0) + (row.refund_count     || 0);
      if (row.sessions    != null) a.sessions    += row.sessions;
      if (row.page_views  != null) a.page_views  += row.page_views;
      if (row.buy_box_pct != null) { a.bb_sum += row.buy_box_pct; a.bb_count++; }
      // Use latest inventory snapshot in window
      if (row.inventory_on_hand != null) a.inv_onhand = row.inventory_on_hand;
      if (row.inventory_inbound != null) a.inv_inbound = row.inventory_inbound;
    }

    function lookupSkuMeta(brandId, asin) {
      for (const key of ['last30d', 'last7d', 'lastMonth', 'mtd', 'yesterday']) {
        const sku = (pm.presets?.[key]?.brands?.[brandId]?.skus || []).find(s => s.asin === asin);
        if (sku && (sku.title || sku.imageUrl)) return sku;
      }
      return {};
    }

    function buildSku(asin, brandId, a, title) {
      const spendTotal = (a.spend_cad || 0) + (a.spend_usd || 0);
      const attrTotal  = (a.attr_sales_cad || 0) + (a.attr_sales_usd || 0);
      const clicks     = a.ad_clicks      || 0;
      const impressions= a.ad_impressions || 0;
      const adOrders   = a.ad_orders      || 0;
      const ntbSalesTotal = (a.ntb_sales_cad || 0) + (a.ntb_sales_usd || 0);
      const ntbOrders     = a.ntb_orders || 0;
      const ntbUnits      = a.ntb_units  || 0;
      return {
        asin,
        title,
        units:      a.units,
        unitsCa:    a.units_ca, unitsUs: a.units_us,
        unitsCad:   a.units_ca, unitsUsd: a.units_us,
        revenueCad: Math.round(a.revenue_cad * 100) / 100,
        revenueUsd: Math.round(a.revenue_usd * 100) / 100,
        sessions:   a.sessions   || null,
        pageViews:  a.page_views || null,
        buyBox:     a.bb_count > 0 ? Math.round(a.bb_sum / a.bb_count * 100) / 100 : null,
        cvr:        (a.units && a.sessions) ? Math.round(a.units / a.sessions * 10000) / 100 : null,
        spendCad:           Math.round((a.spend_cad || 0) * 100) / 100,
        spendUsd:           Math.round((a.spend_usd || 0) * 100) / 100,
        attributedSalesCad: Math.round((a.attr_sales_cad || 0) * 100) / 100,
        attributedSalesUsd: Math.round((a.attr_sales_usd || 0) * 100) / 100,
        adClicks:      clicks      || null,
        adImpressions: impressions || null,
        adOrders:      adOrders    || null,
        ntbSalesCad:   Math.round((a.ntb_sales_cad || 0) * 100) / 100,
        ntbSalesUsd:   Math.round((a.ntb_sales_usd || 0) * 100) / 100,
        ntbOrders:     ntbOrders   || null,
        ntbUnits:      ntbUnits    || null,
        ntbSalesPct:   attrTotal > 0   ? Math.round(ntbSalesTotal / attrTotal * 10000) / 100 : null,
        ntbOrdersPct:  adOrders > 0    ? Math.round(ntbOrders / adOrders * 10000) / 100 : null,
        acos: (spendTotal > 0 && attrTotal > 0) ? Math.round(spendTotal / attrTotal * 10000) / 100 : null,
        roas: spendTotal > 0 ? Math.round(attrTotal / spendTotal * 100) / 100 : null,
        ctr:  impressions > 0 ? Math.round(clicks / impressions * 100000) / 1000 : null,
        cpc:  clicks > 0      ? Math.round(spendTotal / clicks * 10000) / 10000 : null,
        adCvr: clicks > 0     ? Math.round(adOrders / clicks * 10000) / 100 : null,
        inventory: a.inv_onhand != null ? { onHand: a.inv_onhand, inbound: a.inv_inbound || 0 } : null,
        marketplaces: [...((a.units_ca||0) > 0 ? ['CA'] : []), ...((a.units_us||0) > 0 ? ['US'] : [])],
        imageUrl: imagesByAsin[asin] || null,
      };
    }

    // Build brand-keyed result — same shape as preset_metrics brands
    const resultBrands = {};
    const mappedAsins = new Set();
    for (const brand of brands) {
      let bUnits=0, bUnitsCa=0, bUnitsUs=0, bRevCad=0, bRevUsd=0, bSessions=0, bPageViews=0;
      let bSpendCad=0, bSpendUsd=0, bAttrCad=0, bAttrUsd=0;
      let bAdClicks=0, bAdImpressions=0, bAdOrders=0;
      let bNtbSalesCad=0, bNtbSalesUsd=0, bNtbOrders=0, bNtbUnits=0;
      let bRefundedUnits=0, bRefundCad=0, bRefundUsd=0, bRefundCount=0;
      const buyBoxSamples = [];
      const skus = [];

      for (const asin of (brand.asins || [])) {
        mappedAsins.add(asin);
        const a = byAsin[asin];
        if (!a) continue;
        const meta = lookupSkuMeta(brand.id, asin);
        const sku = buildSku(asin, brand.id, a, meta.title || brand.asinTitles?.[asin] || '');
        sku.imageUrl = imagesByAsin[asin] || meta.imageUrl || null;
        skus.push(sku);
        bUnits += a.units; bUnitsCa += a.units_ca; bUnitsUs += a.units_us;
        bRevCad += a.revenue_cad; bRevUsd += a.revenue_usd;
        bSessions += a.sessions; bPageViews += a.page_views;
        bSpendCad += a.spend_cad; bSpendUsd += a.spend_usd;
        bAttrCad += a.attr_sales_cad; bAttrUsd += a.attr_sales_usd;
        bAdClicks      += a.ad_clicks      || 0;
        bAdImpressions += a.ad_impressions || 0;
        bAdOrders      += a.ad_orders      || 0;
        bNtbSalesCad   += a.ntb_sales_cad  || 0;
        bNtbSalesUsd   += a.ntb_sales_usd  || 0;
        bNtbOrders     += a.ntb_orders     || 0;
        bNtbUnits      += a.ntb_units      || 0;
        bRefundedUnits += a.refunded_units    || 0;
        bRefundCad     += a.refund_amount_cad || 0;
        bRefundUsd     += a.refund_amount_usd || 0;
        bRefundCount   += a.refund_count      || 0;
        if (sku.buyBox != null) buyBoxSamples.push(sku.buyBox);
      }

      if (!skus.length) continue;
      const avgBuyBox = buyBoxSamples.length
        ? Math.round(buyBoxSamples.reduce((s, v) => s + v, 0) / buyBoxSamples.length * 100) / 100
        : null;
      const stSummary = pm.presets?.yesterday?.brands?.[brand.id]?.summary || {};

      resultBrands[brand.id] = {
        summary: {
          units:    bUnits,
          unitsCa:  bUnitsCa, unitsUs: bUnitsUs,
          unitsCad: bUnitsCa, unitsUsd: bUnitsUs,
          revenueCad: Math.round(bRevCad * 100) / 100,
          revenueUsd: Math.round(bRevUsd * 100) / 100,
          sessions:   bSessions   || null,
          pageViews:  bPageViews  || null,
          buyBox:     avgBuyBox,
          avgCvr:     (bUnits && bSessions) ? Math.round(bUnits / bSessions * 10000) / 100 : null,
          refundedUnits:  bRefundedUnits,
          refundAmountCad: Math.round(bRefundCad * 100) / 100,
          refundAmountUsd: Math.round(bRefundUsd * 100) / 100,
          refundCount:    bRefundCount,
          adSummary:  (bSpendCad + bSpendUsd) > 0 || bAdClicks > 0 || bAdImpressions > 0 ? (() => {
            const totalSpend = bSpendCad + bSpendUsd;
            const totalAttr  = bAttrCad + bAttrUsd;
            const totalNtb   = bNtbSalesCad + bNtbSalesUsd;
            const totalRev   = bRevCad + bRevUsd;
            return {
              spendCad:           Math.round(bSpendCad * 100) / 100,
              spendUsd:           Math.round(bSpendUsd * 100) / 100,
              attributedSalesCad: Math.round(bAttrCad * 100) / 100,
              attributedSalesUsd: Math.round(bAttrUsd * 100) / 100,
              clicks:      bAdClicks,
              impressions: bAdImpressions,
              orders:      bAdOrders,
              // NTB (New-To-Brand)
              ntbSalesCad:  Math.round(bNtbSalesCad * 100) / 100,
              ntbSalesUsd:  Math.round(bNtbSalesUsd * 100) / 100,
              ntbOrders:    bNtbOrders,
              ntbUnits:     bNtbUnits,
              ntbSalesPct:  totalAttr > 0 ? Math.round(totalNtb / totalAttr * 10000) / 100 : null,
              ntbOrdersPct: bAdOrders > 0 ? Math.round(bNtbOrders / bAdOrders * 10000) / 100 : null,
              acos:  totalAttr > 0  ? Math.round(totalSpend / totalAttr * 10000) / 100 : null,
              roas:  totalSpend > 0 ? Math.round(totalAttr / totalSpend * 100) / 100 : null,
              // TACOS / TROAS: ad spend vs TOTAL sales (organic + ad-attributed).
              // Merchant Spring exposes these — they tell you ad cost as a share of
              // your whole business, not just the ad-driven slice.
              tacos: totalRev > 0   ? Math.round(totalSpend / totalRev * 10000) / 100 : null,
              troas: totalSpend > 0 ? Math.round(totalRev / totalSpend * 100) / 100 : null,
              ctr:   bAdImpressions > 0 ? Math.round(bAdClicks / bAdImpressions * 100000) / 1000 : null,
              cpc:   bAdClicks > 0      ? Math.round(totalSpend / bAdClicks * 10000) / 10000 : null,
              adCvr: bAdClicks > 0      ? Math.round(bAdOrders / bAdClicks * 10000) / 100 : null,
            };
          })() : null,
          alerts: stSummary.alerts || {},
        },
        skus,
      };
    }

    // Safety net: roll any unmapped ASINs into unknown-brand
    let uUnits=0, uCa=0, uUs=0, uRevCad=0, uRevUsd=0;
    const uSkus = [];
    for (const [asin, a] of Object.entries(byAsin)) {
      if (mappedAsins.has(asin)) continue;
      if (!a.units && !a.revenue_cad && !a.revenue_usd) continue;
      uUnits += a.units; uCa += a.units_ca; uUs += a.units_us;
      uRevCad += a.revenue_cad; uRevUsd += a.revenue_usd;
      uSkus.push(buildSku(asin, 'unknown-brand', a, ''));
    }
    if (uSkus.length > 0) {
      resultBrands['unknown-brand'] = {
        summary: {
          units: uUnits,
          unitsCa: uCa, unitsUs: uUs,
          unitsCad: uCa, unitsUsd: uUs,
          revenueCad: Math.round(uRevCad * 100) / 100,
          revenueUsd: Math.round(uRevUsd * 100) / 100,
          sessions: null, buyBox: null, avgCvr: null, adSummary: null, alerts: {},
        },
        skus: uSkus,
      };
    }

    // Top-level financials block — what the tile renderer reads to compute
    // refunds, ad cost, profit. Ad spend + refunds come from daily_metrics
    // (authoritative per-day). amazonFees + serviceFees still come from the
    // preset_metrics cache via passthrough (S&T-sourced financial events).
    let topSpendCad=0, topSpendUsd=0, topRefundCad=0, topRefundUsd=0, topRefundCount=0;
    for (const a of Object.values(byAsin)) {
      topSpendCad     += a.spend_cad           || 0;
      topSpendUsd     += a.spend_usd           || 0;
      topRefundCad    += a.refund_amount_cad   || 0;
      topRefundUsd    += a.refund_amount_usd   || 0;
      topRefundCount  += a.refund_count        || 0;
    }
    const passthrough = pm.presets?.[presetKey]?.financials || {};
    const financials = {
      CAD: {
        adSpend:      Math.round(topSpendCad * 100) / 100,
        refundAmount: Math.round(topRefundCad * 100) / 100,
        amazonFees:   passthrough.CAD?.amazonFees   || 0,
        serviceFees:  passthrough.CAD?.serviceFees  || 0,
        refundFees:   passthrough.CAD?.refundFees   || 0,
        breakdown:    passthrough.CAD?.breakdown    || {},
      },
      USD: {
        adSpend:      Math.round(topSpendUsd * 100) / 100,
        refundAmount: Math.round(topRefundUsd * 100) / 100,
        amazonFees:   passthrough.USD?.amazonFees   || 0,
        serviceFees:  passthrough.USD?.serviceFees  || 0,
        refundFees:   passthrough.USD?.refundFees   || 0,
        breakdown:    passthrough.USD?.breakdown    || {},
      },
      refundCount: topRefundCount,
    };

    const fmtD = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    return {
      from, to,
      label: `${fmtD(from)} – ${fmtD(to)}`,
      startDate: from, endDate: to,
      brands: resultBrands,
      financials,
    };
}

// Thin wrapper — keep the route stable while the aggregation is callable from sync code too.
app.get('/api/metrics', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to params required (YYYY-MM-DD)' });
  }
  if (from > to) return res.status(400).json({ error: 'from must be ≤ to' });
  try {
    const result = await buildBrandMetricsForRange(from, to, req.query.presetKey);
    res.json(result);
  } catch (err) {
    console.error('[Metrics] Custom range error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rebuild preset_metrics summaries from daily_metrics. Fixes drift between the
// S&T-sourced preset cache (which silently fails for many brands → $0 on brand
// cards) and the live daily_metrics totals (which the report uses). Per-brand
// summary + sales/traffic SKU fields get overwritten; ad clicks/impressions/
// orders (not yet in daily_metrics) and metadata (titles, image URLs) are
// preserved from the existing cache.
async function rebuildPresetSummariesFromDaily(tag = 'PresetRebuild') {
  const { getPresetRanges } = require('./sync/amazon');
  const ranges = getPresetRanges();

  const existingPm = await loadPresetMetrics();
  const updatedPresets = { ...(existingPm.presets || {}) };

  for (const [presetKey, range] of Object.entries(ranges)) {
    const from = range.startDate, to = range.endDate;
    console.log(`[${tag}] Rebuilding ${presetKey} (${from} → ${to})...`);

    const built = await buildBrandMetricsForRange(from, to, presetKey);
    const existingPreset = existingPm.presets?.[presetKey] || { brands: {} };
    const mergedBrands = {};

    // Preserve ad fields (clicks/impressions/orders/cpc/ctr/adCvr) — those aren't
    // in daily_metrics yet (see Build Log: "Extend daily + 15-min ad syncs to
    // persist clicks, impressions, orders"). Until that ships, the Ads merge
    // step in runFullSync is the only source of those values.
    for (const [brandId, newBm] of Object.entries(built.brands || {})) {
      const oldBm = existingPreset.brands?.[brandId] || {};
      const oldSkuByAsin = Object.fromEntries((oldBm.skus || []).map(s => [s.asin, s]));

      const mergedSkus = (newBm.skus || []).map(newSku => {
        const oldSku = oldSkuByAsin[newSku.asin] || {};
        return {
          ...newSku,
          // Prefer daily_metrics-sourced ad fields (now persisted as of
          // 2026-06-30 migration); fall back to cached values only when
          // daily_metrics has no data for that ASIN.
          adClicks:      newSku.adClicks      ?? oldSku.adClicks      ?? null,
          adImpressions: newSku.adImpressions ?? oldSku.adImpressions ?? null,
          adOrders:      newSku.adOrders      ?? oldSku.adOrders      ?? null,
          cpc:           newSku.cpc           ?? oldSku.cpc           ?? null,
          ctr:           newSku.ctr           ?? oldSku.ctr           ?? null,
          adCvr:         newSku.adCvr         ?? oldSku.adCvr         ?? null,
          acos:          newSku.acos          ?? oldSku.acos          ?? null,
          roas:          newSku.roas          ?? oldSku.roas          ?? null,
          // Metadata: prefer existing title/image (set during SP-API listings sync)
          title:         oldSku.title || newSku.title || '',
          imageUrl:      oldSku.imageUrl || newSku.imageUrl || null,
          // Listing status from existing (set by listings sync)
          status:        oldSku.status || 'active',
          sellerSku:     oldSku.sellerSku || '',
          marketplace:   oldSku.marketplace || newSku.marketplace || 'CA',
        };
      });

      // Merge brand adSummary: prefer daily_metrics-sourced values (now
      // including clicks/impressions/orders), fall back to old cache only
      // when daily_metrics has nothing for that brand.
      const oldAd = oldBm.summary?.adSummary || null;
      const newAd = newBm.summary?.adSummary || null;
      let mergedAd = null;
      if (newAd) {
        mergedAd = {
          ...newAd,
          clicks:      newAd.clicks      ?? oldAd?.clicks      ?? null,
          impressions: newAd.impressions ?? oldAd?.impressions ?? null,
          orders:      newAd.orders      ?? oldAd?.orders      ?? null,
          acos:        newAd.acos        ?? oldAd?.acos        ?? null,
          roas:        newAd.roas        ?? oldAd?.roas        ?? null,
          ctr:         newAd.ctr         ?? oldAd?.ctr         ?? null,
          cpc:         newAd.cpc         ?? oldAd?.cpc         ?? null,
          adCvr:       newAd.adCvr       ?? oldAd?.adCvr       ?? null,
        };
      } else if (oldAd) {
        mergedAd = oldAd;
      }

      mergedBrands[brandId] = {
        summary: {
          ...newBm.summary,
          adSummary: mergedAd,
          // Preserve alerts (suppressedListings, lostBuyBox) — set by listings sync
          alerts: oldBm.summary?.alerts || newBm.summary?.alerts || {},
        },
        skus: mergedSkus,
      };
    }

    // Carry forward any brands present in the old preset that the new aggregation
    // didn't produce (rare — usually means no daily_metrics rows for that brand).
    for (const [brandId, oldBm] of Object.entries(existingPreset.brands || {})) {
      if (!mergedBrands[brandId]) mergedBrands[brandId] = oldBm;
    }

    updatedPresets[presetKey] = {
      ...existingPreset,
      label:     range.label,
      startDate: range.startDate,
      endDate:   range.endDate,
      brands:    mergedBrands,
    };
  }

  await savePresetMetrics({ ...existingPm, presets: updatedPresets });
  console.log(`[${tag}] Done — ${Object.keys(ranges).length} presets rebuilt from daily_metrics`);
  return { rebuilt: Object.keys(ranges) };
}

// Manual trigger: rebuild preset summaries from daily_metrics without running a full sync.
// Useful for verifying the fix without burning SP-API quota.
app.post('/api/sync/rebuild-presets', async (req, res) => {
  try {
    const result = await rebuildPresetSummariesFromDaily('ManualRebuild');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[ManualRebuild] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Brand report config (per-brand section toggles) ───────────────────────────
// Phase 1 — Stream B1. Lets each brand hide specific sections of the brand
// report. Default = nothing hidden (every section visible). Section keys
// are advisory — the renderer ignores ones it doesn't know about, so adding
// a new section in code is safe without a migration.
//
// Schema (sql/brand-report-configs.sql):
//   brand_id (PK), hidden_sections (jsonb array of strings), updated_at

const REPORT_SECTION_KEYS = [
  'executive_summary',    // AI-generated narrative
  'headline_tiles',       // revenue/units/sessions/CVR/buy box
  'sales_trend',          // 30-day daily chart vs comparison
  'ytd_chart',            // current year vs prior year
  'sales_by_group',       // product-group breakouts (v2 — needs grouping)
  'top_sellers',          // per-product table with inventory chips
  'ad_trend',             // ad sales vs organic chart
  'ad_summary',           // TACOS / TROAS / NTB / ACOS / CTR / CPC
  'inventory_status',     // days of cover, stockouts, inbound
  'per_asin_sheet_link',  // auto-generated Google Sheet link
];

function defaultBrandReportConfig(brandId) {
  return { brand_id: brandId, hidden_sections: [], updated_at: null };
}

// GET — return a brand's config, or defaults if no row.
app.get('/api/brand-report-config/:brandId', async (req, res) => {
  const { brandId } = req.params;
  try {
    const { data, error } = await supabase
      .from('brand_report_configs')
      .select('brand_id, hidden_sections, updated_at')
      .eq('brand_id', brandId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    res.json({
      ...defaultBrandReportConfig(brandId),
      ...(data || {}),
      available_sections: REPORT_SECTION_KEYS,
    });
  } catch (err) {
    console.error('[BrandReportConfig] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT — upsert. Body: { hidden_sections: ['ytd_chart', 'ad_trend', ...] }
// Unknown keys are tolerated (renderer ignores them); we just normalize
// and persist whatever the caller sent.
app.put('/api/brand-report-config/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const body = req.body || {};
  if (!Array.isArray(body.hidden_sections)) {
    return res.status(400).json({ error: 'hidden_sections must be an array of strings' });
  }
  const hidden = [...new Set(body.hidden_sections.filter(s => typeof s === 'string'))];
  try {
    const { brands } = await loadBrands();
    if (!brands.find(b => b.id === brandId)) {
      return res.status(404).json({ error: `Brand '${brandId}' not found` });
    }
    const { data, error } = await supabase
      .from('brand_report_configs')
      .upsert(
        { brand_id: brandId, hidden_sections: hidden, updated_at: new Date().toISOString() },
        { onConflict: 'brand_id' }
      )
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ success: true, ...data, available_sections: REPORT_SECTION_KEYS });
  } catch (err) {
    console.error('[BrandReportConfig] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// One-shot: insert an empty config row for every brand that doesn't already
// have one. Idempotent — re-running is safe. Useful after the initial
// migration so every brand has a row even if nobody's toggled anything.
app.post('/api/brand-report-config/seed-defaults', async (req, res) => {
  try {
    const { brands } = await loadBrands();
    const realBrands = brands.filter(b => b.id && b.id !== 'unknown-brand');
    if (!realBrands.length) return res.json({ seeded: 0, message: 'no brands to seed' });

    const { data: existing, error: readErr } = await supabase
      .from('brand_report_configs')
      .select('brand_id');
    if (readErr) throw new Error(readErr.message);

    const have = new Set((existing || []).map(r => r.brand_id));
    const missing = realBrands.filter(b => !have.has(b.id));
    if (missing.length === 0) {
      return res.json({ seeded: 0, message: 'all brands already have configs' });
    }
    const rows = missing.map(b => ({
      brand_id: b.id,
      hidden_sections: [],
      updated_at: new Date().toISOString(),
    }));
    const { error: insertErr } = await supabase
      .from('brand_report_configs')
      .insert(rows);
    if (insertErr) throw new Error(insertErr.message);
    res.json({ seeded: rows.length, brand_ids: rows.map(r => r.brand_id) });
  } catch (err) {
    console.error('[BrandReportConfig] seed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AI executive summary (Phase 2 slice 2.3) ─────────────────────────────────
// Generates a 2-3 paragraph narrative summary in Mike's voice using Claude.
// Cached per (brand_id, period_from, period_to) in brand_report_summaries so
// repeated views don't burn API tokens. When the table is missing, the code
// degrades to "regenerate every call" — so the migration is non-blocking.

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

async function trySelectSummary(brandId, fromS, toS) {
  try {
    const { data, error } = await supabase
      .from('brand_report_summaries')
      .select('summary_text, edited, generated_at, updated_at')
      .eq('brand_id', brandId).eq('period_from', fromS).eq('period_to', toS)
      .maybeSingle();
    if (error) {
      // Missing table → undefined column → silently return null (caller will
      // regenerate). Real errors still bubble up.
      if (String(error.message).match(/relation .* does not exist|brand_report_summaries/i)) return null;
      throw new Error(error.message);
    }
    return data;
  } catch (e) {
    console.warn('[Summary] cache read skipped:', e.message);
    return null;
  }
}

async function trySaveSummary(row) {
  try {
    const { error } = await supabase
      .from('brand_report_summaries')
      .upsert(row, { onConflict: 'brand_id,period_from,period_to' });
    if (error && !String(error.message).match(/relation .* does not exist/i)) throw new Error(error.message);
  } catch (e) {
    console.warn('[Summary] cache write skipped:', e.message);
  }
}

function buildSummaryPrompt(dataset) {
  const s   = dataset.summary || {};
  const sp  = dataset.summaryPrev || {};
  const ad  = s.adSummary || {};
  const products = (dataset.products || []).filter(p => (p.revenueCad + p.revenueUsd) > 0);

  // Top product by combined revenue.
  const top = [...products].sort((a, b) => (b.revenueCad + b.revenueUsd) - (a.revenueCad + a.revenueUsd))[0];

  // Best mover by unit growth vs prior period (require both non-zero to avoid div/0).
  const movers = products
    .filter(p => p.prev?.units > 0 && p.units > 0 && p.units !== p.prev.units)
    .map(p => ({ p, growth: (p.units - p.prev.units) / p.prev.units }))
    .sort((a, b) => b.growth - a.growth);
  const mover = movers[0]?.p;
  const moverGrowth = movers[0] ? Math.round(movers[0].growth * 1000) / 10 : null;

  // Period deltas
  const pct = (curr, prev) => (!prev || prev === 0) ? null : Math.round((curr - prev) / prev * 1000) / 10;
  const totalRev = (s.revenueCad || 0) + (s.revenueUsd || 0);
  const totalPrev = (sp.revenueCad || 0) + (sp.revenueUsd || 0);
  const revGrowth   = pct(totalRev, totalPrev);
  const unitsGrowth = pct(s.units,  sp.units);
  const cvr = s.sessions ? Math.round(s.units / s.sessions * 1000) / 10 : null;

  const facts = [
    `Brand: ${dataset.brand.name}`,
    `Period: ${dataset.period.label}`,
    `Comparison period: ${dataset.comparison.label}`,
    ``,
    `Revenue: $${Math.round(s.revenueCad || 0).toLocaleString()} CAD${s.revenueUsd ? ` and $${Math.round(s.revenueUsd).toLocaleString()} USD` : ''} (${revGrowth != null ? (revGrowth >= 0 ? '+' : '') + revGrowth + '%' : 'no prior comparison'} vs prior period)`,
    `Units sold: ${(s.units || 0).toLocaleString()} (${unitsGrowth != null ? (unitsGrowth >= 0 ? '+' : '') + unitsGrowth + '%' : 'no prior comparison'})`,
    `Sessions: ${(s.sessions || 0).toLocaleString()}, conversion rate ${cvr != null ? cvr + '%' : 'n/a'}`,
    `Buy Box %: ${s.buyBox != null ? s.buyBox.toFixed(1) + '%' : 'n/a'}`,
  ];

  if (ad.spendCad != null || ad.spendUsd != null) {
    const spendTotal = (ad.spendCad || 0) + (ad.spendUsd || 0);
    facts.push(``);
    facts.push(`Ad spend: $${Math.round(spendTotal).toLocaleString()}, TACOS ${ad.tacos != null ? ad.tacos + '%' : 'n/a'}, ACOS ${ad.acos != null ? ad.acos + '%' : 'n/a'}, ROAS ${ad.roas != null ? ad.roas.toFixed(2) + 'x' : 'n/a'}`);
    if (ad.ntbSalesPct != null) {
      facts.push(`New-to-Brand: ${ad.ntbSalesPct}% of ad sales (${(ad.ntbOrders || 0).toLocaleString()} orders, $${Math.round(((ad.ntbSalesCad || 0) + (ad.ntbSalesUsd || 0))).toLocaleString()})`);
    }
  }

  if (top) {
    facts.push(``);
    const topRev = (top.revenueCad || 0) + (top.revenueUsd || 0);
    facts.push(`Top product: ${top.title || top.asin} — $${Math.round(topRev).toLocaleString()} from ${(top.units || 0).toLocaleString()} units, CVR ${top.cvr != null ? top.cvr + '%' : 'n/a'}, Buy Box ${top.buyBox != null ? top.buyBox + '%' : 'n/a'}`);
  }
  if (mover && mover !== top && moverGrowth != null) {
    facts.push(`Notable mover: ${mover.title || mover.asin} — ${moverGrowth >= 0 ? '+' : ''}${moverGrowth}% unit growth vs prior period (${mover.prev.units} → ${mover.units} units)`);
  }

  // Inventory issues worth flagging
  const lowStock = (dataset.products || []).filter(p => p.inventory?.onHand != null && p.inventory.onHand < 30 && p.units > 0);
  if (lowStock.length) {
    facts.push(``);
    facts.push(`Inventory note: ${lowStock.length} active SKU${lowStock.length === 1 ? '' : 's'} currently below 30 units on hand (low/out): ${lowStock.slice(0, 3).map(p => (p.title || p.asin).slice(0, 40)).join('; ')}${lowStock.length > 3 ? '…' : ''}`);
  }

  return `You are writing the executive summary section of a monthly Amazon performance report. The report is sent by Rocky Mountain Co. (RMC) — an Amazon accelerator that buys inventory wholesale and resells on Amazon — to a brand they manage.

VOICE: Professional, technical, approachable. Mike Sieben's voice: direct, concise, NO hype, NO corporate fluff, NO emojis, NO marketing language like "exciting" / "amazing" / "incredible". Give context and drivers, not just numbers. Trust the reader knows e-commerce. Write like a smart analyst briefing a peer.

STRUCTURE: 2-3 short paragraphs. NO headings. NO bullet lists. NO "Here is the summary:" preamble. Just the paragraphs. The first paragraph leads with the headline numbers and what drove them. The second covers product-level callouts (top product, emerging mover, inventory issues). The third covers advertising performance and a brief forward outlook (one sentence — what's the next signal to watch).

DO NOT speculate about events you don't know about (Prime Day dates, holiday calendars, etc). Stick to the data provided.

DATA:
${facts.join('\n')}

Write the summary now.`;
}

async function callClaudeForSummary(prompt) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — add it to Render env vars to enable AI summaries');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages:   [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 400)}`);
  }
  const body = await res.json();
  const text = (body.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  if (!text) throw new Error('Anthropic returned no text content');
  return text;
}

// Resolve from/to from explicit query params OR a named preset, matching the
// dataset endpoint's resolution so cache lookups stay aligned.
function resolveSummaryRange(req) {
  const msDay = 86400000;
  const fmtISO = d => d.toISOString().split('T')[0];
  const todayStr = fmtISO(new Date());
  let toStr   = req.query.to;
  let fromStr = req.query.from;
  if (!toStr) toStr = todayStr;
  if (!fromStr) {
    const days = ({ last7d: 7, last14d: 14, last30d: 30, last90d: 90 })[req.query.period || 'last30d'] || 30;
    fromStr = fmtISO(new Date(new Date(toStr) - (days - 1) * msDay));
  }
  return { from: fromStr, to: toStr };
}

// GET — returns cached summary or null if none exists yet.
app.get('/api/brand-report-summary/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const { from, to } = resolveSummaryRange(req);
  try {
    const row = await trySelectSummary(brandId, from, to);
    res.json({ brand_id: brandId, period_from: from, period_to: to, ...(row || { summary_text: null, edited: false }) });
  } catch (err) {
    console.error('[Summary] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST — generates a fresh summary via Claude. Pass ?force=true to regenerate
// over a previously-saved one (caution: clobbers edited content).
app.post('/api/brand-report-summary/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const { from, to } = resolveSummaryRange(req);
  const force = req.query.force === 'true';

  try {
    // Respect edited cache unless force=true
    if (!force) {
      const cached = await trySelectSummary(brandId, from, to);
      if (cached?.edited && cached.summary_text) {
        return res.json({ brand_id: brandId, period_from: from, period_to: to, ...cached, from_cache: true });
      }
    }

    // Pull the dataset (reuse the same internal logic). We hit the local
    // endpoint via fetch — simpler than refactoring the route handler into
    // a callable, and the localhost roundtrip is sub-millisecond.
    const port = process.env.PORT || 3000;
    const dsRes = await fetch(`http://localhost:${port}/api/brand-report-dataset/${encodeURIComponent(brandId)}?from=${from}&to=${to}`);
    if (!dsRes.ok) throw new Error(`Dataset fetch failed: ${dsRes.status}`);
    const dataset = await dsRes.json();
    if (dataset.error) throw new Error(dataset.error);

    const prompt = buildSummaryPrompt(dataset);
    const text   = await callClaudeForSummary(prompt);
    const now    = new Date().toISOString();

    await trySaveSummary({
      brand_id: brandId, period_from: from, period_to: to,
      summary_text: text, edited: false,
      generated_at: now, updated_at: now,
    });

    res.json({ brand_id: brandId, period_from: from, period_to: to, summary_text: text, edited: false, generated_at: now, updated_at: now });
  } catch (err) {
    console.error('[Summary] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT — save an edited summary. Marks edited=true so future POSTs without
// force=true won't clobber it.
app.put('/api/brand-report-summary/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const { from, to } = resolveSummaryRange(req);
  const text = (req.body || {}).summary_text;
  if (typeof text !== 'string') return res.status(400).json({ error: 'summary_text (string) required in body' });
  try {
    const now = new Date().toISOString();
    await trySaveSummary({
      brand_id: brandId, period_from: from, period_to: to,
      summary_text: text, edited: true, updated_at: now,
    });
    res.json({ brand_id: brandId, period_from: from, period_to: to, summary_text: text, edited: true, updated_at: now });
  } catch (err) {
    console.error('[Summary] PUT error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Unified brand report dataset (Stream B2) ─────────────────────────────────
// One endpoint, one response. Replaces /api/report-data + /api/report-ads for
// new consumers (Phase 2 PDF, Phase 3 UI, Phase 4 internal agent, Phase 5
// auto-generated reports). Reads per-brand hidden_sections from B1's config
// table and exposes enabled_sections in the response so consumers can render
// without per-section conditionals.
//
// Ads are no longer baked on-demand here — they come from daily_metrics
// (which the ad-sync cron persists), so this endpoint returns in milliseconds
// instead of the 1-5 min /api/report-ads bake.
app.get('/api/brand-report-dataset/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const msDay = 86400000;
  const fmtISO  = d => d.toISOString().split('T')[0];
  const fmtLabel = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US',
    { month: 'short', day: 'numeric', year: 'numeric' });

  try {
    // ── 1. Resolve brand
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: `Brand '${brandId}' not found` });

    // ── 2. Resolve period: explicit from/to OR named preset (last7d/last30d/last90d)
    const todayStr = fmtISO(new Date());
    let toStr   = req.query.to;
    let fromStr = req.query.from;
    if (!toStr)   toStr   = todayStr;
    if (!fromStr) {
      const days = ({ last7d: 7, last14d: 14, last30d: 30, last90d: 90 })[req.query.period || 'last30d'] || 30;
      fromStr = fmtISO(new Date(new Date(toStr) - (days - 1) * msDay));
    }

    const periodDays = Math.round((new Date(toStr) - new Date(fromStr)) / msDay) + 1;
    const compToStr   = fmtISO(new Date(new Date(fromStr) - msDay));
    const compFromStr = fmtISO(new Date(new Date(compToStr) - (periodDays - 1) * msDay));

    // ── 3. Pull both periods from daily_metrics (uses the shared aggregator
    //      so output matches /api/metrics + the preset_metrics rebuild).
    const [currAll, prevAll] = await Promise.all([
      buildBrandMetricsForRange(fromStr,    toStr),
      buildBrandMetricsForRange(compFromStr, compToStr),
    ]);

    const curr = currAll.brands?.[brandId];
    const prev = prevAll.brands?.[brandId];
    if (!curr) {
      return res.status(200).json({
        brand: { id: brand.id, name: brand.name, marketplace: brand.marketplace || 'CA' },
        period:     { from: fromStr,    to: toStr,    label: `${fmtLabel(fromStr)} – ${fmtLabel(toStr)}` },
        comparison: { from: compFromStr, to: compToStr, label: `${fmtLabel(compFromStr)} – ${fmtLabel(compToStr)}` },
        config: { hidden_sections: [], available_sections: REPORT_SECTION_KEYS, enabled_sections: REPORT_SECTION_KEYS },
        summary: null, summaryPrev: null, products: [], dailySeries: [], dailySeriesPrev: [],
        note: 'No daily_metrics rows for this brand in the requested window',
        generatedAt: new Date().toISOString(),
      });
    }

    // ── 4. Per-brand config (hidden_sections). Missing row → empty defaults.
    const { data: cfgRow } = await supabase
      .from('brand_report_configs')
      .select('hidden_sections, updated_at')
      .eq('brand_id', brandId)
      .maybeSingle();
    const hidden = Array.isArray(cfgRow?.hidden_sections) ? cfgRow.hidden_sections : [];
    const hiddenSet = new Set(hidden);
    const enabledSections = REPORT_SECTION_KEYS.filter(k => !hiddenSet.has(k));

    // ── 5. Daily series for the chart sections — re-query daily_metrics so
    //      we get per-day breakdown (buildBrandMetricsForRange aggregates).
    //      Pulls revenue + units (organic sales chart) AND ad spend/sales
    //      (ad-trend chart with ROAS overlay).
    const brandAsinSet = new Set(brand.asins || []);
    async function fetchDailySeries(fromS, toS) {
      if (!brandAsinSet.size) return [];
      const out = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('daily_metrics')
          .select('asin,date,revenue_cad,revenue_usd,units,spend_cad,spend_usd,attributed_sales_cad,attributed_sales_usd')
          .in('asin', [...brandAsinSet]).gte('date', fromS).lte('date', toS)
          .order('date').range(off, off + 999);
        if (error) throw new Error(error.message);
        out.push(...data);
        if (data.length < 1000) break;
      }
      const byDate = {};
      for (const r of out) {
        if (!byDate[r.date]) byDate[r.date] = {
          date: r.date, revCad: 0, revUsd: 0, units: 0,
          spendCad: 0, spendUsd: 0, adSalesCad: 0, adSalesUsd: 0,
        };
        byDate[r.date].revCad     += r.revenue_cad          || 0;
        byDate[r.date].revUsd     += r.revenue_usd          || 0;
        byDate[r.date].units      += r.units                || 0;
        byDate[r.date].spendCad   += r.spend_cad            || 0;
        byDate[r.date].spendUsd   += r.spend_usd            || 0;
        byDate[r.date].adSalesCad += r.attributed_sales_cad || 0;
        byDate[r.date].adSalesUsd += r.attributed_sales_usd || 0;
      }
      // Round monetary values so the client doesn't show .000001 artifacts.
      return Object.values(byDate)
        .map(d => ({
          ...d,
          revCad: Math.round(d.revCad * 100) / 100,
          revUsd: Math.round(d.revUsd * 100) / 100,
          spendCad: Math.round(d.spendCad * 100) / 100,
          spendUsd: Math.round(d.spendUsd * 100) / 100,
          adSalesCad: Math.round(d.adSalesCad * 100) / 100,
          adSalesUsd: Math.round(d.adSalesUsd * 100) / 100,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }

    // YTD series — only fetch if the ytd_chart section is enabled (saves a
    // year-of-rows query for brands that have it hidden).
    async function fetchYtdSeries() {
      if (!brandAsinSet.size) return { current: [], prior: [] };
      const today = new Date(toStr + 'T12:00:00Z');
      const yearStartCurr  = fmtISO(new Date(Date.UTC(today.getUTCFullYear(),     0, 1)));
      const yearStartPrior = fmtISO(new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)));
      const yearEndPrior   = fmtISO(new Date(Date.UTC(today.getUTCFullYear() - 1, today.getUTCMonth(), today.getUTCDate())));
      const [curr, prior] = await Promise.all([
        fetchDailySeries(yearStartCurr,  toStr),
        fetchDailySeries(yearStartPrior, yearEndPrior),
      ]);
      return { current: curr, prior };
    }

    const wantYtd = !hiddenSet.has('ytd_chart');
    const [dailySeries, dailySeriesPrev, ytd] = await Promise.all([
      fetchDailySeries(fromStr,    toStr),
      fetchDailySeries(compFromStr, compToStr),
      wantYtd ? fetchYtdSeries() : Promise.resolve({ current: [], prior: [] }),
    ]);

    // ── 6. Assemble response
    res.json({
      brand: { id: brand.id, name: brand.name, marketplace: brand.marketplace || 'CA' },
      period:     { from: fromStr,    to: toStr,    label: `${fmtLabel(fromStr)} – ${fmtLabel(toStr)}` },
      comparison: { from: compFromStr, to: compToStr, label: `${fmtLabel(compFromStr)} – ${fmtLabel(compToStr)}` },
      config: {
        hidden_sections:    hidden,
        available_sections: REPORT_SECTION_KEYS,
        enabled_sections:   enabledSections,
        updated_at:         cfgRow?.updated_at || null,
      },
      summary:     curr.summary,
      summaryPrev: prev?.summary || null,
      products:    curr.skus,
      dailySeries,
      dailySeriesPrev,
      ytdSeries:     ytd.current,
      ytdSeriesPrev: ytd.prior,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[BrandReportDataset] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Brand report data — assembles current + comparison period, ads, inventory for a single brand
app.get('/api/report-data/:brandId', async (req, res) => {
  const { brandId } = req.params;

  try {
    const msDay = 86400000;
    const fmtISO = d => d.toISOString().split('T')[0];
    const fmtLabel = s => new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    const todayStr = fmtISO(new Date());
    const toStr    = req.query.to   || todayStr;
    const fromStr  = req.query.from || fmtISO(new Date(new Date(toStr) - 29 * msDay));

    const periodDays = Math.round((new Date(toStr) - new Date(fromStr)) / msDay);
    const compToDate   = new Date(new Date(fromStr) - msDay);
    const compFromDate = new Date(compToDate - periodDays * msDay);
    const compToStr   = fmtISO(compToDate);
    const compFromStr = fmtISO(compFromDate);

    // Load brand config
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: `Brand '${brandId}' not found` });

    // Query daily_metrics for this brand's ASINs, paginated. CRITICAL: filter by
    // ASIN and paginate past Supabase's 1000-row cap. An unfiltered/unpaginated
    // query returns only the first 1000 of 10k+ rows (all brands, full window),
    // silently truncating the report to ~10% of the data. See Learnings: 1000-row cap.
    const reportAsins = brand.asins || [];

    async function fetchBrandDaily(select, fromS, toS) {
      if (!reportAsins.length) return [];
      const out = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('daily_metrics').select(select)
          .in('asin', reportAsins).gte('date', fromS).lte('date', toS)
          .order('asin').order('date').range(off, off + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) break;
      }
      return out;
    }

    // Latest non-null inventory snapshot per ASIN (this brand only, paginated).
    async function fetchLatestInventory(toS) {
      if (!reportAsins.length) return {};
      const out = [];
      for (let off = 0; ; off += 1000) {
        const { data, error } = await supabase.from('daily_metrics')
          .select('asin,inventory_on_hand,date')
          .in('asin', reportAsins).lte('date', toS)
          .not('inventory_on_hand', 'is', null)
          .order('date', { ascending: false }).range(off, off + 999);
        if (error) throw error;
        out.push(...data);
        if (data.length < 1000) break;
      }
      const inv = {};
      for (const r of out) if (!(r.asin in inv)) inv[r.asin] = r.inventory_on_hand;
      return inv;
    }

    const [currRows, prevRows, invByAsin] = await Promise.all([
      fetchBrandDaily('asin,date,units,units_ca,units_us,revenue_cad,revenue_usd,sessions,page_views,buy_box_pct', fromStr, toStr),
      fetchBrandDaily('asin,date,units,units_ca,units_us,revenue_cad,revenue_usd', compFromStr, compToStr),
      fetchLatestInventory(toStr),
    ]);

    // Aggregate helpers
    function aggregateRows(rows) {
      const byAsin = {};
      for (const r of (rows || [])) {
        if (!byAsin[r.asin]) byAsin[r.asin] = { units: 0, unitsCa: 0, unitsUs: 0, revCad: 0, revUsd: 0, sessions: 0, pv: 0, bbSum: 0, bbCount: 0 };
        const a = byAsin[r.asin];
        a.units   += r.units        || 0;
        a.unitsCa += r.units_ca     || 0;
        a.unitsUs += r.units_us     || 0;
        a.revCad  += r.revenue_cad  || 0;
        a.revUsd  += r.revenue_usd  || 0;
        if (r.sessions   != null) a.sessions += r.sessions;
        if (r.page_views != null) a.pv       += r.page_views;
        if (r.buy_box_pct != null) { a.bbSum += r.buy_box_pct; a.bbCount++; }
      }
      return byAsin;
    }

    const currByAsin = aggregateRows(currRows);
    const prevByAsin = aggregateRows(prevRows);

    // Daily series for chart — sum all brand ASINs per date
    const brandAsinSet = new Set(brand.asins || []);
    const dailyMap = {};
    for (const r of (currRows || [])) {
      if (!brandAsinSet.has(r.asin)) continue;
      if (!dailyMap[r.date]) dailyMap[r.date] = { revCad: 0, revUsd: 0, units: 0 };
      dailyMap[r.date].revCad += r.revenue_cad || 0;
      dailyMap[r.date].revUsd += r.revenue_usd || 0;
      dailyMap[r.date].units  += r.units        || 0;
    }
    const prevDailyMap = {};
    for (const r of (prevRows || [])) {
      if (!brandAsinSet.has(r.asin)) continue;
      if (!prevDailyMap[r.date]) prevDailyMap[r.date] = { revCad: 0, revUsd: 0, units: 0 };
      prevDailyMap[r.date].revCad += r.revenue_cad || 0;
      prevDailyMap[r.date].revUsd += r.revenue_usd || 0;
      prevDailyMap[r.date].units  += r.units        || 0;
    }

    // Assemble product rows
    let sumCurr = { revCad: 0, revUsd: 0, units: 0, sessions: 0, pv: 0 };
    let sumPrev = { revCad: 0, revUsd: 0, units: 0 };
    const products = [];

    for (const asin of (brand.asins || [])) {
      const c = currByAsin[asin];
      const p = prevByAsin[asin];
      if (!c && !p) continue;
      const buyBox = c?.bbCount > 0 ? Math.round(c.bbSum / c.bbCount * 10) / 10 : null;
      products.push({
        asin,
        title:      brand.asinTitles?.[asin] || asin,
        revenueCad: Math.round((c?.revCad || 0) * 100) / 100,
        revenueUsd: Math.round((c?.revUsd || 0) * 100) / 100,
        units:      c?.units  || 0,
        sessions:   c?.sessions || null,
        pageViews:  c?.pv     || null,
        buyBox,
        inventory:  invByAsin[asin] ?? null,
        prev: {
          revenueCad: Math.round((p?.revCad || 0) * 100) / 100,
          revenueUsd: Math.round((p?.revUsd || 0) * 100) / 100,
          units:      p?.units  || 0,
        },
      });
      if (c) {
        sumCurr.revCad   += c.revCad;
        sumCurr.revUsd   += c.revUsd;
        sumCurr.units    += c.units;
        sumCurr.sessions += c.sessions;
        sumCurr.pv       += c.pv;
      }
      if (p) { sumPrev.revCad += p.revCad; sumPrev.revUsd += p.revUsd; sumPrev.units += p.units; }
    }

    // Sort by combined revenue desc
    products.sort((a, b) => (b.revenueCad + b.revenueUsd) - (a.revenueCad + a.revenueUsd));

    res.json({
      brand:   { id: brand.id, name: brand.name },
      period:  { from: fromStr,    to: toStr,    label: `${fmtLabel(fromStr)} – ${fmtLabel(toStr)}` },
      comparison: { from: compFromStr, to: compToStr, label: `${fmtLabel(compFromStr)} – ${fmtLabel(compToStr)}` },
      summary: {
        revenueCad: Math.round(sumCurr.revCad * 100) / 100,
        revenueUsd: Math.round(sumCurr.revUsd * 100) / 100,
        units:      sumCurr.units,
        sessions:   sumCurr.sessions || null,
        pageViews:  sumCurr.pv       || null,
      },
      summaryPrev: {
        revenueCad: Math.round(sumPrev.revCad * 100) / 100,
        revenueUsd: Math.round(sumPrev.revUsd * 100) / 100,
        units:      sumPrev.units,
      },
      dailySeries:     Object.entries(dailyMap).sort().map(([d, v]) => ({ date: d, ...v })),
      dailySeriesPrev: Object.entries(prevDailyMap).sort().map(([d, v]) => ({ date: d, ...v })),
      products,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Report] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ads data for report — separate endpoint because it takes 1-5 min (ads report must bake)
app.get('/api/report-ads/:brandId', async (req, res) => {
  const { brandId } = req.params;
  const msDay = 86400000;
  const fmtISO = d => d.toISOString().split('T')[0];
  const todayStr = fmtISO(new Date());
  const toStr   = req.query.to   || todayStr;
  const fromStr = req.query.from || fmtISO(new Date(new Date(toStr) - 29 * msDay));

  try {
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: `Brand '${brandId}' not found` });

    const { syncAdMetrics } = require('./sync/ads');
    const adByAsin = await syncAdMetrics(fromStr, toStr);

    let spendCad = 0, spendUsd = 0, salesCad = 0, salesUsd = 0, clicks = 0, impressions = 0, orders = 0;
    const byAsin = {};
    for (const asin of (brand.asins || [])) {
      const d = adByAsin[asin];
      if (!d) continue;
      spendCad    += d.spendCad           || 0;
      spendUsd    += d.spendUsd           || 0;
      salesCad    += d.attributedSalesCad || 0;
      salesUsd    += d.attributedSalesUsd || 0;
      clicks      += d.clicks             || 0;
      impressions += d.impressions        || 0;
      orders      += d.orders             || 0;
      byAsin[asin] = { spendCad: d.spendCad, spendUsd: d.spendUsd, acos: d.acos, roas: d.roas };
    }
    const totalSpend = spendCad + spendUsd;
    const totalSales = salesCad + salesUsd;

    res.json({
      summary: {
        spendCad: Math.round(spendCad * 100) / 100,
        spendUsd: Math.round(spendUsd * 100) / 100,
        salesCad: Math.round(salesCad * 100) / 100,
        salesUsd: Math.round(salesUsd * 100) / 100,
        clicks, impressions, orders,
        acos:  totalSales > 0 ? Math.round(totalSpend / totalSales * 10000) / 100 : null,
        roas:  totalSpend > 0 ? Math.round(totalSales / totalSpend * 100) / 100    : null,
        cpc:   clicks > 0     ? Math.round(totalSpend / clicks * 10000) / 10000   : null,
      },
      byAsin,
    });
  } catch (err) {
    console.error('[Report] Ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

async function computeHealthReport({ sinceIso = null } = {}) {
  const [{ brands }, pm, sellerNames] = await Promise.all([loadBrands(), loadPresetMetrics(), loadSellerNames()]);
  const preset = pm.presets?.last30d || pm.presets?.[Object.keys(pm.presets || {})[0]];
  const brandMetrics = preset?.brands || {};
  // Last 7d preset used to gate OOS alert (only fire if actively selling)
  const last7dBrandMetrics = pm.presets?.last7d?.brands || {};
  const alerts = [];

  for (const brand of brands) {
    if (DIGEST_EXCLUDE_BRANDS.has(brand.id)) continue;
    const bm = brandMetrics[brand.id];

    // ── Event-based alerts from enrichment (content changed, variation broken, etc.) ──
    // Only include alerts since `sinceIso` to avoid re-firing old events in the digest.
    // Dedupe by (asin, type) — multiple syncs in the window can record the same event;
    // we only want one row per ASIN per change-type, keeping the most recent.
    const eventByKey = new Map();
    for (const ev of (brand.recentAlerts || [])) {
      if (sinceIso && ev.detectedAt && ev.detectedAt <= sinceIso) continue;
      const key = `${ev.asin}|${ev.type}`;
      const prev = eventByKey.get(key);
      if (!prev || new Date(ev.detectedAt) > new Date(prev.detectedAt)) {
        eventByKey.set(key, ev);
      }
    }
    const EXCLUDED_RECENT_TYPES = new Set(['content_changed', 'variation_broken', 'low_stock']);
    const IGNORE_RECENT_STATUSES = new Set(['incomplete', 'unknown']);
    for (const ev of eventByKey.values()) {
      if (EXCLUDED_RECENT_TYPES.has(ev.type)) continue;
      if (ev.type === 'suppressed' && ev.detail?.status && IGNORE_RECENT_STATUSES.has((ev.detail.status || '').toLowerCase())) continue;
      const title = brand.asinTitles?.[ev.asin] || ev.asin;
      alerts.push({
        brandId: brand.id, brandName: brand.name, brandColor: brand.color,
        asin: ev.asin, title,
        severity: ev.severity, type: ev.type,
        message: ev.message,
        detail: ev.detail,
        detectedAt: ev.detectedAt,
        marketplace: brand.marketplace || 'CA',
      });
    }

    if (!bm?.skus?.length) continue;

    // Index 7d sales per ASIN for this brand (used by OOS gate)
    const last7dByAsin = {};
    for (const s of (last7dBrandMetrics[brand.id]?.skus || [])) {
      last7dByAsin[s.asin] = s.units || 0;
    }

    // ── State-based alerts from current sync data ─────────────────────────────────────
    for (const sku of bm.skus) {
      const asin = sku.asin;
      const title = sku.title || brand.asinTitles?.[asin] || asin;
      const leadTime = brand.leadTimes?.[asin] || 30;
      const inv = sku.inventory || {};
      const onHand = inv.onHand || 0;
      const inbound = inv.inbound || 0;
      const units = sku.units || 0;
      const dailyVelocity = units / 30;
      const daysOfStock = dailyVelocity > 0 ? Math.round(onHand / dailyVelocity) : null;
      const bbOwner = brand.buyBoxOwners?.[asin];

      // Amazon returns "active" / "Active" / sometimes other cases — normalize
      const statusNorm = (sku.status || '').toLowerCase();
      // Statuses that mean the listing is dead vs. just missing some attributes:
      //   critical: inactive, suppressed, restricted, blocked
      //   warning:  incomplete, unknown, anything else non-active
      // "incomplete" often appears on new/setup ASINs that are still sellable on Amazon —
      // not a critical-grade alert.
      // Only alert on statuses that actually hide or disable the listing.
      // "incomplete" = missing optional attributes, listing is live — ignore.
      // "unknown" = SP-API returned no status, not actionable — ignore.
      const CRITICAL_STATUSES = new Set(['suppressed', 'restricted', 'blocked']);
      const IGNORE_STATUSES = new Set(['incomplete', 'unknown', 'inactive', '']);
      if (statusNorm && statusNorm !== 'active' && !IGNORE_STATUSES.has(statusNorm)) {
        {
          const isCritical = CRITICAL_STATUSES.has(statusNorm);
          alerts.push({
            brandId: brand.id, brandName: brand.name, brandColor: brand.color,
            asin, title, severity: isCritical ? 'critical' : 'warning', type: 'suppressed',
            message: `Listing status: ${sku.status}`,
            detail: { status: sku.status },
            marketplace: brand.marketplace || 'CA',
          });
        }
      }

      // Buy Box lost — look at the captured winner history over the last 24h.
      // Fire ONLY if we have at least one captured snapshot where a non-RMC seller won.
      // The S&T buyBox % is a 30-day average and not actionable on its own.
      const ourSellerId = process.env.SP_API_SELLER_ID;
      const hist = brand.buyBoxOwnerHistory?.[asin] || [];
      const cutoff48h = Date.now() - 48 * 60 * 60 * 1000;
      const recent = hist.filter(h => new Date(h.capturedAt).getTime() > cutoff48h && h.sellerId && h.sellerId !== ourSellerId);
      if (recent.length > 0) {
        // Dedupe by sellerId, keep most recent occurrence's name
        const seen = new Map();
        for (const h of recent) {
          if (!seen.has(h.sellerId)) seen.set(h.sellerId, h);
        }
        const winners = [...seen.values()];
        // Resolve seller display names from the cache (populated by scraping in sync).
        // Fall back to seller ID with a profile link if we don't have a name yet.
        const tld = brand.marketplace === 'US' ? 'com' : 'ca';
        const winnerStr = winners
          .map(w => {
            const cached = sellerNames[w.sellerId];
            const name = cached?.name || w.sellerName || null;
            const label = name || w.sellerId;
            const url = `https://www.amazon.${tld}/sp?seller=${w.sellerId}`;
            const linked = w.sellerId ? `<${url}|${label}>` : label;
            return `${linked}${w.isFba ? ' (FBA)' : ''}`;
          })
          .join(', ');
        alerts.push({
          brandId: brand.id, brandName: brand.name, brandColor: brand.color,
          asin, title, severity: 'warning', type: 'buybox_lost',
          message: `Won by ${winnerStr}`,
          detail: { winners, snapshots: recent.length },
          marketplace: brand.marketplace || 'CA',
        });
      }

      if ((inv.unfulfillable || 0) > 0) {
        alerts.push({
          brandId: brand.id, brandName: brand.name, brandColor: brand.color,
          asin, title, severity: 'warning', type: 'unfulfillable',
          message: `${inv.unfulfillable} unfulfillable units`,
          detail: { unfulfillable: inv.unfulfillable },
          marketplace: brand.marketplace || 'CA',
        });
      }

      // Out of stock — onHand=0 with recent velocity (last 7d sales > 0).
      // Gates: FBA-tracked (FBM stock isn't visible) AND sold in last 7 days (not a slow mover).
      const units7d = last7dByAsin[asin] || 0;
      if (inv.fbaTracked && onHand === 0 && units7d > 0) {
        alerts.push({
          brandId: brand.id, brandName: brand.name, brandColor: brand.color,
          asin, title, severity: 'critical', type: 'out_of_stock',
          message: `Out of stock${inbound > 0 ? ` · ${inbound} inbound` : ' · NO inbound'}`,
          detail: { onHand, inbound, units7d, dailyVelocity: units7d / 7 },
          marketplace: brand.marketplace || 'CA',
        });
      }

      // low_stock alert removed — handled by reorder/PO flow elsewhere
    }

    // ── Stranded inventory alerts (from GET_STRANDED_INVENTORY_UI_DATA report) ──
    for (const [asin, s] of Object.entries(brand.strandedInventory || {})) {
      const title = brand.asinTitles?.[asin] || asin;
      alerts.push({
        brandId: brand.id, brandName: brand.name, brandColor: brand.color,
        asin, title, severity: 'critical', type: 'stranded',
        message: `${s.qty} stranded unit${s.qty !== 1 ? 's' : ''}${s.reason ? ` — ${s.reason}` : ''}`,
        detail: { qty: s.qty, reason: s.reason, marketplace: s.marketplace },
        marketplace: s.marketplace || brand.marketplace || 'CA',
      });
    }
  }

  alerts.sort((a, b) => {
    const sev = { critical: 0, warning: 1, info: 2 };
    if (sev[a.severity] !== sev[b.severity]) return sev[a.severity] - sev[b.severity];
    return a.brandName.localeCompare(b.brandName);
  });

  const critical = alerts.filter(a => a.severity === 'critical').length;
  const warning  = alerts.filter(a => a.severity === 'warning').length;
  const brandsAffected = new Set(alerts.map(a => a.brandId)).size;

  return {
    generatedAt: new Date().toISOString(),
    alerts,
    summary: { critical, warning, total: alerts.length, brandsAffected }
  };
}

// Revenue diagnostic: breakdown per brand for a given preset
app.get('/api/revenue-check', async (req, res) => {
  const presetKey = req.query.preset || 'lastMonth';
  const pm = await loadPresetMetrics();
  const preset = pm.presets?.[presetKey];
  if (!preset) return res.status(404).json({ error: `Preset '${presetKey}' not found` });
  const rows = [];
  let totalCad = 0, totalUsd = 0;
  for (const [brandId, bm] of Object.entries(preset.brands || {})) {
    const cad = bm.summary?.revenueCad || 0;
    const usd = bm.summary?.revenueUsd || 0;
    totalCad += cad; totalUsd += usd;
    rows.push({ brand: bm.summary?.name || brandId, revenueCad: cad, revenueUsd: usd, skus: bm.skus?.length || 0 });
  }
  rows.sort((a, b) => (b.revenueCad + b.revenueUsd) - (a.revenueCad + a.revenueUsd));
  res.json({ preset: presetKey, label: preset.label, totalCad, totalUsd, brands: rows });
});

app.get('/api/health', async (req, res) => {
  try {
    // Browser view shows recent events from the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    res.json(await computeHealthReport({ sinceIso: sevenDaysAgo }));
  } catch (err) {
    console.error('[health]', err);
    res.status(500).json({ error: err.message });
  }
});

// One-time cleanup: filter specific alert types out of brand.recentAlerts. Used to
// clear stale false-positive events after fixing detection logic.
//   POST /api/health/clear-alerts  { "types": ["content_changed"] }
app.post('/api/health/clear-alerts', async (req, res) => {
  try {
    const types = Array.isArray(req.body?.types) ? new Set(req.body.types) : null;
    if (!types || types.size === 0) return res.status(400).json({ error: 'body.types required (array of alert types to clear)' });

    const data = await loadBrands();
    let removed = 0;
    for (const b of data.brands) {
      if (!b.recentAlerts?.length) continue;
      const before = b.recentAlerts.length;
      b.recentAlerts = b.recentAlerts.filter(a => !types.has(a.type));
      removed += before - b.recentAlerts.length;
    }
    await saveBrands(data);
    res.json({ removed, types: [...types] });
  } catch (err) {
    console.error('[health/clear-alerts]', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger seller name scraping on-demand. Scrapes any non-cached or stale seller IDs
// that appear in buyBoxOwnerHistory (excluding General Wholesale + Unknown Brand).
app.post('/api/health/scrape-seller-names', async (req, res) => {
  try {
    const { scrapeSellerNames } = require('./sync/amazon');
    const { brands } = await loadBrands();
    const sellerNames = await loadSellerNames();
    const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
    const ourSellerId = process.env.SP_API_SELLER_ID;
    const skip = new Set(['general-wholesale', 'unknown-brand']);
    const idsByMp = { CA: new Set(), US: new Set() };
    for (const b of brands) {
      if (skip.has(b.id)) continue;
      const mp = b.marketplace === 'US' ? 'US' : 'CA';
      for (const hist of Object.values(b.buyBoxOwnerHistory || {})) {
        for (const h of hist) {
          if (!h.sellerId || h.sellerId === ourSellerId) continue;
          const cached = sellerNames[h.sellerId];
          const stale = cached?.scrapedAt && (Date.now() - new Date(cached.scrapedAt).getTime() > REFRESH_MS);
          if (!cached || stale) idsByMp[mp].add(h.sellerId);
        }
      }
    }
    const [caNames, usNames] = await Promise.all([
      scrapeSellerNames([...idsByMp.CA], 'CA'),
      scrapeSellerNames([...idsByMp.US], 'US'),
    ]);
    const updated = { ...sellerNames, ...caNames, ...usNames };
    await saveSellerNames(updated);
    res.json({
      scraped: { CA: Object.keys(caNames).length, US: Object.keys(usNames).length },
      attempted: { CA: idsByMp.CA.size, US: idsByMp.US.size },
      cacheSize: Object.keys(updated).length,
    });
  } catch (err) {
    console.error('[health/scrape-seller-names]', err);
    res.status(500).json({ error: err.message });
  }
});

// Trigger the Slack digest manually. Requires SLACK_DIGEST_ENABLED=true in .env.
app.post('/api/health/digest', async (req, res) => {
  if (process.env.SLACK_DIGEST_ENABLED !== 'true') {
    return res.status(403).json({ error: 'Slack digest is disabled. Set SLACK_DIGEST_ENABLED=true to enable.' });
  }
  try {
    const settings = await loadPoSettings();
    const sinceIso = settings.lastDigestAt || new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const report = await computeHealthReport({ sinceIso });
    const { postSlackDigest } = require('./slack/digest');
    const result = await postSlackDigest({
      ...report,
      dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000/brands.html'
    });
    if (result.posted) {
      await savePoSettings({ ...settings, lastDigestAt: new Date().toISOString() });
    }
    res.json({ ...result, summary: report.summary });
  } catch (err) {
    console.error('[health/digest]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bulk-template', async (req, res) => {
  try {
    const [brandData, pm] = await Promise.all([loadBrands(), loadPresetMetrics()]);
    const { brands } = brandData;
    const preset = pm.presets?.last30d || pm.presets?.[Object.keys(pm.presets || {})[0]];
    const brandMetrics = preset?.brands || {};

    const headers = ['Brand', 'ASIN', 'Title', 'SKU', 'UPC', 'Lead Time (days)', 'Case Pack Size (units)', 'Stock #', 'Supplier Product Name', 'COGS (CA)', 'COGS (US)'];
    const csvRows = [headers];

    for (const brand of brands.filter(b => b.id !== 'unknown-brand').sort((a, b) => a.name.localeCompare(b.name))) {
      const skuMap = Object.fromEntries((brandMetrics[brand.id]?.skus || []).map(s => [s.asin, s]));
      for (const asin of brand.asins) {
        const sku = skuMap[asin];
        const cfg = brand.asinConfig?.[asin] || {};
        csvRows.push([
          brand.name,
          asin,
          sku?.title || brand.asinTitles?.[asin] || '',
          sku?.sellerSku || brand.asinSkus?.[asin] || '',
          brand.upcs?.[asin] || '',
          brand.leadTimes?.[asin] ?? '',
          brand.casePacks?.[asin] ?? '',
          cfg.stockNumber || '',
          cfg.supplierName || '',
          brand.cogsPerMarketplace?.[asin]?.CA ?? brand.cogs?.[asin] ?? '',
          brand.cogsPerMarketplace?.[asin]?.US ?? ''
        ]);
      }
    }

    const escape = v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csv = csvRows.map(r => r.map(escape).join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="rmc-product-data.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bulk-update', async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || !updates.length) return res.status(400).json({ error: 'No updates provided' });

    const brandData = await loadBrands();
    const { brands } = brandData;
    let updatedAsins = 0;

    for (const u of updates) {
      const brand = brands.find(b => b.id === u.brandId);
      if (!brand || !brand.asins.includes(u.asin)) continue;

      const { asin } = u;
      if (u.leadTime !== '' && u.leadTime != null) {
        brand.leadTimes = brand.leadTimes || {};
        brand.leadTimes[asin] = Number(u.leadTime);
      }
      if (u.casePack !== '' && u.casePack != null) {
        brand.casePacks = brand.casePacks || {};
        brand.casePacks[asin] = Number(u.casePack);
      }
      if (u.upc != null) {
        brand.upcs = brand.upcs || {};
        brand.upcs[asin] = u.upc;
      }
      if (u.stockNumber != null || u.supplierName != null) {
        brand.asinConfig = brand.asinConfig || {};
        brand.asinConfig[asin] = brand.asinConfig[asin] || {};
        if (u.stockNumber != null) brand.asinConfig[asin].stockNumber = u.stockNumber;
        if (u.supplierName != null) brand.asinConfig[asin].supplierName = u.supplierName;
      }
      if (u.cogsCa !== '' && u.cogsCa != null) {
        brand.cogsPerMarketplace = brand.cogsPerMarketplace || {};
        brand.cogsPerMarketplace[asin] = brand.cogsPerMarketplace[asin] || {};
        brand.cogsPerMarketplace[asin].CA = Number(u.cogsCa);
      }
      if (u.cogsUs !== '' && u.cogsUs != null) {
        brand.cogsPerMarketplace = brand.cogsPerMarketplace || {};
        brand.cogsPerMarketplace[asin] = brand.cogsPerMarketplace[asin] || {};
        brand.cogsPerMarketplace[asin].US = Number(u.cogsUs);
      }
      updatedAsins++;
    }

    await saveBrands(brandData);
    res.json({ success: true, updatedAsins });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`RMC Brand Dashboard → http://localhost:${PORT}`);
  if (process.env.SYNC_ENABLED === 'true') {
    scheduleDailySync();
  } else {
    console.log('[AutoSync] Disabled (SYNC_ENABLED != true) — set SYNC_ENABLED=true on VPS to enable');
  }
});

// ── Background financial events patch (runs after core sync completes) ────────
async function backgroundUpdateFinancials(tag = 'Finances') {
  console.log(`[${tag}] Background financial events fetch starting...`);
  try {
    const { fetchFinancialEvents } = require('./sync/amazon');
    const financialsMap = await fetchFinancialEvents();
    if (syncState.status === 'syncing') {
      console.log(`[${tag}] New sync started while fetching financials — skipping patch to avoid overwrite`);
      return;
    }
    const pm = await loadPresetMetrics();
    for (const [presetKey, financials] of Object.entries(financialsMap)) {
      if (pm.presets?.[presetKey]) {
        // Preserve adSpend set by Phase 3 ads sync — financial events adSpend is unreliable
        // (often 0 for this account). Keep whichever source has the higher value.
        const existing = pm.presets[presetKey].financials || {};
        for (const cur of ['CAD', 'USD']) {
          const existingSpend = existing[cur]?.adSpend || 0;
          const incomingSpend = financials[cur]?.adSpend || 0;
          if (existingSpend > incomingSpend) {
            financials[cur] = financials[cur] || {};
            financials[cur].adSpend = existingSpend;
          }
        }
        pm.presets[presetKey].financials = financials;
      }
    }
    await savePresetMetrics(pm);
    console.log(`[${tag}] Financial events patched into preset-metrics`);
  } catch (err) {
    console.warn(`[${tag}] Background financials failed:`, err.message);
  }
}

// ── Shared full-sync runner (used by manual /api/sync and auto-sync) ──────────
async function runFullSync(tag = 'Sync') {
  if (syncState.status === 'syncing') {
    console.log(`[${tag}] Skipped — sync already in progress`);
    return;
  }
  console.log(`[${tag}] Starting...`);
  syncState = { status: 'syncing', lastSync: null, error: null };

  // Stamp attempt time before anything else so restarts don't re-trigger immediately
  try {
    const pm = await loadPresetMetrics();
    await savePresetMetrics({ ...pm, lastSyncAttempt: new Date().toISOString() });
  } catch (_) {}

  try {
    const { syncBrandMetrics, fetchUpcsForAsins } = require('./sync/amazon');
    const { startAdReports, finishAdReports } = require('./sync/ads');
    const data = await loadBrands();

    // Phase 1: kick off ads reports before SP sync starts
    let adHandles = {};
    let adsPopulated = false;
    try {
      const todayPst = pstDateStr();
      const yest     = pstSubtractDays(todayPst, 1);
      const [ty, tm] = todayPst.split('-').map(Number);
      const lmsStr   = `${tm === 1 ? ty - 1 : ty}-${String(tm === 1 ? 12 : tm - 1).padStart(2, '0')}-01`;
      const lmeStr   = pstSubtractDays(`${String(ty).padStart(4,'0')}-${String(tm).padStart(2,'0')}-01`, 1);
      const ranges = {
        yesterday: { startDate: yest,                        endDate: yest  },
        last7d:    { startDate: pstSubtractDays(yest, 6),    endDate: yest  },
        last14d:   { startDate: pstSubtractDays(yest, 13),   endDate: yest  },
        last30d:   { startDate: pstSubtractDays(yest, 29),   endDate: yest  },
        lastMonth: { startDate: lmsStr,                      endDate: lmeStr },
      };
      const entries = [];
      for (const [key, { startDate, endDate }] of Object.entries(ranges)) {
        const handles = await startAdReports(startDate, endDate);
        entries.push([key, { handles, startDate, endDate }]);
        await new Promise(r => setTimeout(r, 1000)); // 1s between ad report creates
      }
      adHandles = Object.fromEntries(entries);
      console.log(`[${tag}] Ads reports submitted — baking while SP sync runs...`);
    } catch (adsCreateErr) {
      console.warn(`[${tag}] Ads report creation failed (non-fatal):`, adsCreateErr.message);
    }

    // Seed image cache from Supabase so amazon.js doesn't try to re-fetch images already stored
    try {
      const existingPm = await loadPresetMetrics();
      const supabaseImages = {};
      for (const preset of Object.values(existingPm.presets || {})) {
        for (const bm of Object.values(preset.brands || {})) {
          for (const sku of (bm.skus || [])) {
            if (sku.asin && sku.imageUrl) supabaseImages[sku.asin] = sku.imageUrl;
          }
        }
      }
      if (Object.keys(supabaseImages).length > 0) {
        const imgCachePath = path.join(DATA_DIR, 'image-cache.json');
        let existingCache = {};
        try { existingCache = JSON.parse(fs.readFileSync(imgCachePath, 'utf8')); } catch {}
        const merged = { ...supabaseImages, ...existingCache }; // disk wins if both have it
        fs.writeFileSync(imgCachePath, JSON.stringify(merged));
        console.log(`[${tag}] Seeded image cache: ${Object.keys(supabaseImages).length} from Supabase, ${Object.keys(merged).length} total`);
      }
    } catch (imgSeedErr) {
      console.warn(`[${tag}] Image cache seed failed (non-fatal):`, imgSeedErr.message);
    }

    // Phase 2: SP-API sync
    const { presets, updatedBrands } = await syncBrandMetrics(data.brands);
    await saveSyncResults(updatedBrands);

    // Phase 3: collect ads results and merge
    try {
      const adResultEntries = await Promise.all(
        Object.entries(adHandles).map(async ([key, { handles, startDate, endDate }]) => {
          const adData = await finishAdReports(handles, startDate, endDate);
          return [key, adData];
        })
      );
      const adDataByPreset = Object.fromEntries(adResultEntries);

      for (const [presetKey, preset] of Object.entries(presets)) {
        const adData = adDataByPreset[presetKey] || {};
        let totalSpendCad = 0, totalSpendUsd = 0;

        for (const brandMetrics of Object.values(preset.brands)) {
          let bSpendCad = 0, bSpendUsd = 0, bSalesCad = 0, bSalesUsd = 0;
          let bClicks = 0, bImpressions = 0, bOrders = 0;

          for (const sku of (brandMetrics.skus || [])) {
            const ad = adData[sku.asin];
            if (ad) {
              sku.spendCad           = ad.spendCad;
              sku.spendUsd           = ad.spendUsd;
              sku.attributedSalesCad = ad.attributedSalesCad;
              sku.attributedSalesUsd = ad.attributedSalesUsd;
              sku.adClicks           = ad.clicks;
              sku.adImpressions      = ad.impressions;
              sku.adOrders           = ad.orders;
              sku.acos               = ad.acos;
              sku.roas               = ad.roas;
              sku.cpc                = ad.cpc;
              sku.ctr                = ad.ctr;
              sku.adCvr              = ad.adCvr;
              bSpendCad    += ad.spendCad           || 0;
              bSpendUsd    += ad.spendUsd           || 0;
              bSalesCad    += ad.attributedSalesCad || 0;
              bSalesUsd    += ad.attributedSalesUsd || 0;
              bClicks      += ad.clicks      || 0;
              bImpressions += ad.impressions || 0;
              bOrders      += ad.orders      || 0;
            }
          }

          const bSpend = bSpendCad + bSpendUsd;
          const bSales = bSalesCad + bSalesUsd;
          brandMetrics.adSummary = {
            spendCad: Math.round(bSpendCad * 100) / 100,
            spendUsd: Math.round(bSpendUsd * 100) / 100,
            attributedSalesCad: Math.round(bSalesCad * 100) / 100,
            attributedSalesUsd: Math.round(bSalesUsd * 100) / 100,
            clicks: bClicks, impressions: bImpressions, orders: bOrders,
            acos:  bSales > 0 ? Math.round(bSpend / bSales * 10000) / 100 : null,
            roas:  bSpend > 0 ? Math.round(bSales / bSpend * 100) / 100 : null,
            ctr:   bImpressions > 0 ? Math.round(bClicks / bImpressions * 100000) / 1000 : null,
            cpc:   bClicks > 0 ? Math.round(bSpend / bClicks * 10000) / 10000 : null,
            adCvr: bClicks > 0 ? Math.round(bOrders / bClicks * 10000) / 100 : null,
          };
          totalSpendCad += bSpendCad;
          totalSpendUsd += bSpendUsd;
        }

        preset.financials = preset.financials || {};
        preset.financials.CAD = preset.financials.CAD || {};
        preset.financials.USD = preset.financials.USD || {};
        if (totalSpendCad > 0) preset.financials.CAD.adSpend = Math.round(totalSpendCad * 100) / 100;
        if (totalSpendUsd > 0) preset.financials.USD.adSpend = Math.round(totalSpendUsd * 100) / 100;
      }
      adsPopulated = true;
      console.log(`[${tag}] Ads data merged`);
    } catch (adsErr) {
      console.warn(`[${tag}] Ads collection failed (non-fatal):`, adsErr.message);
    }

    const lastSync = new Date().toISOString();
    // Merge new preset data into existing (don't wipe presets not included in this sync)
    const existing = await loadPresetMetrics();

    // If ads failed this sync, carry forward ad data from the previous sync
    if (!adsPopulated) {
      for (const [presetKey, preset] of Object.entries(presets)) {
        const prev = existing.presets?.[presetKey];
        if (!prev) continue;
        // Preserve preset-level ad spend in financials
        if (prev.financials?.CAD?.adSpend > 0 && !(preset.financials?.CAD?.adSpend > 0)) {
          preset.financials = preset.financials || {};
          preset.financials.CAD = preset.financials.CAD || {};
          preset.financials.CAD.adSpend = prev.financials.CAD.adSpend;
        }
        if (prev.financials?.USD?.adSpend > 0 && !(preset.financials?.USD?.adSpend > 0)) {
          preset.financials = preset.financials || {};
          preset.financials.USD = preset.financials.USD || {};
          preset.financials.USD.adSpend = prev.financials.USD.adSpend;
        }
        // Preserve per-brand adSummary + per-SKU ad fields
        for (const [brandId, bm] of Object.entries(preset.brands || {})) {
          const prevBm = prev.brands?.[brandId];
          if (!prevBm) continue;
          if (!bm.adSummary && prevBm.adSummary) bm.adSummary = prevBm.adSummary;
          for (const sku of (bm.skus || [])) {
            if (sku.spendCad != null) continue;
            const prevSku = prevBm.skus?.find(s => s.asin === sku.asin);
            if (!prevSku || prevSku.spendCad == null) continue;
            sku.spendCad           = prevSku.spendCad;
            sku.spendUsd           = prevSku.spendUsd;
            sku.attributedSalesCad = prevSku.attributedSalesCad;
            sku.attributedSalesUsd = prevSku.attributedSalesUsd;
            sku.adClicks           = prevSku.adClicks;
            sku.adImpressions      = prevSku.adImpressions;
            sku.adOrders           = prevSku.adOrders;
            sku.acos               = prevSku.acos;
            sku.roas               = prevSku.roas;
            sku.cpc                = prevSku.cpc;
            sku.ctr                = prevSku.ctr;
            sku.adCvr              = prevSku.adCvr;
          }
        }
      }
      console.log(`[${tag}] Ads creation failed — carried forward ad data from previous sync`);
    }

    const mergedPresets = { ...(existing.presets || {}), ...presets };
    await savePresetMetrics({ lastSync, presets: mergedPresets });

    // Overlay corrected per-brand summaries from daily_metrics. The S&T-sourced
    // build above silently fails for many brands (e.g. brand card $0 bug); this
    // rebuild aligns preset_metrics with the live daily_metrics source of truth.
    try {
      await rebuildPresetSummariesFromDaily(`${tag}-PresetRebuild`);
    } catch (rebuildErr) {
      console.warn(`[${tag}] Preset rebuild from daily_metrics failed (non-fatal):`, rebuildErr.message);
    }

    syncState = { status: 'done', lastSync, error: null };
    console.log(`[${tag}] Done:`, lastSync);

    // Write yesterday's per-ASIN data to daily_metrics for rolling history
    try {
      const yesterdayPreset = presets.yesterday;
      if (yesterdayPreset?.brands) {
        const dateStr = pstSubtractDays(pstDateStr(), 1);
        await writeDailyMetrics(yesterdayPreset.brands, dateStr);
      }
    } catch (dmErr) {
      console.warn(`[${tag}] daily_metrics write failed (non-fatal):`, dmErr.message);
    }

    // Financial events run in background — fees data can take 30-60 min (100+ API pages)
    // so we don't block the core S&T sync on them. They'll patch preset-metrics when done.
    setImmediate(() => backgroundUpdateFinancials(tag));

    // Scrape UPCs for any ASINs not yet checked
    const freshForUpc = await loadBrands();
    const missingUpcs = [];
    for (const b of freshForUpc.brands) {
      b.upcs = b.upcs || {};
      for (const asin of b.asins) { if (!(asin in b.upcs)) missingUpcs.push(asin); }
    }
    if (missingUpcs.length > 0) {
      const { fetchUpcsForAsins } = require('./sync/amazon');
      const upcMap = await fetchUpcsForAsins([...new Set(missingUpcs)]);
      for (const b of freshForUpc.brands) {
        for (const asin of b.asins) { if (!(asin in b.upcs)) b.upcs[asin] = upcMap[asin] || ''; }
      }
      await saveBrands(freshForUpc);
      console.log(`[${tag}] UPC scrape done — ${Object.values(upcMap).filter(Boolean).length} new UPCs`);
    }

    // Listing health enrichment — buy box owners, content snapshots, variations.
    // Mutates brands.buyBoxOwners / listingSnapshots / recentAlerts in place.
    try {
      const { enrichListingHealth, scrapeSellerNames } = require('./sync/amazon');
      const freshForHealth = await loadBrands();
      await enrichListingHealth(freshForHealth.brands);
      await saveBrands(freshForHealth);
      console.log(`[${tag}] Listing health enrichment complete`);

      // Scrape seller names for any non-RMC winners we don't have a name for yet.
      // Ignore General Wholesale + Unknown Brand to keep the scrape list short.
      const sellerNames = await loadSellerNames();
      const REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // refresh names >30 days old
      const ourSellerId = process.env.SP_API_SELLER_ID;
      const skip = new Set(['general-wholesale', 'unknown-brand']);
      const idsByMp = { CA: new Set(), US: new Set() };
      for (const b of freshForHealth.brands) {
        if (skip.has(b.id)) continue;
        const mp = b.marketplace === 'US' ? 'US' : 'CA';
        for (const hist of Object.values(b.buyBoxOwnerHistory || {})) {
          for (const h of hist) {
            if (!h.sellerId || h.sellerId === ourSellerId) continue;
            const cached = sellerNames[h.sellerId];
            const stale = cached?.scrapedAt && (Date.now() - new Date(cached.scrapedAt).getTime() > REFRESH_MS);
            if (!cached || stale) idsByMp[mp].add(h.sellerId);
          }
        }
      }
      const toScrapeCa = [...idsByMp.CA];
      const toScrapeUs = [...idsByMp.US];
      if (toScrapeCa.length || toScrapeUs.length) {
        const [caNames, usNames] = await Promise.all([
          scrapeSellerNames(toScrapeCa, 'CA'),
          scrapeSellerNames(toScrapeUs, 'US'),
        ]);
        const updated = { ...sellerNames, ...caNames, ...usNames };
        await saveSellerNames(updated);
        console.log(`[${tag}] Seller name cache updated: +${Object.keys(caNames).length + Object.keys(usNames).length} new`);
      } else {
        console.log(`[${tag}] Seller name cache up to date — no new IDs to scrape`);
      }
    } catch (healthErr) {
      console.warn(`[${tag}] Listing health enrichment failed (non-fatal):`, healthErr.message);
    }
  } catch (err) {
    syncState = { status: 'error', lastSync: null, error: err.message };
    console.error(`[${tag}] Error:`, err.message);
  }
}

// ── Daily auto-sync at 6am server time ───────────────────────────────────────
function scheduleDailySync() {
  // Primary sync: 6am UTC (midnight MDT). Backup: 9am UTC (3am MDT) and 12pm UTC (6am MDT).
  // If the 6am sync succeeds, the 9am and 12pm ones are instant no-ops (sync guard + 23h check).
  cron.schedule('0 6 * * *', () => {
    console.log('[AutoSync] 6am UTC cron fired');
    runFullSync('AutoSync-6am');
  });
  cron.schedule('0 9 * * *', () => {
    console.log('[AutoSync] 9am UTC backup cron fired');
    runFullSync('AutoSync-9am');
  });
  cron.schedule('0 12 * * *', () => {
    console.log('[AutoSync] 12pm UTC backup cron fired');
    runFullSync('AutoSync-12pm');
  });

  // Slack health digest — 7am UTC daily → #account-health
  if (process.env.SLACK_DIGEST_ENABLED === 'true') {
    cron.schedule('0 7 * * *', async () => {
      console.log('[SlackDigest] 7am UTC cron fired');
      try {
        const settings = await loadPoSettings();
        const sinceIso = settings.lastDigestAt || new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        const report = await computeHealthReport({ sinceIso });
        const { postSlackDigest } = require('./slack/digest');
        const result = await postSlackDigest({
          ...report,
          dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000/brands.html'
        });
        if (result.posted) {
          await savePoSettings({ ...settings, lastDigestAt: new Date().toISOString() });
        }
      } catch (err) {
        console.error('[SlackDigest] cron error:', err.message);
      }
    });
    console.log('[AutoSync] Slack digest enabled — fires 7am UTC → #account-health');
  }

  // Orders poller: every 15 min for intraday revenue/units (~15 min lag)
  cron.schedule('*/15 * * * *', () => {
    ordersPoller.poll()
      .then(() => persistOrdersTodayState())
      .catch(err => console.warn('[Orders] Poll error:', err.message));
  });

  // Hourly fresh rebuildToday — wipes today's in-memory state and re-fetches
  // every order from scratch (with the retry pass) so any rate-limit drops from
  // the 15-min incremental polls are caught the same day, not 24h later.
  // Runs at :05 so it doesn't clash with the *:00 / *:15 / *:30 / *:45 polls.
  cron.schedule('5 * * * *', () => {
    ordersPoller.rebuildToday()
      .then(() => persistOrdersTodayState())
      .catch(err => console.warn('[Orders] Hourly rebuild error:', err.message));
  });

  // Yesterday finalize: 8:30am UTC (~1:30am PDT, after PST rollover). Re-pulls
  // yesterday from Orders API so its units/revenue are complete & authoritative.
  cron.schedule('30 8 * * *', () => {
    finalizeYesterdayFromOrders()
      .catch(err => console.warn('[Orders] Yesterday finalize error:', err.message));
  });

  // Backfill: 8am UTC daily — fills any missing daily_metrics gaps (runs 2h after main sync)
  cron.schedule('0 8 * * *', () => {
    const { backfillDays } = require('./sync/backfill');
    loadBrands().then(({ brands }) => backfillDays(supabase, brands, 7))
      .catch(err => console.warn('[Backfill] cron error:', err.message));
  });

  // Image backfill: 10am UTC daily — fetches images for up to 100 missing/stale
  // ASINs via Catalog API and writes to Supabase asin_images table. Bounded
  // per run; full catalog refreshes every ~4 days.
  cron.schedule('0 10 * * *', () => {
    console.log('[Images] 10 UTC cron fired');
    (async () => {
      const { brands } = await loadBrands();
      await backfillMissingImages(supabase, brands, { limit: 100 });
      await refreshImagesCache();
    })().catch(err => console.warn('[Images] cron error:', err.message));
  });

  // Image cache refresh: hourly. Pulls latest asin_images map into memory so
  // /api/metrics responses always see fresh URLs (in case manual overrides
  // were set or another instance updated rows).
  cron.schedule('30 * * * *', () => {
    refreshImagesCache().catch(err => console.warn('[Images] hourly refresh:', err.message));
  });

  // Daily ad-spend sync: 9:10am UTC — pulls last 30 days of Sponsored Products
  // spend with timeUnit:DAILY, writes spend_cad/spend_usd into daily_metrics.
  cron.schedule('10 9 * * *', () => {
    console.log('[AdsDaily] 9:10 UTC daily-30d cron fired');
    syncDailyAdSpend({ windowDays: 30, includeToday: true })
      .catch(err => console.warn('[AdsDaily] cron error:', err.message));
  });

  // Today + yesterday only, every 2 hours (at :20). Lightweight — pulls
  // just 2 days of data so today's tile populates throughout the day as
  // Amazon publishes spend (typically 1-3h lag from the impression/click).
  cron.schedule('20 */2 * * *', () => {
    console.log('[AdsDaily] :20 hourly today+yesterday cron fired');
    syncDailyAdSpend({ windowDays: 1, includeToday: true })
      .catch(err => console.warn('[AdsDaily] hourly error:', err.message));
  });

  // Refunds sync: 9:15am UTC daily — pulls last 60 days of refund events,
  // attributes each to the original order's PST date, writes per-(asin,date)
  // refund totals to daily_metrics. Idempotent via refund_events PK.
  cron.schedule('15 9 * * *', () => {
    console.log('[Refunds] 9:15am UTC cron fired');
    (async () => {
      const { syncRefunds } = require('./sync/refunds');
      const { brands } = await loadBrands();
      await syncRefunds(supabase, brands, { windowDays: 60 });
    })().catch(err => console.warn('[Refunds] cron error:', err.message));
  });

  // Daily data-integrity audit: 9am UTC (after 8:30 finalize). Deterministic checks
  // + optional Claude review, posts to Slack.
  cron.schedule('0 9 * * *', () => {
    console.log('[Audit] 9am UTC cron fired');
    const { runDailyAudit } = require('./audit');
    runDailyAudit(supabase)
      .catch(err => console.warn('[Audit] cron error:', err.message));
  });

  console.log('[AutoSync] Crons scheduled: sync 6am/9am/12pm UTC, Slack digest 7am UTC, Orders poll */15min, Orders hourly-rebuild :05, Yesterday-finalize 8:30 UTC, Backfill 8am UTC, Audit 9am UTC, AdsDaily 9:10 UTC + */2h :20, Refunds 9:15 UTC, Images backfill 10 UTC + :30 hourly refresh');

  // Load image cache at startup so first requests see images.
  refreshImagesCache().catch(err => console.warn('[Images] Startup load:', err.message));

  // On startup: catch-up if data is more than 23h old AND no attempt in last 4h
  (async () => {
    try {
      const pm = await loadPresetMetrics();
      const lastSyncTime    = pm.lastSync        ? new Date(pm.lastSync).getTime()        : 0;
      const lastAttemptTime = pm.lastSyncAttempt ? new Date(pm.lastSyncAttempt).getTime() : 0;
      const hoursSince      = (Date.now() - lastSyncTime)    / (1000 * 60 * 60);
      const hoursSinceAttempt = (Date.now() - lastAttemptTime) / (1000 * 60 * 60);

      if (hoursSince < 23) {
        console.log(`[AutoSync] Data is ${Math.round(hoursSince)}h old — no catch-up needed`);
      } else if (hoursSinceAttempt < 4) {
        console.log(`[AutoSync] Data is ${Math.round(hoursSince)}h old but sync attempted ${Math.round(hoursSinceAttempt * 60)}min ago — skipping to avoid quota burn`);
      } else {
        console.log(`[AutoSync] Data is ${Math.round(hoursSince)}h old — running catch-up sync now`);
        setTimeout(() => runFullSync('CatchUp'), 5000);
      }
    } catch (e) {
      console.warn('[AutoSync] Could not check last sync time:', e.message);
    }

    // Rebuild today's intraday state on startup, then persist to daily_metrics.
    // Yesterday is served directly from daily_metrics — no in-memory rebuild needed.
    setTimeout(() => {
      ordersPoller.rebuildToday()
        .then(() => persistOrdersTodayState())
        .catch(err => console.warn('[Orders] Startup rebuild error:', err.message));
    }, 10000);

    // Startup backfill: fill up to 7 missing days (14 report creates, safely under burst quota of 15)
    setTimeout(() => {
      const { backfillDays } = require('./sync/backfill');
      loadBrands().then(({ brands }) => backfillDays(supabase, brands, 7))
        .catch(err => console.warn('[Backfill] startup error:', err.message));
    }, 30000);
  })();
}
