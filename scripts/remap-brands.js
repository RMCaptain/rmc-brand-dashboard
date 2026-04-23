/**
 * Brand Remapping Script
 * Pulls brand attribute from Amazon Catalog API for every known ASIN,
 * then reassigns all ASINs to the correct brand based on that data.
 * Preserves all ASIN-level metadata (COGS, lead times, UPCs, case packs, etc.)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BRAND_COLORS = [
  '#6366f1','#ec4899','#f59e0b','#10b981',
  '#3b82f6','#8b5cf6','#ef4444','#14b8a6',
  '#f97316','#84cc16','#06b6d4','#a855f7'
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizeBrandName(raw) {
  if (!raw) return null;
  return raw.trim()
    .replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .trim();
}

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET
    }).toString();
    const req = https.request({
      hostname: 'api.amazon.com', path: '/auth/o2/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode !== 200) reject(new Error(`LWA: ${json.error_description || json.error}`));
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
    const headers = { 'x-amz-access-token': token, 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: 'sellingpartnerapi-na.amazon.com', path, method, headers }, res => {
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

async function getBrandForAsin(asin, marketplaceIds, token) {
  const mpParam = marketplaceIds.join(',');

  // Try batch first
  for (const mpId of marketplaceIds) {
    const path = `/catalog/2022-04-01/items?marketplaceIds=${mpId}&identifiers=${encodeURIComponent(asin)}&identifiersType=ASIN&includedData=summaries,attributes`;
    try {
      const res = await spRequest('GET', path, token);
      if (res.status === 200) {
        const item = (res.body.items || [])[0];
        if (item) {
          const brand = item.summaries?.[0]?.brandName?.trim() || item.attributes?.brand?.[0]?.value?.trim();
          const title = item.summaries?.[0]?.itemName?.trim() || '';
          if (brand) return { brand, title };
          if (title) return { brand: null, title };
        }
      }
    } catch {}
    await sleep(400);
  }

  // Try individual lookup
  try {
    const path = `/catalog/2022-04-01/items/${asin}?marketplaceIds=${mpParam}&includedData=summaries,attributes`;
    const res = await spRequest('GET', path, token);
    if (res.status === 200) {
      const brand = res.body.summaries?.[0]?.brandName?.trim() || res.body.attributes?.brand?.[0]?.value?.trim();
      const title = res.body.summaries?.[0]?.itemName?.trim() || '';
      return { brand: brand || null, title };
    }
  } catch {}

  return { brand: null, title: '' };
}

async function main() {
  console.log('=== RMC Brand Remapping ===\n');

  // Load current brands from Supabase
  const { data: row, error } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (error || !row?.data?.brands) { console.error('Failed to load brands:', error); process.exit(1); }

  const brands = row.data.brands;
  console.log(`Loaded ${brands.length} brands from Supabase`);

  const marketplaceIds = (process.env.SP_API_MARKETPLACE_IDS || 'ATVPDKIKX0DER').split(',').map(s => s.trim());
  const token = await getAccessToken();
  console.log('Got access token\n');

  // Collect every ASIN across all brands
  const allAsins = [...new Set(brands.flatMap(b => b.asins || []))];
  console.log(`Total unique ASINs: ${allAsins.length}\n`);

  // Collect all ASIN-level metadata so we can carry it forward
  const asinMeta = {};
  for (const brand of brands) {
    for (const asin of (brand.asins || [])) {
      asinMeta[asin] = asinMeta[asin] || {};
      if (brand.cogs?.[asin])       asinMeta[asin].cogs       = brand.cogs[asin];
      if (brand.leadTimes?.[asin])   asinMeta[asin].leadTime   = brand.leadTimes[asin];
      if (brand.upcs?.[asin])        asinMeta[asin].upc        = brand.upcs[asin];
      if (brand.casePacks?.[asin])   asinMeta[asin].casePack   = brand.casePacks[asin];
      if (brand.asinConfig?.[asin])  asinMeta[asin].config     = brand.asinConfig[asin];
      if (brand.asinTitles?.[asin])  asinMeta[asin].title      = brand.asinTitles[asin];
    }
  }

  // Look up brand + title for every ASIN via Catalog API
  console.log('Fetching brand attributes from Amazon Catalog API...');
  const catalogData = {}; // asin → { brand, title }
  for (let i = 0; i < allAsins.length; i++) {
    const asin = allAsins[i];
    process.stdout.write(`  [${i+1}/${allAsins.length}] ${asin} ... `);
    const result = await getBrandForAsin(asin, marketplaceIds, token);
    catalogData[asin] = result;
    console.log(result.brand ? `→ ${result.brand}` : `→ (no brand, title: "${result.title?.slice(0,40)}")`);
    await sleep(600);
  }

  console.log('\nBuilding new brand assignments...');

  // Group ASINs by normalized catalog brand name
  const brandGroups = {}; // normalizedBrandName → [asin, ...]

  for (const asin of allAsins) {
    const { brand, title } = catalogData[asin];
    let brandName = brand ? normalizeBrandName(brand) : null;

    // Fallback: use title starts-with matching against existing brands
    if (!brandName) {
      const existing = brands.filter(b => b.id !== 'unknown-brand');
      const t = (title || '').toLowerCase().trim();
      for (const eb of existing.sort((a, b) => b.name.length - a.name.length)) {
        const bn = eb.name.toLowerCase().trim();
        if (t.startsWith(bn + ' ') || t.startsWith(bn + ',') || t.startsWith(bn + '-') || t === bn) {
          brandName = eb.name;
          break;
        }
      }
    }

    if (!brandName) brandName = 'Unknown Brand';

    if (!brandGroups[brandName]) brandGroups[brandName] = [];
    brandGroups[brandName].push(asin);
  }

  // Build new brands array
  // Start with existing brands (preserve IDs, colors, vendor info, marketplace, etc.)
  const existingByName = {};
  for (const b of brands) {
    const key = normalizeBrandName(b.name) || b.name;
    existingByName[key] = b;
  }

  const newBrands = [];
  const usedExistingIds = new Set(); // prevent same existing brand from being pushed twice
  let colorIdx = brands.filter(b => b.id !== 'unknown-brand').length;

  for (const [brandName, asins] of Object.entries(brandGroups)) {
    if (brandName === 'Unknown Brand') continue; // handle at end

    const key = normalizeBrandName(brandName) || brandName;

    // Find best matching existing brand
    let existing = existingByName[key];
    if (!existing) {
      // Try looser match (e.g. "Acure Organics" vs "Acure")
      existing = brands.find(b => {
        const bn = normalizeBrandName(b.name) || b.name;
        return bn.toLowerCase() === key.toLowerCase() ||
               key.toLowerCase().startsWith(bn.toLowerCase() + ' ') ||
               bn.toLowerCase().startsWith(key.toLowerCase() + ' ');
      });
    }

    // If this existing brand was already matched by an earlier catalog name, merge ASINs into it
    if (existing && usedExistingIds.has(existing.id)) {
      const prev = newBrands.find(b => b.id === existing.id);
      if (prev) {
        for (const asin of asins) {
          if (!prev.asins.includes(asin)) prev.asins.push(asin);
          const m = asinMeta[asin] || {};
          if (m.cogs != null)    prev.cogs[asin]      = m.cogs;
          if (m.leadTime != null) prev.leadTimes[asin] = m.leadTime;
          if (m.upc)             prev.upcs[asin]      = m.upc;
          if (m.casePack != null) prev.casePacks[asin] = m.casePack;
          if (m.config)          prev.asinConfig[asin] = m.config;
          const title = catalogData[asin]?.title || m.title || '';
          if (title) prev.asinTitles[asin] = title;
        }
        console.log(`  MERGED "${brandName}" (${asins.length} ASINs) → "${existing.name}"`);
      }
      continue;
    }

    if (existing) {
      usedExistingIds.add(existing.id);
      // Use existing brand, replace ASIN list, rebuild metadata
      const updated = { ...existing, asins: [...asins] };
      updated.cogs = {};
      updated.leadTimes = {};
      updated.upcs = {};
      updated.casePacks = {};
      updated.asinConfig = {};
      updated.asinTitles = {};
      for (const asin of asins) {
        const m = asinMeta[asin] || {};
        if (m.cogs != null)    updated.cogs[asin]      = m.cogs;
        if (m.leadTime != null) updated.leadTimes[asin] = m.leadTime;
        if (m.upc)             updated.upcs[asin]      = m.upc;
        if (m.casePack != null) updated.casePacks[asin] = m.casePack;
        if (m.config)          updated.asinConfig[asin] = m.config;
        const title = catalogData[asin]?.title || m.title || '';
        if (title) updated.asinTitles[asin] = title;
      }
      newBrands.push(updated);
    } else {
      // New brand
      const id = slugify(brandName);
      const color = BRAND_COLORS[colorIdx % BRAND_COLORS.length];
      colorIdx++;
      const newBrand = {
        id, name: brandName, marketplace: 'CA', color, asins: [...asins],
        cogs: {}, leadTimes: {}, upcs: {}, casePacks: {}, asinConfig: {}, asinTitles: {},
        createdAt: new Date().toISOString().split('T')[0]
      };
      for (const asin of asins) {
        const m = asinMeta[asin] || {};
        if (m.cogs != null)    newBrand.cogs[asin]      = m.cogs;
        if (m.leadTime != null) newBrand.leadTimes[asin] = m.leadTime;
        if (m.upc)             newBrand.upcs[asin]      = m.upc;
        if (m.casePack != null) newBrand.casePacks[asin] = m.casePack;
        if (m.config)          newBrand.asinConfig[asin] = m.config;
        const title = catalogData[asin]?.title || m.title || '';
        if (title) newBrand.asinTitles[asin] = title;
      }
      newBrands.push(newBrand);
      console.log(`  NEW brand: "${brandName}" (${asins.length} ASINs)`);
    }
  }

  // Unknown brand — only keep if there are genuinely unidentified ASINs
  const unknownAsins = brandGroups['Unknown Brand'] || [];
  if (unknownAsins.length > 0) {
    let ub = brands.find(b => b.id === 'unknown-brand') || {
      id: 'unknown-brand', name: 'Unknown Brand', marketplace: 'CA', color: '#f59e0b',
      asins: [], asinTitles: {}, createdAt: new Date().toISOString().split('T')[0]
    };
    ub = { ...ub, asins: unknownAsins, asinTitles: {} };
    for (const asin of unknownAsins) {
      const title = catalogData[asin]?.title || asinMeta[asin]?.title || '';
      if (title) ub.asinTitles[asin] = title;
    }
    newBrands.push(ub);
    console.log(`  Unknown Brand: ${unknownAsins.length} ASINs`);
  }

  // Print summary
  console.log('\n=== REMAP SUMMARY ===');
  for (const b of newBrands.filter(b => b.id !== 'unknown-brand')) {
    const orig = brands.find(ob => ob.id === b.id);
    const origCount = orig?.asins?.length || 0;
    const diff = b.asins.length - origCount;
    const diffStr = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '=';
    console.log(`  ${b.name}: ${origCount} → ${b.asins.length} ASINs (${diffStr})`);
  }

  // Save to Supabase
  console.log('\nSaving to Supabase...');
  const { error: saveError } = await supabase
    .from('brands')
    .update({ data: { brands: newBrands }, updated_at: new Date().toISOString() })
    .eq('id', 'main');

  if (saveError) {
    console.error('SAVE FAILED:', saveError);
    process.exit(1);
  }

  console.log('Done. All brands remapped and saved.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
