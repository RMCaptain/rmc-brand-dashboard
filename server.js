require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

// Supabase client (service role — server-side only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors());
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

app.post('/api/sync', async (req, res) => {
  const hasCredentials =
    process.env.SP_API_CLIENT_ID &&
    process.env.SP_API_CLIENT_SECRET &&
    process.env.SP_API_REFRESH_TOKEN;

  if (!hasCredentials) {
    return res.status(503).json({ success: false, message: 'SP-API credentials not configured.' });
  }

  try {
    const { syncBrandMetrics } = require('./sync/amazon');
    const data = await loadBrands();
    const { presets, updatedBrands } = await syncBrandMetrics(data.brands);
    data.brands = updatedBrands;
    await saveBrands(data);
    await savePresetMetrics({ lastSync: new Date().toISOString(), presets });
    res.json({ success: true, lastSync: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/fx', async (req, res) => res.json(await fetchFxRate()));

app.get('/api/preset-metrics', async (req, res) => {
  res.json(await loadPresetMetrics());
});

app.listen(PORT, () => {
  console.log(`RMC Brand Dashboard → http://localhost:${PORT}`);
});
