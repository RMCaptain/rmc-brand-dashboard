require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Data helpers ---

function loadBrands() {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brands.json'), 'utf8'));
}

function saveBrands(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'brands.json'), JSON.stringify(data, null, 2));
}

function loadMetrics() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'metrics.json'), 'utf8'));
  } catch {
    return { syncStatus: 'pending', lastSync: null, brands: {} };
  }
}

function saveMetrics(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'metrics.json'), JSON.stringify(data, null, 2));
}

function loadPresetMetrics() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preset-metrics.json'), 'utf8'));
  } catch {
    return { lastSync: null, presets: {} };
  }
}

function savePresetMetrics(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'preset-metrics.json'), JSON.stringify(data, null, 2));
}

function loadFx() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'fx.json'), 'utf8'));
    if (data.fetched && (Date.now() - new Date(data.fetched)) < 24 * 60 * 60 * 1000) return data;
  } catch {}
  return null;
}

function saveFx(data) {
  fs.writeFileSync(path.join(DATA_DIR, 'fx.json'), JSON.stringify(data, null, 2));
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

const BRAND_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6',
  '#f97316', '#84cc16', '#06b6d4', '#a855f7'
];

// --- Brand Routes ---

// GET all brands with metrics merged in
app.get('/api/brands', (req, res) => {
  const { brands } = loadBrands();
  const pm = loadPresetMetrics();
  const presetKey = req.query.preset || 'last7d';
  const presetData = pm.presets?.[presetKey]?.brands || {};
  const result = brands.map(b => ({
    ...b,
    metrics: presetData[b.id] || null
  }));
  const presetMeta = Object.fromEntries(
    Object.entries(pm.presets || {}).map(([k, v]) => [k, { label: v.label, startDate: v.startDate, endDate: v.endDate }])
  );
  res.json({ brands: result, lastSync: pm.lastSync, presets: presetMeta });
});

// GET single brand with metrics
app.get('/api/brands/:id', (req, res) => {
  const { brands } = loadBrands();
  const pm = loadPresetMetrics();
  const presetKey = req.query.preset || 'last7d';
  const presetData = pm.presets?.[presetKey]?.brands || {};
  const brand = brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  const presetMeta = Object.fromEntries(
    Object.entries(pm.presets || {}).map(([k, v]) => [k, { label: v.label, startDate: v.startDate, endDate: v.endDate }])
  );
  res.json({ ...brand, metrics: presetData[brand.id] || null, lastSync: pm.lastSync, presets: presetMeta });
});

// POST create brand
app.post('/api/brands', (req, res) => {
  const { name, marketplace } = req.body;
  if (!name) return res.status(400).json({ error: 'Brand name is required' });

  const data = loadBrands();
  const id = slugify(name);

  if (data.brands.find(b => b.id === id)) {
    return res.status(409).json({ error: 'A brand with that name already exists' });
  }

  const color = BRAND_COLORS[data.brands.length % BRAND_COLORS.length];
  const newBrand = {
    id,
    name,
    marketplace: marketplace || 'CA',
    color,
    asins: [],
    createdAt: new Date().toISOString().split('T')[0]
  };

  data.brands.push(newBrand);
  saveBrands(data);
  res.json(newBrand);
});

// PUT update brand
app.put('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  const idx = data.brands.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Brand not found' });

  const { name, marketplace, color } = req.body;
  if (name) data.brands[idx].name = name;
  if (marketplace) data.brands[idx].marketplace = marketplace;
  if (color) data.brands[idx].color = color;

  saveBrands(data);
  res.json(data.brands[idx]);
});

// DELETE brand
app.delete('/api/brands/:id', (req, res) => {
  const data = loadBrands();
  data.brands = data.brands.filter(b => b.id !== req.params.id);
  saveBrands(data);
  res.json({ success: true });
});

// POST add ASIN to brand
app.post('/api/brands/:id/asins', (req, res) => {
  const { asin } = req.body;
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) {
    return res.status(400).json({ error: 'Invalid ASIN format (must be 10 alphanumeric characters)' });
  }

  const data = loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  const normalized = asin.trim().toUpperCase();

  // Check if ASIN already assigned to another brand
  const conflict = data.brands.find(b => b.id !== req.params.id && b.asins.includes(normalized));
  if (conflict) {
    return res.status(409).json({ error: `ASIN already assigned to "${conflict.name}"` });
  }

  if (!brand.asins.includes(normalized)) {
    brand.asins.push(normalized);
    saveBrands(data);
  }

  res.json(brand);
});

// PUT move ASIN from one brand to another
app.put('/api/brands/:id/asins/:asin/move', (req, res) => {
  const { toBrandId } = req.body;
  if (!toBrandId) return res.status(400).json({ error: 'toBrandId required' });

  const data = loadBrands();
  const fromBrand = data.brands.find(b => b.id === req.params.id);
  const toBrand = data.brands.find(b => b.id === toBrandId);

  if (!fromBrand) return res.status(404).json({ error: 'Source brand not found' });
  if (!toBrand) return res.status(404).json({ error: 'Destination brand not found' });

  const asin = req.params.asin.toUpperCase();
  fromBrand.asins = fromBrand.asins.filter(a => a !== asin);
  if (!toBrand.asins.includes(asin)) toBrand.asins.push(asin);

  saveBrands(data);
  res.json({ success: true, from: fromBrand, to: toBrand });
});

// POST bulk move ASINs from one brand to another
app.post('/api/brands/:id/asins/bulk-move', (req, res) => {
  const { asins, toBrandId } = req.body;
  if (!Array.isArray(asins) || !toBrandId) return res.status(400).json({ error: 'Invalid payload' });

  const data = loadBrands();
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

  saveBrands(data);
  res.json({ success: true, from: fromBrand, to: toBrand });
});

// DELETE ASIN from brand
app.delete('/api/brands/:id/asins/:asin', (req, res) => {
  const data = loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });

  brand.asins = brand.asins.filter(a => a !== req.params.asin.toUpperCase());
  saveBrands(data);
  res.json(brand);
});

// --- Import Routes ---

// GET preview — pulls brands+ASINs from Amazon, returns grouped result for review
app.get('/api/import/preview', async (req, res) => {
  try {
    const { importBrandsFromAmazon } = require('./sync/amazon');
    const grouped = await importBrandsFromAmazon();
    res.json({ success: true, grouped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST import/all — pulls everything from Amazon and saves directly, no preview
app.post('/api/import/all', async (req, res) => {
  try {
    const { importBrandsFromAmazon } = require('./sync/amazon');
    const grouped = await importBrandsFromAmazon();
    const data = loadBrands();

    // Never move ASINs already assigned — only process new ones
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
          asins: newAsins,
          asinTitles: newTitles,
          createdAt: new Date().toISOString().split('T')[0]
        });
      }
    }

    saveBrands(data);
    res.json({ success: true, brands: data.brands, imported: Object.keys(grouped).length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST confirm — merges approved import into brands.json with any manual renames
// Body: { brands: [{ name, marketplace, asins }] }
app.post('/api/import/confirm', (req, res) => {
  const { brands: incoming } = req.body;
  if (!Array.isArray(incoming)) return res.status(400).json({ error: 'Invalid payload' });

  const data = loadBrands();

  for (const item of incoming) {
    const id = item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const existing = data.brands.find(b => b.id === id);

    if (existing) {
      // Merge ASINs into existing brand
      const merged = new Set([...existing.asins, ...item.asins]);
      existing.asins = [...merged];
    } else {
      // Add new brand
      const color = BRAND_COLORS[data.brands.length % BRAND_COLORS.length];
      data.brands.push({
        id,
        name: item.name,
        marketplace: item.marketplace || 'CA',
        color,
        asins: item.asins,
        createdAt: new Date().toISOString().split('T')[0]
      });
    }
  }

  saveBrands(data);
  res.json({ success: true, brands: data.brands });
});

// --- Sync Routes ---

// POST trigger sync
app.post('/api/sync', async (req, res) => {
  const hasCredentials =
    process.env.SP_API_CLIENT_ID &&
    process.env.SP_API_CLIENT_SECRET &&
    process.env.SP_API_REFRESH_TOKEN;

  if (!hasCredentials) {
    return res.status(503).json({
      success: false,
      message: 'SP-API credentials not configured.'
    });
  }

  try {
    const { syncBrandMetrics } = require('./sync/amazon');
    const data = loadBrands();
    const { presets, updatedBrands } = await syncBrandMetrics(data.brands);
    data.brands = updatedBrands;
    saveBrands(data);
    savePresetMetrics({ lastSync: new Date().toISOString(), presets });
    res.json({ success: true, lastSync: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET sync status
app.get('/api/sync/status', (req, res) => {
  const metrics = loadMetrics();
  res.json({ syncStatus: metrics.syncStatus, lastSync: metrics.lastSync });
});

// GET FX rate (cached 24h)
app.get('/api/fx', async (req, res) => res.json(await fetchFxRate()));

// GET preset metrics
app.get('/api/preset-metrics', (req, res) => {
  res.json(loadPresetMetrics());
});

app.listen(PORT, () => {
  console.log(`RMC Brand Dashboard → http://localhost:${PORT}`);
});
