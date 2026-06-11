/**
 * ASIN image management — persistent, multi-source, with built-in redundancy.
 *
 * Replaces the ephemeral data/image-cache.json (which got wiped every Render
 * deploy, leaving most ASINs without images on the dashboard).
 *
 * Source priority (highest to lowest):
 *   1. manual_override = true        (never overwritten by sync)
 *   2. listings_report (bulk pull)   — refreshed during the daily sync, free
 *   3. catalog_api (per-ASIN)        — slow, rate-limited, but most reliable
 *   4. existing row (any source)     — keep showing last known good
 *
 * Refresh policy:
 *   - rows older than 30 days are eligible for re-verification via catalog_api
 *   - daily 10 UTC cron processes up to 100 ASINs per run (well within
 *     the 2 req/s Catalog limit) — full catalog refreshes every ~4 days
 *   - listings_report sync (already daily) opportunistically updates whatever
 *     it sees with no rate cost
 *
 * Failure modes handled:
 *   - Supabase down       → return cached read-through map, sync no-ops
 *   - Catalog API rate    → retry once with backoff, then skip + log
 *   - URL goes 404 later  → frontend onerror shows ASIN-code placeholder,
 *                            audit flags after N consecutive failures
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, sleep, getMarketplaceIds } = require('./amazon');

const REVALIDATE_AFTER_DAYS = 30;
const CATALOG_BATCH_LIMIT   = 100;   // per cron run; covers ~half our catalog daily

// ── Read API ─────────────────────────────────────────────────────────────────

// Returns { [asin]: { url, source, manual, verifiedAt } } for every row in
// asin_images. Used by /api/asins/images and any internal callers.
async function loadAllImages(supabase) {
  const out = {};
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('asin_images')
      .select('asin,image_url,source,manual_override,last_verified_at')
      .range(offset, offset + 999);
    if (error) throw new Error(`loadAllImages: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) {
      out[r.asin] = {
        url:        r.image_url,
        source:     r.source,
        manual:     r.manual_override,
        verifiedAt: r.last_verified_at,
      };
    }
    if (data.length < 1000) break;
    offset += 1000;
  }
  return out;
}

// ── Write API ────────────────────────────────────────────────────────────────

// Manual override — sets an image URL by hand. Locked from automated overwrite.
async function setImageManual(supabase, asin, url) {
  const row = {
    asin,
    image_url: url,
    source: 'manual',
    manual_override: true,
    last_verified_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('asin_images').upsert([row], { onConflict: 'asin' });
  if (error) throw new Error(error.message);
  return row;
}

// Bulk upsert from automated sources (listings_report, catalog_api). Refuses
// to overwrite rows with manual_override = true. Returns counts.
async function upsertImages(supabase, entries, source) {
  if (!entries || entries.length === 0) return { written: 0, skipped: 0 };
  // Pull existing manual overrides so we can skip them client-side without
  // a complex upsert ON CONFLICT clause.
  const asins = entries.map(e => e.asin);
  const manualSet = new Set();
  for (let i = 0; i < asins.length; i += 200) {
    const chunk = asins.slice(i, i + 200);
    const { data } = await supabase
      .from('asin_images')
      .select('asin')
      .eq('manual_override', true)
      .in('asin', chunk);
    for (const r of (data || [])) manualSet.add(r.asin);
  }

  const toWrite = entries
    .filter(e => !manualSet.has(e.asin) && e.image_url)
    .map(e => ({
      asin: e.asin,
      image_url: e.image_url,
      source,
      marketplace: e.marketplace || null,
      last_verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  if (toWrite.length === 0) {
    return { written: 0, skipped: entries.length };
  }

  // Upsert in chunks of 200 so we don't blow Supabase's payload size.
  let written = 0;
  for (let i = 0; i < toWrite.length; i += 200) {
    const chunk = toWrite.slice(i, i + 200);
    const { error } = await supabase.from('asin_images').upsert(chunk, { onConflict: 'asin' });
    if (error) { console.warn(`[Images] upsert chunk failed: ${error.message}`); continue; }
    written += chunk.length;
  }
  return { written, skipped: entries.length - written };
}

// ── Catalog API fetcher ──────────────────────────────────────────────────────
// Per-ASIN /catalog/2022-04-01/items/{asin}?includedData=images.
// IMPORTANT: the comma-joined marketplaceIds param silently returns no images.
// Have to query each marketplace separately; first hit wins.
// Returns { [asin]: imageUrl }.
async function fetchCatalogImages(asins, marketplaceIds, token) {
  if (!asins || asins.length === 0) return {};
  token = token || await getAccessToken();
  const result = {};
  let hits = 0, misses = 0;

  for (const asin of asins) {
    let found = null;
    for (const mpId of marketplaceIds) {
      const path = `/catalog/2022-04-01/items/${encodeURIComponent(asin)}?marketplaceIds=${mpId}&includedData=images`;
      try {
        let res = await spRequest('GET', path, token);
        if (res.status === 429) { await sleep(5000); res = await spRequest('GET', path, token); }
        if (res.status === 200 && res.body?.images) {
          const allImgs = (res.body.images || []).flatMap(mp => mp.images || []);
          const main = allImgs.find(img => img.variant === 'MAIN') || allImgs[0];
          if (main?.link) { found = main.link; break; }
        }
      } catch (e) {
        console.warn(`[Images] catalog error for ${asin}/${mpId}: ${e.message}`);
      }
      await sleep(600); // 2 req/s catalog limit, with margin
    }
    if (found) { result[asin] = found; hits++; } else misses++;
  }
  console.log(`[Images] Catalog API: ${hits} hits, ${misses} misses across ${asins.length} ASINs`);
  return result;
}

// ── Daily backfill orchestrator ──────────────────────────────────────────────
// Picks ASINs that:
//   a) aren't in asin_images at all (priority), OR
//   b) have last_verified_at older than REVALIDATE_AFTER_DAYS,
// then fetches via catalog API and upserts. Bounded by CATALOG_BATCH_LIMIT
// per run so we don't blow the API quota.
async function backfillMissingImages(supabase, brands, { limit = CATALOG_BATCH_LIMIT } = {}) {
  const allBrandAsins = [...new Set(brands.flatMap(b => b.asins || []))];
  if (allBrandAsins.length === 0) return { fetched: 0, candidates: 0 };

  // Pull existing images for these ASINs
  const existing = {};
  for (let i = 0; i < allBrandAsins.length; i += 200) {
    const chunk = allBrandAsins.slice(i, i + 200);
    const { data } = await supabase
      .from('asin_images')
      .select('asin,last_verified_at,manual_override')
      .in('asin', chunk);
    for (const r of (data || [])) existing[r.asin] = r;
  }

  const cutoff = Date.now() - REVALIDATE_AFTER_DAYS * 86400000;
  const candidates = [];
  for (const asin of allBrandAsins) {
    const e = existing[asin];
    if (!e) { candidates.push({ asin, priority: 0 }); continue; }
    if (e.manual_override) continue; // never re-fetch
    const verifiedTs = new Date(e.last_verified_at).getTime();
    if (verifiedTs < cutoff) candidates.push({ asin, priority: 1 });
  }
  // Missing first (priority 0), then stale (priority 1)
  candidates.sort((a, b) => a.priority - b.priority);
  const toFetch = candidates.slice(0, limit).map(c => c.asin);

  if (toFetch.length === 0) {
    console.log('[Images] Nothing to backfill — all images present and fresh');
    return { fetched: 0, candidates: 0 };
  }

  console.log(`[Images] Backfilling ${toFetch.length}/${candidates.length} ASINs (${candidates.filter(c=>c.priority===0).length} missing, rest stale)`);
  const token = await getAccessToken();
  const fresh = await fetchCatalogImages(toFetch, getMarketplaceIds(), token);

  const entries = Object.entries(fresh).map(([asin, image_url]) => ({ asin, image_url }));
  const { written, skipped } = await upsertImages(supabase, entries, 'catalog_api');
  console.log(`[Images] Backfill done: ${written} written, ${skipped} skipped`);
  return { fetched: written, candidates: candidates.length };
}

// ── Migration: seed from preset_metrics + local cache ─────────────────────────
// One-shot import from existing data sources. Scrapes preset_metrics (which
// has imageUrl per SKU per preset) and the local image-cache.json (if exists)
// and bulk-loads everything into asin_images. Safe to re-run.
async function migrateLegacyImages(supabase) {
  const fs = require('fs');
  const path = require('path');
  const collected = {};

  // Source 1: preset_metrics
  const { data: pmRow } = await supabase
    .from('preset_metrics').select('data').eq('id', 'main').single();
  const presets = pmRow?.data?.presets || {};
  for (const preset of Object.values(presets)) {
    for (const brand of Object.values(preset.brands || {})) {
      for (const sku of (brand.skus || [])) {
        if (sku.asin && sku.imageUrl && !collected[sku.asin]) {
          collected[sku.asin] = { image_url: sku.imageUrl };
        }
      }
    }
  }

  // Source 2: local image-cache.json
  try {
    const cachePath = path.join(__dirname, '../data/image-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    for (const [asin, url] of Object.entries(cache)) {
      if (typeof url === 'string' && !collected[asin]) collected[asin] = { image_url: url };
    }
  } catch {}

  const entries = Object.entries(collected).map(([asin, v]) => ({ asin, image_url: v.image_url }));
  console.log(`[Images] Migrating ${entries.length} images from legacy sources...`);
  const { written } = await upsertImages(supabase, entries, 'listings_report');
  console.log(`[Images] Migration: ${written} rows seeded`);
  return { written, scanned: entries.length };
}

module.exports = {
  loadAllImages,
  setImageManual,
  upsertImages,
  fetchCatalogImages,
  backfillMissingImages,
  migrateLegacyImages,
};
