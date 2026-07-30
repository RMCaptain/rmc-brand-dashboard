/**
 * Listing content sync — READ-ONLY SP-API pulls, never writes to Amazon.
 *
 * Per managed ASIN (general-wholesale and unknown-brand excluded):
 *  - Catalog Items batch (20/call): variant relationships (parent/theme),
 *    image count, structured attributes, catalog bullets/description fallback.
 *  - Listings Items per SKU: our own attributes — bullet_point,
 *    product_description, generic_keyword (backend search terms) — plus
 *    status + issues (suppression reasons).
 *
 * SKU map comes from preset_metrics (merchant listings report already parsed
 * there); ASINs without a known SKU still get catalog data, just no
 * listings-only fields. Rows upsert into listing_content keyed by ASIN.
 *
 * Feeds /api/listing-content/:brandId → get_listing_content MCP tool →
 * seo-asin-audit + listing-copy catalog audit mode.
 */

const { getAccessToken, spRequest, sleep } = require('./amazon');

const EXCLUDED_BRANDS = new Set(['general-wholesale', 'unknown-brand']);
const MP_ID = { CA: 'A2EUQ1WTGCTBG2', US: 'ATVPDKIKX0DER' };

// Attributes worth keeping structured — the catalog carries hundreds.
const KEEP_ATTRS = ['flavor', 'size', 'color', 'style', 'unit_count', 'item_package_quantity', 'material', 'scent', 'item_form', 'age_range_description', 'target_species'];

function attrValue(attrs, key) {
  const v = attrs?.[key];
  if (!Array.isArray(v) || !v.length) return null;
  const first = v[0];
  if (first == null) return null;
  if (typeof first !== 'object') return first;
  if (first.value != null && typeof first.value !== 'object') return first.value;
  // unit_count-style: { value: { value: 100, unit: 'count' } } or language-tagged
  if (first.value?.value != null) return `${first.value.value}${first.value.unit ? ' ' + first.value.unit : ''}`;
  return null;
}

function textList(attrs, key) {
  const v = attrs?.[key];
  if (!Array.isArray(v)) return [];
  return v.map(x => (typeof x === 'object' ? x.value : x)).filter(s => typeof s === 'string' && s.trim());
}

function parseCatalogItem(item) {
  const out = { parent_asin: null, variation_theme: null, image_count: null, attributes: {}, catalogBullets: [], catalogDescription: null, title: null, brand_name: null };
  const summary = item.summaries?.[0];
  if (summary) { out.title = summary.itemName || null; out.brand_name = summary.brandName || null; }
  for (const rel of item.relationships?.[0]?.relationships || []) {
    if (rel.type === 'VARIATION') {
      if (rel.parentAsins?.length) out.parent_asin = rel.parentAsins[0];
      if (rel.variationTheme?.theme) out.variation_theme = rel.variationTheme.theme;
    }
  }
  const imgs = item.images?.[0]?.images || [];
  out.image_count = new Set(imgs.map(i => i.variant)).size || (imgs.length ? 1 : 0);
  const attrs = item.attributes || {};
  for (const k of KEEP_ATTRS) {
    const v = attrValue(attrs, k);
    if (v != null) out.attributes[k] = v;
  }
  out.catalogBullets = textList(attrs, 'bullet_point');
  out.catalogDescription = textList(attrs, 'product_description')[0] || null;
  return out;
}

async function fetchCatalogBatch(asins, marketplaceId, token) {
  const out = {};
  for (let i = 0; i < asins.length; i += 20) {
    const batch = asins.slice(i, i + 20);
    const ids = batch.map(a => `identifiers=${encodeURIComponent(a)}`).join('&');
    const path = `/catalog/2022-04-01/items?marketplaceIds=${marketplaceId}&${ids}&identifiersType=ASIN&includedData=summaries,attributes,images,relationships`;
    let res = await spRequest('GET', path, token);
    if (res.status === 429) { await sleep(2500); res = await spRequest('GET', path, token); }
    if (res.status === 200) {
      for (const item of (res.body.items || [])) if (item.asin) out[item.asin] = parseCatalogItem(item);
    } else {
      console.warn(`[ListingContent] catalog batch ${Math.floor(i / 20) + 1} HTTP ${res.status} (${marketplaceId})`);
    }
    await sleep(600);
  }
  return out;
}

async function fetchListingsItem(sellerId, sku, marketplaceId, token) {
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}?marketplaceIds=${marketplaceId}&includedData=summaries,attributes,issues`;
  const res = await spRequest('GET', path, token);
  if (res.status !== 200) return null;
  const attrs = res.body.attributes || {};
  const summary = (res.body.summaries || [])[0] || {};
  return {
    bullets: textList(attrs, 'bullet_point'),
    description: textList(attrs, 'product_description')[0] || null,
    backend_keywords: textList(attrs, 'generic_keyword').join(' ') || null,
    status: summary.status || [],
    issues: (res.body.issues || []).map(i => ({ code: i.code, severity: i.severity, message: i.message })),
  };
}

// SKU + marketplace per ASIN from the stored preset metrics blob.
async function loadSkuMap(supabase) {
  const { data, error } = await supabase.from('preset_metrics').select('data').eq('id', 'main').single();
  if (error || !data?.data) return {};
  const presets = data.data.presets || {};
  const preset = presets.last30d || presets[Object.keys(presets)[0]];
  const map = {};
  for (const bm of Object.values(preset?.brands || {})) {
    for (const s of (bm.skus || [])) {
      if (s.asin && s.sellerSku && !map[s.asin]) map[s.asin] = { sku: s.sellerSku, marketplace: s.marketplace || 'CA' };
    }
  }
  return map;
}

async function syncListingContent(supabase, brands) {
  const sellerId = process.env.SP_API_SELLER_ID;
  const managed = brands.filter(b => !EXCLUDED_BRANDS.has(b.id));
  const asinBrand = {};
  for (const b of managed) for (const a of (b.asins || [])) asinBrand[a] = b.id;
  const asins = Object.keys(asinBrand);
  if (!asins.length) { console.log('[ListingContent] no ASINs to sync'); return { synced: 0 }; }

  const skuMap = await loadSkuMap(supabase);
  const token = await getAccessToken();
  console.log(`[ListingContent] ${asins.length} ASINs across ${managed.length} brands (${Object.keys(skuMap).length} with SKUs)...`);

  // Catalog: CA first, US fills the gaps.
  const catalog = await fetchCatalogBatch(asins, MP_ID.CA, token);
  const missing = asins.filter(a => !catalog[a]);
  if (missing.length) Object.assign(catalog, await fetchCatalogBatch(missing, MP_ID.US, token));

  const rows = [];
  let listingsOk = 0;
  for (const asin of asins) {
    const cat = catalog[asin] || {};
    const skuInfo = skuMap[asin];
    let listing = null;
    if (sellerId && skuInfo) {
      const mp = MP_ID[skuInfo.marketplace] || MP_ID.CA;
      listing = await fetchListingsItem(sellerId, skuInfo.sku, mp, token);
      if (!listing && skuInfo.marketplace !== 'US') listing = await fetchListingsItem(sellerId, skuInfo.sku, MP_ID.US, token);
      if (listing) listingsOk++;
      await sleep(250);
    }
    rows.push({
      asin,
      brand_id: asinBrand[asin],
      marketplace: skuInfo?.marketplace || 'CA',
      seller_sku: skuInfo?.sku || null,
      parent_asin: cat.parent_asin || null,
      variation_theme: cat.variation_theme || null,
      title: cat.title || null,
      brand_name: cat.brand_name || null,
      bullets: (listing?.bullets?.length ? listing.bullets : cat.catalogBullets) || [],
      description: listing?.description || cat.catalogDescription || null,
      backend_keywords: listing?.backend_keywords || null,
      attributes: cat.attributes || {},
      image_count: cat.image_count ?? null,
      status: listing?.status || [],
      issues: listing?.issues || [],
      synced_at: new Date().toISOString(),
    });
  }

  // Upsert in chunks. Destructive-write rule: only replace when the source
  // pull actually produced data.
  const withData = rows.filter(r => r.title || r.bullets.length);
  if (!withData.length) { console.warn('[ListingContent] pull came back EMPTY — keeping old rows'); return { synced: 0 }; }
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await supabase.from('listing_content').upsert(rows.slice(i, i + 100), { onConflict: 'asin' });
    if (error) throw new Error(`listing_content upsert: ${error.message}`);
  }
  console.log(`[ListingContent] Done: ${rows.length} ASINs upserted (${listingsOk} with own-listing data incl. backend keywords).`);
  return { synced: rows.length, withListingData: listingsOk };
}

module.exports = { syncListingContent };
