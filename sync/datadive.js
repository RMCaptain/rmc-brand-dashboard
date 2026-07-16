/**
 * Data Dive API — read-only sync
 * Pulls Rank Radar histories (and niche keyword lists where discoverable) for
 * ASINs belonging to our brands, storing raw payloads as JSONB snapshots in
 * datadive_snapshots. Feeds GET /api/datadive/:brandId for the team skills
 * (rank tiers, keyword plans, conversion checks).
 *
 * READ-ONLY BY CONSTRUCTION: this module only issues GET requests. Data Dive
 * endpoints that spend billable tokens (creating dives, creating rank radars)
 * are deliberately not implemented anywhere in this codebase.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const DD_HOST = 'https://api.datadive.tools';

function ddEnabled() { return !!process.env.DATADIVE_API_KEY; }

async function ddGet(path, params = {}) {
  const url = new URL(DD_HOST + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { 'x-api-key': process.env.DATADIVE_API_KEY } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`DataDive GET ${path} → ${res.status}: ${String(text).slice(0, 200)}`);
  return body;
}

// Responses arrive in a nested envelope: { data: { currentPage, hasNext, ..., data: [items] } }
function unwrap(body) { return body && body.data !== undefined ? body.data : body; }

async function listAllRankRadars() {
  const radars = [];
  let page = 1;
  for (;;) {
    const res = await ddGet('/v1/niches/rank-radars', { currentPage: page, pageSize: 100, status: 'ACTIVE' });
    const env = unwrap(res) || {};
    const items = Array.isArray(env.data) ? env.data : (Array.isArray(env) ? env : []);
    radars.push(...items);
    if (!env.hasNext || items.length === 0) break;
    page++;
  }
  return radars;
}

function dateStr(d) { return d.toISOString().slice(0, 10); }

/**
 * Sync snapshots for all brands. Radars map to brands via their ASIN.
 * windowDays of rank history per radar (Amazon-style 35d default).
 */
async function syncDataDive(supabase, brands, { windowDays = 35 } = {}) {
  if (!ddEnabled()) {
    console.warn('[DataDive] DATADIVE_API_KEY not set — sync skipped');
    return { skipped: true };
  }
  const asinBrand = {};
  for (const b of brands) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  const radars = await listAllRankRadars();
  console.log(`[DataDive] ${radars.length} active rank radars found`);
  const endDate = dateStr(new Date());
  const startDate = dateStr(new Date(Date.now() - windowDays * 864e5));

  let stored = 0;
  const nicheIds = new Map(); // nicheId -> brand_id (first seen)
  for (const radar of radars) {
    const radarId = radar.id || radar.rankRadarId;
    const asin = radar.asin?.asin || radar.asin;
    const brandId = asinBrand[asin];
    if (!radarId || !brandId) continue; // not one of ours — don't store
    const nicheId = radar.nicheId || radar.niche?.id;
    if (nicheId && !nicheIds.has(nicheId)) nicheIds.set(nicheId, brandId);

    let payload;
    try {
      payload = unwrap(await ddGet(`/v1/niches/rank-radars/${encodeURIComponent(radarId)}`, { startDate, endDate }));
    } catch (e) {
      console.warn(`[DataDive] radar ${radarId} (${asin}): ${e.message}`);
      continue;
    }
    const { error } = await supabase.from('datadive_snapshots').upsert({
      kind: 'radar',
      key: String(radarId),
      brand_id: brandId,
      asin: asin || null,
      meta: { title: radar.title, marketplace: radar.marketplace, keywordCount: radar.keywordCount, nicheId: nicheId || null, window: [startDate, endDate] },
      payload,
      pulled_at: new Date().toISOString(),
    }, { onConflict: 'kind,key' });
    if (error) throw new Error(`[DataDive] snapshot upsert failed: ${error.message}`);
    stored++;
  }

  let nichesStored = 0;
  for (const [nicheId, brandId] of nicheIds) {
    try {
      const payload = unwrap(await ddGet(`/v1/niches/${encodeURIComponent(nicheId)}/keywords`));
      const { error } = await supabase.from('datadive_snapshots').upsert({
        kind: 'niche_keywords',
        key: String(nicheId),
        brand_id: brandId,
        asin: null,
        meta: {},
        payload,
        pulled_at: new Date().toISOString(),
      }, { onConflict: 'kind,key' });
      if (error) throw new Error(error.message);
      nichesStored++;
    } catch (e) {
      console.warn(`[DataDive] niche ${nicheId} keywords: ${e.message}`);
    }
  }

  // Radar list items don't carry a nicheId (confirmed 2026-07-15), so niche
  // keyword lists can't auto-map to brands yet. Store the raw niche list once
  // per sync so a manual brand→niche mapping can be added later.
  try {
    const nichePage = unwrap(await ddGet('/v1/niches', { currentPage: 1, pageSize: 100 }));
    const { error } = await supabase.from('datadive_snapshots').upsert({
      kind: 'niche_list',
      key: 'all',
      brand_id: null,
      asin: null,
      meta: { total: nichePage?.total ?? null },
      payload: nichePage,
      pulled_at: new Date().toISOString(),
    }, { onConflict: 'kind,key' });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn(`[DataDive] niche list: ${e.message}`);
  }

  console.log(`[DataDive] Stored ${stored} radar snapshots, ${nichesStored} niche keyword lists`);
  return { radars: stored, nicheKeywordLists: nichesStored, radarsSeen: radars.length };
}

module.exports = { syncDataDive, ddEnabled };
