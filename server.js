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

// Write per-ASIN rows for a single completed day to daily_metrics.
// Called after each sync for "yesterday" to build up the rolling history.
async function writeDailyMetrics(yesterdayBrands, date) {
  if (!yesterdayBrands || !date) return;
  const rows = [];
  for (const [brandId, brandData] of Object.entries(yesterdayBrands)) {
    for (const sku of (brandData.skus || [])) {
      rows.push({
        asin:             sku.asin,
        date,
        brand_id:         brandId,
        units:            sku.units            || 0,
        units_ca:         sku.unitsCad         || 0,
        units_us:         sku.unitsUsd         || 0,
        revenue_cad:      sku.revenueCad       || 0,
        revenue_usd:      sku.revenueUsd       || 0,
        sessions:         sku.sessions         || null,
        page_views:       sku.pageViews        || null,
        buy_box_pct:      sku.buyBox           ?? null,
        inventory_on_hand: sku.inventory?.onHand  ?? null,
        inventory_inbound: sku.inventory?.inbound ?? null,
      });
    }
  }
  if (rows.length === 0) return;
  const { error } = await supabase.from('daily_metrics').upsert(rows, { onConflict: 'asin,date' });
  if (error) console.warn('[DailyMetrics] Write error:', error.message);
  else console.log(`[DailyMetrics] Wrote ${rows.length} rows for ${date}`);
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
  res.json({ ...brand, metrics: presetData[brand.id] || null, lastSync: pm.lastSync, presets: presetMeta });
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

app.get('/api/pos', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select('id, po_number, brand_id, brand_name, status, created_at, updated_at')
      .order('updated_at', { ascending: false });
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

    // Idempotency guard: if a row with the same po_number + brand already exists, update it
    // instead of creating a duplicate. Prevents double-clicks / retries from forking saves.
    if (poNum != null && brand_id) {
      const { data: existing } = await supabase
        .from('purchase_orders')
        .select('id')
        .eq('po_number', poNum)
        .eq('brand_id', brand_id)
        .maybeSingle();
      if (existing?.id) {
        const { data: updated, error: uerr } = await supabase
          .from('purchase_orders')
          .update({ brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
          .select().single();
        if (uerr) throw uerr;
        return res.json(updated);
      }
    }

    const { data: row, error } = await supabase
      .from('purchase_orders')
      .insert({ po_number: poNum, brand_id, brand_name, status: status || 'draft', data, updated_at: new Date().toISOString() })
      .select().single();
    if (error) throw error;
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pos/:id', async (req, res) => {
  try {
    const { data, error } = await supabase.from('purchase_orders').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/pos/:id', async (req, res) => {
  try {
    const { po_number, brand_id, brand_name, status, data } = req.body;
    const poNum = po_number != null && po_number !== '' ? Number(po_number) : null;
    if (poNum != null && (!Number.isFinite(poNum) || poNum < 0)) {
      return res.status(400).json({ error: 'po_number must be a non-negative number' });
    }
    const { data: row, error } = await supabase
      .from('purchase_orders')
      .update({ po_number: poNum, brand_id, brand_name, status, data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json(row);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pos/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('purchase_orders').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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

app.post('/api/po/generate-pdf', async (req, res) => {
  try {
    const { brandId, lines, status, notes, poNumber, date, optionalCols } = req.body;
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

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
    const { brandId, lines, status, notes, poNumber, date, optionalCols } = req.body;
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

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
        imageUrl:           meta.imageUrl || null,
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

  res.json({
    date:       yest,
    updatedAt:  new Date().toISOString(),
    label:      'Yesterday',
    startDate:  yest,
    endDate:    yest,
    brands:     byBrand,
    // Pass through financials (fees, refunds, ad spend totals) from S&T preset.
    // Empty until the next sync runs with PST boundaries; sales/units are unaffected.
    financials: stPreset.financials || {},
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
        imageUrl: null,
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

  res.json({
    date:      today,
    updatedAt: todayState.updatedAt,
    label:     'Today',
    startDate: today,
    endDate:   today,
    brands:    byBrand,
  });
});

// Write the orders poller's current today state into daily_metrics. Lets the today
// endpoint serve persisted data immediately on restart, no waiting for rebuild.
async function persistOrdersTodayState() {
  try {
    const st = ordersPoller.getState();
    if (!st.date || Object.keys(st.byAsin).length === 0) return;

    const { brands } = await loadBrands();
    const asinBrand = {};
    for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

    const rows = Object.entries(st.byAsin).map(([asin, d]) => ({
      asin,
      date:        st.date,
      brand_id:    asinBrand[asin] || 'unknown-brand',
      units:       d.units      || 0,
      units_ca:    d.unitsCa    || 0,
      units_us:    d.unitsUs    || 0,
      revenue_cad: Math.round((d.revenueCad || 0) * 100) / 100,
      revenue_usd: Math.round((d.revenueUsd || 0) * 100) / 100,
    }));
    if (rows.length === 0) return;

    const { error } = await supabase
      .from('daily_metrics')
      .upsert(rows, { onConflict: 'asin,date' });
    if (error) console.warn('[Orders] persist error:', error.message);
    else console.log(`[Orders] Persisted ${rows.length} today rows for ${st.date}`);
  } catch (e) {
    console.warn('[Orders] persist exception:', e.message);
  }
}

// Trigger historical daily_metrics backfill — responds immediately, runs in background
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

// Custom date range — aggregates daily_metrics for any arbitrary date span
app.get('/api/metrics', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'from and to params required (YYYY-MM-DD)' });
  }
  if (from > to) return res.status(400).json({ error: 'from must be ≤ to' });

  try {
    const { brands } = await loadBrands();

    const { data: rows, error } = await supabase
      .from('daily_metrics')
      .select('asin,brand_id,units,units_ca,units_us,revenue_cad,revenue_usd,sessions,page_views,buy_box_pct')
      .gte('date', from)
      .lte('date', to);

    if (error) throw new Error(error.message);

    // Sum all fields per ASIN across days
    const byAsin = {};
    for (const row of (rows || [])) {
      if (!byAsin[row.asin]) {
        byAsin[row.asin] = { brand_id: row.brand_id, units: 0, units_ca: 0, units_us: 0, revenue_cad: 0, revenue_usd: 0, sessions: 0, page_views: 0, bb_sum: 0, bb_count: 0 };
      }
      const a = byAsin[row.asin];
      a.units       += row.units       || 0;
      a.units_ca    += row.units_ca    || 0;
      a.units_us    += row.units_us    || 0;
      a.revenue_cad += row.revenue_cad || 0;
      a.revenue_usd += row.revenue_usd || 0;
      if (row.sessions    != null) a.sessions    += row.sessions;
      if (row.page_views  != null) a.page_views  += row.page_views;
      if (row.buy_box_pct != null) { a.bb_sum += row.buy_box_pct; a.bb_count++; }
    }

    // Build brand-keyed result — same shape as preset_metrics brands
    const resultBrands = {};
    for (const brand of brands) {
      let bUnits = 0, bUnitsCa = 0, bUnitsUs = 0, bRevCad = 0, bRevUsd = 0, bSessions = 0, bPageViews = 0;
      const skus = [];

      for (const asin of (brand.asins || [])) {
        const a = byAsin[asin];
        if (!a) continue;
        const buyBox = a.bb_count > 0 ? Math.round(a.bb_sum / a.bb_count * 100) / 100 : null;
        skus.push({
          asin,
          title:      brand.asinTitles?.[asin] || null,
          units:      a.units,
          unitsCad:   a.units_ca,
          unitsUsd:   a.units_us,
          revenueCad: Math.round(a.revenue_cad * 100) / 100,
          revenueUsd: Math.round(a.revenue_usd * 100) / 100,
          sessions:   a.sessions   || null,
          pageViews:  a.page_views || null,
          buyBox,
        });
        bUnits    += a.units;      bUnitsCa  += a.units_ca;    bUnitsUs  += a.units_us;
        bRevCad   += a.revenue_cad; bRevUsd   += a.revenue_usd;
        bSessions += a.sessions;   bPageViews += a.page_views;
      }

      if (!skus.length) continue;
      resultBrands[brand.id] = {
        summary: {
          units:      bUnits,
          unitsCad:   bUnitsCa,
          unitsUsd:   bUnitsUs,
          revenueCad: Math.round(bRevCad * 100) / 100,
          revenueUsd: Math.round(bRevUsd * 100) / 100,
          sessions:   bSessions   || null,
          pageViews:  bPageViews  || null,
        },
        skus,
      };
    }

    const fmtD = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
    res.json({ from, to, label: `${fmtD(from)} – ${fmtD(to)}`, startDate: from, endDate: to, brands: resultBrands });
  } catch (err) {
    console.error('[Metrics] Custom range error:', err.message);
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

    // Query daily_metrics for both periods in parallel
    const [{ data: currRows }, { data: prevRows }, { data: invRows }] = await Promise.all([
      supabase.from('daily_metrics')
        .select('asin,date,units,units_ca,units_us,revenue_cad,revenue_usd,sessions,page_views,buy_box_pct')
        .gte('date', fromStr).lte('date', toStr),
      supabase.from('daily_metrics')
        .select('asin,date,units,units_ca,units_us,revenue_cad,revenue_usd')
        .gte('date', compFromStr).lte('date', compToStr),
      supabase.from('daily_metrics')
        .select('asin,inventory_on_hand')
        .lte('date', toStr)
        .not('inventory_on_hand', 'is', null)
        .order('date', { ascending: false }),
    ]);

    // Latest inventory per ASIN (first row per ASIN since ordered desc)
    const invByAsin = {};
    for (const r of (invRows || [])) {
      if (!(r.asin in invByAsin)) invByAsin[r.asin] = r.inventory_on_hand;
    }

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

  // Backfill: 8am UTC daily — fills any missing daily_metrics gaps (runs 2h after main sync)
  cron.schedule('0 8 * * *', () => {
    const { backfillDays } = require('./sync/backfill');
    loadBrands().then(({ brands }) => backfillDays(supabase, brands, 7))
      .catch(err => console.warn('[Backfill] cron error:', err.message));
  });

  console.log('[AutoSync] Crons scheduled: sync 6am/9am/12pm UTC, Slack digest 7am UTC, Orders poll */15min, Backfill 8am UTC');

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
