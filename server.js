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

// In-memory sync state (resets on redeploy, which is fine)
let syncState = { status: 'idle', lastSync: null, error: null };

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

    // Collect all ASINs never checked (key absence = never checked)
    const allMissing = [];
    for (const brand of data.brands) {
      brand.upcs = brand.upcs || {};
      for (const asin of brand.asins) {
        if (!(asin in brand.upcs)) allMissing.push({ brandId: brand.id, asin });
      }
    }

    if (allMissing.length === 0) return res.json({ updated: 0, message: 'All ASINs already checked' });

    const uniqueAsins = [...new Set(allMissing.map(x => x.asin))];
    const upcMap = await fetchUpcsForAsins(uniqueAsins);

    let updated = 0;
    for (const brand of data.brands) {
      for (const asin of brand.asins) {
        if (!(asin in brand.upcs)) {
          brand.upcs[asin] = upcMap[asin] || '';
          if (upcMap[asin]) updated++;
        }
      }
    }
    await saveBrands(data);
    res.json({ updated, total: allMissing.length });
  } catch (err) {
    console.error('[scrape-upcs-all]', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT set ASIN config (type: single | multipack | bundle)
app.put('/api/brands/:id/asins/:asin/config', async (req, res) => {
  const { type, unitsPerPack, components } = req.body;
  const data = await loadBrands();
  const brand = data.brands.find(b => b.id === req.params.id);
  if (!brand) return res.status(404).json({ error: 'Brand not found' });
  brand.asinConfig = brand.asinConfig || {};
  brand.asinConfig[req.params.asin.toUpperCase()] = {
    type: type || 'single',
    unitsPerPack: unitsPerPack ? Number(unitsPerPack) : null,
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
  const { data, error } = await supabase.from('po_settings').select('data').eq('id', 'main').single();
  if (error || !data?.data) return defaults;
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

app.get('/api/po/settings', async (req, res) => {
  res.json(await loadPoSettings());
});

app.put('/api/po/settings', async (req, res) => {
  const settings = await loadPoSettings();
  const { billTo, shipTo, lastPoNumber } = req.body;
  if (billTo) settings.billTo = { ...settings.billTo, ...billTo };
  if (shipTo) settings.shipTo = { ...settings.shipTo, ...shipTo };
  if (lastPoNumber != null) settings.lastPoNumber = lastPoNumber;
  await savePoSettings(settings);
  res.json(settings);
});

// POST generate PO PDF
app.post('/api/po/generate-pdf', async (req, res) => {
  try {
    const puppeteer = require('puppeteer');
    const { brandId, lines, status, notes, poNumber, date, optionalCols } = req.body;

    const settings = await loadPoSettings();
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const poNum = poNumber || (settings.lastPoNumber + 1);
    settings.lastPoNumber = poNum;
    await savePoSettings(settings);

    const poDate = date || new Date().toLocaleDateString('en-CA');
    const statusVal = status || 'Working';
    const isSubmitted = statusVal.toLowerCase() === 'submitted';

    const extras = optionalCols || {};
    const colHeaders = ['Item Description', 'UPC'];
    if (extras.stockNumber)    colHeaders.push('Stock #');
    colHeaders.push('# of Cases', 'Price');
    if (extras.wholesalePrice) colHeaders.push('Wholesale Price');
    if (extras.discountPct)    colHeaders.push('Discount %');
    if (extras.qtyPerCase)     colHeaders.push('Qty/Case');
    colHeaders.push('Quantity', 'Total');

    let subtotal = 0;
    const validLines = (lines || []).filter(l => l.description || l.asin);
    const lineRows = validLines.map(line => {
      const qty   = Number(line.quantity) || 0;
      const price = Number(line.price)    || 0;
      const total = qty * price;
      subtotal += total;
      const fmt = v => '$' + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      const cells = [
        `<td class="desc">${line.description || line.asin || ''}</td>`,
        `<td>${line.upc || ''}</td>`,
        extras.stockNumber    ? `<td>${line.stockNumber || ''}</td>` : '',
        `<td>${line.cases || 0}</td>`,
        `<td>${fmt(price)}</td>`,
        extras.wholesalePrice ? `<td>${fmt(Number(line.wholesalePrice)||0)}</td>` : '',
        extras.discountPct    ? `<td>${line.discountPct != null ? Number(line.discountPct)+'%' : ''}</td>` : '',
        extras.qtyPerCase     ? `<td>${line.casePack || ''}</td>` : '',
        `<td>${qty}</td>`,
        `<td>${fmt(total)}</td>`,
      ].join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    const fmt = v => '$' + Number(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    const logoPath = 'C:\\Users\\jdsie\\Downloads\\RMC Logo PNG (1) (1).png';
    let logoDataUrl = '';
    try {
      const fs = require('fs');
      const imgBuf = fs.readFileSync(logoPath);
      logoDataUrl = `data:image/png;base64,${imgBuf.toString('base64')}`;
    } catch {}

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
        <span class="status-badge">${statusVal}</span>
      </div>
      <div class="date-block">
        <span class="date-label">Date:</span>
        <span class="date-val">${poDate}</span>
      </div>
    </div>
  </div>

  <!-- Info grid -->
  <div class="info-grid">
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Name of Vendor:</span><span class="info-val">${brand.vendor?.name || ''}</span></div>
      <div class="info-row"><span class="info-lbl">Vendor Address:</span><span class="info-val">${brand.vendor?.address || ''}</span></div>
      <div class="info-row"><span class="info-lbl">City/Province/Postal:</span><span class="info-val">${brand.vendor?.city || ''}</span></div>
      <div class="info-row"><span class="info-lbl">Vendor Phone:</span><span class="info-val">${brand.vendor?.phone || ''}</span></div>
      <div class="info-row"><span class="info-lbl">&nbsp;</span><span class="info-val"></span></div>
    </div>
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Bill To (Name):</span><span class="info-val">${settings.billTo.name}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Address:</span><span class="info-val">${settings.billTo.address}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To City/State/Zip:</span><span class="info-val">${settings.billTo.city}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Phone:</span><span class="info-val">${settings.billTo.phone}</span></div>
      <div class="info-row"><span class="info-lbl">Bill To Email:</span><span class="info-val">${settings.billTo.email}</span></div>
    </div>
    <div class="info-col">
      <div class="info-row"><span class="info-lbl">Ship To (Name):</span><span class="info-val">${settings.shipTo.name}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Address:</span><span class="info-val">${settings.shipTo.address}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To City/State/Zip:</span><span class="info-val">${settings.shipTo.city}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Phone:</span><span class="info-val">${settings.shipTo.phone}</span></div>
      <div class="info-row"><span class="info-lbl">Ship To Email:</span><span class="info-val">${settings.shipTo.email}</span></div>
    </div>
  </div>

  <!-- Line items table -->
  <table>
    <thead>
      <tr>
        <th class="desc">Item Description</th>
        <th>UPC</th>
        ${extras.stockNumber    ? '<th>Stock #</th>' : ''}
        <th># of Cases</th>
        <th>Price</th>
        ${extras.wholesalePrice ? '<th>Wholesale Price</th>' : ''}
        ${extras.discountPct    ? '<th>Discount %</th>' : ''}
        ${extras.qtyPerCase     ? '<th>Qty/Case</th>' : ''}
        <th>Quantity</th>
        <th>Total</th>
      </tr>
    </thead>
    <tbody>${lineRows}</tbody>
  </table>

  <!-- Totals -->
  <div class="totals">
    <table class="totals-table">
      <tr><td class="lbl">Subtotal</td><td class="val">${fmt(subtotal)}</td></tr>
      <tr><td class="lbl">Tax</td><td class="val">$0.00</td></tr>
      <tr><td class="lbl">Shipping</td><td class="val">$0.00</td></tr>
      <tr class="grand"><td class="lbl">Grand Total</td><td class="val">${fmt(subtotal)}</td></tr>
    </table>
  </div>

  <!-- Notes -->
  <div class="notes-header">Comments / Notes</div>
  <div class="notes-body">${notes || ''}</div>

</div>
</body>
</html>`;

    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      executablePath: puppeteer.executablePath()
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // Measure actual content height so PDF never clips regardless of item count
    const contentHeight = await page.evaluate(() => document.body.scrollHeight);
    const pdfData = await page.pdf({
      width: '8.5in',
      height: (contentHeight + 40) + 'px',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });
    await browser.close();

    const pdfBuf = Buffer.isBuffer(pdfData) ? pdfData : Buffer.from(pdfData);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuf.length);
    res.setHeader('Content-Disposition', `attachment; filename="PO-${poNum}-${brand.name.replace(/[^a-z0-9]/gi, '-')}.pdf"`);
    res.end(pdfBuf);

  } catch (err) {
    console.error('[PO PDF] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST generate PO Excel
app.post('/api/po/generate', async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const { brandId, lines, status, notes, poNumber, date, optionalCols } = req.body;

    const settings = await loadPoSettings();
    const { brands } = await loadBrands();
    const brand = brands.find(b => b.id === brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Increment PO number
    const poNum = poNumber || (settings.lastPoNumber + 1);
    settings.lastPoNumber = poNum;
    await savePoSettings(settings);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Purchase Order');

    // Optional columns config
    const extras = optionalCols || {};

    // Build column header list early so we can calculate lastDataCol
    const colHeaders = ['Item Description', 'UPC'];
    if (extras.stockNumber)    colHeaders.push('Stock #');
    colHeaders.push('# of Cases', 'Price');
    if (extras.wholesalePrice) colHeaders.push('Wholesale Price');
    if (extras.discountPct)    colHeaders.push('Discount %');
    if (extras.qtyPerCase)     colHeaders.push('Qty/Case');
    colHeaders.push('Quantity', 'Total');
    const lastDataCol = 2 + colHeaders.length; // data cols start at 3, so last = 2 + count

    // ── Column widths ────────────────────────────────────────────────
    const colDefs = [
      { key: 'a', width: 2 },
      { key: 'b', width: 16 },  // logo column
      { key: 'c', width: 38 },  // Item Description
      { key: 'd', width: 18 },  // UPC
      ...(extras.stockNumber    ? [{ key: 'sn', width: 14 }] : []),
      { key: 'e', width: 12 },  // # of Cases
      { key: 'f', width: 14 },  // Price
      ...(extras.wholesalePrice ? [{ key: 'wp', width: 14 }] : []),
      ...(extras.discountPct    ? [{ key: 'dp', width: 12 }] : []),
      ...(extras.qtyPerCase     ? [{ key: 'qc', width: 14 }] : []),
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
    const logoPath = 'C:\\Users\\jdsie\\Downloads\\RMC Logo PNG (1) (1).png';
    try {
      const logoId = wb.addImage({ filename: logoPath, extension: 'png' });
      ws.addImage(logoId, { tl: { col: 0, row: 0 }, br: { col: 2, row: 5 }, editAs: 'oneCell' });
    } catch {}

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
    mergeStyle(2, 7, 8, status || 'Working', { name: 'Calibri', bold: true, size: 10, color: { argb: 'FF' + statusTextColor } }, statusColor, center);

    // "Date:" label in I(9), date value in J(10)
    const dateLabelCell = cell(2, 9);
    dateLabelCell.value = 'Date:';
    dateLabelCell.font = { name: 'Calibri', bold: true, size: 10 };
    dateLabelCell.alignment = right;
    const dateValCell = cell(2, 10);
    dateValCell.value = date || new Date().toLocaleDateString('en-CA');
    dateValCell.font = { name: 'Calibri', bold: true, size: 10 };
    dateValCell.alignment = left;

    // ── Rows 3-4: blank ──────────────────────────────────────────────
    ws.getRow(3).height = 6;
    ws.getRow(4).height = 6;

    // ── Rows 5-9: Vendor | Bill To | Ship To ─────────────────────────
    const infoRows = [
      ['Name of Vendor:', brand.vendor?.name || '', 'Bill To (Name):', settings.billTo.name, 'Ship To (Name):', settings.shipTo.name],
      ['Vendor Address:', brand.vendor?.address || '', 'Bill To Address:', settings.billTo.address, 'Ship To Address:', settings.shipTo.address],
      ['Vendor City/Province/Area Code:', brand.vendor?.city || '', 'Bill To City/State/Zip:', settings.billTo.city, 'Ship To City/State/Zip:', settings.shipTo.city],
      ['Vendor Phone:', brand.vendor?.phone || '', 'Bill To Phone:', settings.billTo.phone, 'Ship To Phone:', settings.shipTo.phone],
      ['', '', 'Bill To Email:', settings.billTo.email, 'Ship To Email:', settings.shipTo.email],
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

    for (const line of (lines || [])) {
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

      setCell('Item Description', line.description || line.asin);
      setCell('UPC', line.upc || '');
      if (extras.stockNumber)    setCell('Stock #',         line.stockNumber || '');
      setCell('# of Cases',      line.cases || 0);
      setCell('Price',           price,  money);
      if (extras.wholesalePrice) setCell('Wholesale Price', Number(line.wholesalePrice) || 0, money);
      if (extras.discountPct)    setCell('Discount %',      line.discountPct != null ? Number(line.discountPct) / 100 : 0, '0.0%');
      if (extras.qtyPerCase)     setCell('Qty/Case',        line.casePack || '');
      setCell('Quantity',        qty);
      setCell('Total',           total, money);

      dataRow++;
    }

    // ── Spacer ────────────────────────────────────────────────────────
    dataRow++;

    // ── Totals block ──────────────────────────────────────────────────
    const totals = [
      ['Subtotal', subtotal],
      ['Tax', 0],
      ['Shipping', 0],
      ['Grand Total', subtotal],
    ];

    const totalLabelCol = lastDataCol - 1;  // Quantity col = second-to-last data col
    const totalValueCol = lastDataCol;      // Total col = last data col

    totals.forEach(([label, value], i) => {
      const r = dataRow + i;
      ws.getRow(r).height = 16;
      const lc = cell(r, totalLabelCol);
      lc.value = label;
      lc.font = { name: 'Calibri', bold: label === 'Grand Total', size: 10 };
      lc.alignment = right;

      const vc = cell(r, totalValueCol);
      vc.value = value;
      vc.font = { name: 'Calibri', bold: label === 'Grand Total', size: 10 };
      vc.numFmt = money;
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
    mergeStyle(dataRow, 3, lastDataCol, notes || '', bodyFont, SALMON, { ...left, wrapText: true });

    // ── Send file ─────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PO-${poNum}-${brand.name.replace(/[^a-z0-9]/gi, '-')}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('[PO] Generate error:', err);
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

  // Return immediately — sync runs in background
  syncState = { status: 'syncing', lastSync: null, error: null };
  res.json({ success: true, status: 'started' });

  (async () => {
    try {
      const { syncBrandMetrics, fetchUpcsForAsins } = require('./sync/amazon');
      const { startAdReports, finishAdReports } = require('./sync/ads');
      const data = await loadBrands();

      // Phase 1: fire ads report creation for all presets BEFORE SP sync starts
      // Reports take ~30 min to generate; SP sync takes ~5-10 min — they overlap.
      let adHandles = {};
      try {
        // Pre-compute preset date ranges (matches what syncBrandMetrics uses)
        const fmt = d => d.toISOString().split('T')[0];
        const today = new Date(); today.setHours(0,0,0,0);
        const yest  = new Date(today); yest.setDate(yest.getDate() - 1);
        const l30s  = new Date(today); l30s.setDate(l30s.getDate() - 30);
        const tms   = new Date(today.getFullYear(), today.getMonth(), 1);
        const lms   = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const lme   = new Date(today.getFullYear(), today.getMonth(), 0);
        const ranges = {
          yesterday:  { startDate: fmt(yest), endDate: fmt(yest) },
          last30d:    { startDate: fmt(l30s), endDate: fmt(yest) },
          thisMonth:  { startDate: fmt(tms),  endDate: fmt(today) },
          lastMonth:  { startDate: fmt(lms),  endDate: fmt(lme)  },
        };
        const entries = await Promise.all(
          Object.entries(ranges).map(async ([key, { startDate, endDate }]) => {
            const handles = await startAdReports(startDate, endDate);
            return [key, { handles, startDate, endDate }];
          })
        );
        adHandles = Object.fromEntries(entries);
        console.log('[Sync] Ads reports submitted — baking while SP sync runs...');
      } catch (adsCreateErr) {
        console.warn('[Sync] Ads report creation failed (non-fatal):', adsCreateErr.message);
      }

      // Phase 2: run SP-API sync while ad reports bake
      const { presets, updatedBrands } = await syncBrandMetrics(data.brands);
      data.brands = updatedBrands;
      await saveBrands(data);

      // Phase 3: collect all ads results in parallel, merge into presets
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
        console.log('[Sync] Ads data merged into presets');
      } catch (adsErr) {
        console.warn('[Sync] Ads collection failed (non-fatal):', adsErr.message);
      }

      const lastSync = new Date().toISOString();
      await savePresetMetrics({ lastSync, presets });
      syncState = { status: 'done', lastSync, error: null };

      // Scrape UPCs for any ASINs not yet checked (never overwrites existing)
      const missingUpcs = [];
      for (const b of data.brands) {
        b.upcs = b.upcs || {};
        for (const asin of b.asins) { if (!(asin in b.upcs)) missingUpcs.push(asin); }
      }
      if (missingUpcs.length > 0) {
        const upcMap = await fetchUpcsForAsins([...new Set(missingUpcs)]);
        for (const b of data.brands) {
          for (const asin of b.asins) { if (!(asin in b.upcs)) b.upcs[asin] = upcMap[asin] || ''; }
        }
        await saveBrands(data);
        console.log(`[Sync] UPC scrape done — ${Object.values(upcMap).filter(Boolean).length} new UPCs`);
      }
    } catch (err) {
      syncState = { status: 'error', lastSync: null, error: err.message };
    }
  })();
});

app.get('/api/sync/status', (req, res) => {
  res.json(syncState);
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

app.listen(PORT, () => {
  console.log(`RMC Brand Dashboard → http://localhost:${PORT}`);
  scheduleDailySync();
});

// ── Daily auto-sync at 6am server time ───────────────────────────────────────
function scheduleDailySync() {
  function msUntil6am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function runSync() {
    if (syncState.status === 'syncing') {
      console.log('[AutoSync] Skipped — sync already in progress');
      return;
    }
    console.log('[AutoSync] Starting scheduled 6am sync...');
    syncState = { status: 'syncing', lastSync: null, error: null };
    (async () => {
      try {
        const { syncBrandMetrics, fetchUpcsForAsins } = require('./sync/amazon');
        const { startAdReports, finishAdReports } = require('./sync/ads');
        const data = await loadBrands();

        // Phase 1: kick off all ads reports before SP sync
        let adHandles = {};
        try {
          const fmt = d => d.toISOString().split('T')[0];
          const today = new Date(); today.setHours(0,0,0,0);
          const yest  = new Date(today); yest.setDate(yest.getDate() - 1);
          const l30s  = new Date(today); l30s.setDate(l30s.getDate() - 30);
          const tms   = new Date(today.getFullYear(), today.getMonth(), 1);
          const lms   = new Date(today.getFullYear(), today.getMonth() - 1, 1);
          const lme   = new Date(today.getFullYear(), today.getMonth(), 0);
          const ranges = {
            yesterday:  { startDate: fmt(yest), endDate: fmt(yest) },
            last30d:    { startDate: fmt(l30s), endDate: fmt(yest) },
            thisMonth:  { startDate: fmt(tms),  endDate: fmt(today) },
            lastMonth:  { startDate: fmt(lms),  endDate: fmt(lme)  },
          };
          const entries = await Promise.all(
            Object.entries(ranges).map(async ([key, { startDate, endDate }]) => {
              const handles = await startAdReports(startDate, endDate);
              return [key, { handles, startDate, endDate }];
            })
          );
          adHandles = Object.fromEntries(entries);
          console.log('[AutoSync] Ads reports submitted — baking while SP sync runs...');
        } catch (adsCreateErr) {
          console.warn('[AutoSync] Ads report creation failed (non-fatal):', adsCreateErr.message);
        }

        // Phase 2: SP-API sync
        const { presets, updatedBrands } = await syncBrandMetrics(data.brands);
        data.brands = updatedBrands;
        await saveBrands(data);

        // Phase 3: collect all ads results in parallel
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
          console.log('[AutoSync] Ads data merged');
        } catch (adsErr) {
          console.warn('[AutoSync] Ads collection failed (non-fatal):', adsErr.message);
        }

        const lastSync = new Date().toISOString();
        await savePresetMetrics({ lastSync, presets });
        syncState = { status: 'done', lastSync, error: null };
        console.log('[AutoSync] Done:', lastSync);

        // Scrape UPCs for any new ASINs (never overwrites existing)
        const missingUpcs = [];
        for (const b of data.brands) {
          b.upcs = b.upcs || {};
          for (const asin of b.asins) { if (!(asin in b.upcs)) missingUpcs.push(asin); }
        }
        if (missingUpcs.length > 0) {
          const upcMap = await fetchUpcsForAsins([...new Set(missingUpcs)]);
          for (const b of data.brands) {
            for (const asin of b.asins) { if (!(asin in b.upcs)) b.upcs[asin] = upcMap[asin] || ''; }
          }
          await saveBrands(data);
          console.log(`[AutoSync] UPC scrape done — ${Object.values(upcMap).filter(Boolean).length} new UPCs`);
        }
      } catch (err) {
        syncState = { status: 'error', lastSync: null, error: err.message };
        console.error('[AutoSync] Error:', err.message);
      }
    })();
  }

  // Schedule first run, then repeat every 24h
  const delay = msUntil6am();
  console.log(`[AutoSync] Next sync in ${Math.round(delay / 60000)} minutes (6am)`);
  setTimeout(() => {
    runSync();
    setInterval(runSync, 24 * 60 * 60 * 1000);
  }, delay);
}
