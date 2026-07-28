/**
 * Subscribe & Save daily history writer.
 *
 * The Replenishment API reports only CURRENT subscription counts and the
 * brands blob overwrites them every sync — this module gives S&S a time
 * dimension by snapshotting each successful fetch into sns_daily (one row per
 * ASIN per marketplace per PST day; repeat syncs same-day upsert, so the last
 * sync of the day wins).
 *
 * sns_sync_days records marketplace coverage per day: an ASIN absent from a
 * covered day is a true zero; an uncovered day is "no data". Never conflate
 * the two (the 0-vs-NULL rule).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { pstDateStr } = require('./dateUtils');

let supabase = null;
function client() {
  if (!supabase) supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  return supabase;
}

/**
 * Record today's S&S snapshot for every marketplace that SUCCEEDED.
 * @param {object} byMp      { [mpId]: { subs: {asin: count}, revenue: {asin: mtdRev} } }
 *                           — only marketplaces whose fetch succeeded.
 * @param {object} asinBrand { asin: brandId }
 * Non-fatal by design: an snapshot failure must never break the sync that
 * carries it. Returns rows written (0 on failure).
 */
async function recordSnsSnapshot(byMp, asinBrand = {}) {
  try {
    if (!byMp || Object.keys(byMp).length === 0) return 0;
    const date = pstDateStr();
    const now = new Date().toISOString();

    const rows = [];
    const dayRows = [];
    for (const [mpId, mp] of Object.entries(byMp)) {
      dayRows.push({ date, mp_id: mpId, fetched_at: now });
      const asins = new Set([...Object.keys(mp.subs || {}), ...Object.keys(mp.revenue || {})]);
      for (const asin of asins) {
        const subs = mp.subs?.[asin] || 0;
        const rev = mp.revenue?.[asin];
        if (subs <= 0 && !rev) continue; // zeros are implied by day coverage
        rows.push({
          date,
          asin,
          mp_id: mpId,
          brand_id: asinBrand[asin] || null,
          subs,
          mtd_revenue: Number.isFinite(rev) ? rev : null,
          fetched_at: now,
        });
      }
    }

    const { error: dayErr } = await client().from('sns_sync_days').upsert(dayRows, { onConflict: 'date,mp_id' });
    if (dayErr) { console.warn('[SnsHistory] sync-day write failed:', dayErr.message); return 0; }
    if (rows.length > 0) {
      const { error } = await client().from('sns_daily').upsert(rows, { onConflict: 'date,asin,mp_id' });
      if (error) { console.warn('[SnsHistory] snapshot write failed:', error.message); return 0; }
    }
    console.log(`[SnsHistory] ${date}: ${rows.length} ASIN rows across ${dayRows.length} marketplace(s)`);
    return rows.length;
  } catch (e) {
    console.warn('[SnsHistory] snapshot failed:', e.message);
    return 0;
  }
}

module.exports = { recordSnsSnapshot };
