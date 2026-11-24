'use strict';
/**
 * Fill missing ASIN titles from the Sellerboard feed (add-only).
 *
 * The listings report + Catalog API backfill in the sync leave a tail of
 * active ASINs with no title (audit 2026-11-23: 57 active ASINs — Trimax 26,
 * Zollipops 17 — showing as bare ASINs across every page). Every one of them
 * already has a full product name in sellerboard_daily.raw.Name, so take it
 * from there. Runs after each feed ingest next to the COGS refresh. Never
 * overwrites an existing title; Amazon's listing title still wins whenever
 * the sync has one.
 */

async function syncTitlesFromSellerboard({ supabase, mutateBrands, label = 'TitlesSb' }) {
  const { data: row, error } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (error || !row?.data?.brands) return { filled: 0, error: error?.message || 'no brands' };

  const missing = new Set();
  for (const b of row.data.brands) {
    for (const a of (b.asins || [])) if (!b.asinTitles?.[a]) missing.add(a);
  }
  if (!missing.size) return { filled: 0, missing: 0 };

  // Newest feed row per ASIN carries the current product name. PostgREST
  // JSON path select pulls raw.Name without shipping the whole raw object.
  const names = {};
  const asins = [...missing];
  for (let i = 0; i < asins.length; i += 60) {
    const chunk = asins.slice(i, i + 60);
    const { data, error: qErr } = await supabase.from('sellerboard_daily')
      .select('asin,name:raw->>Name,date')
      .in('asin', chunk).order('date', { ascending: false }).limit(chunk.length * 3);
    if (qErr) { console.warn(`[${label}] feed name query failed:`, qErr.message); continue; }
    for (const r of (data || [])) {
      const name = (r.name || '').trim();
      if (name && !names[r.asin]) names[r.asin] = name;
    }
  }
  if (!Object.keys(names).length) return { filled: 0, missing: missing.size };

  let filled = 0;
  await mutateBrands(data => {
    for (const b of (data.brands || [])) {
      for (const a of (b.asins || [])) {
        if (!b.asinTitles?.[a] && names[a]) {
          b.asinTitles = b.asinTitles || {};
          b.asinTitles[a] = names[a];
          filled++;
        }
      }
    }
    return data;
  }, { tag: label });
  console.log(`[${label}] filled ${filled} missing titles from Sellerboard (${missing.size} were missing)`);
  return { filled, missing: missing.size };
}

module.exports = { syncTitlesFromSellerboard };
