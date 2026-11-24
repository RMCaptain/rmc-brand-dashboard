'use strict';
/**
 * Re-pull a completed day's Sales & Traffic report and rewrite ONLY the
 * traffic columns (sessions, page views, buy box) in daily_metrics and
 * daily_metrics_mp.
 *
 * Why: Amazon's buyBoxPercentage often lags the first "yesterday" pull by a
 * day or two. The weekly audit on 2026-11-23 found Nov 20 with no buy box at
 * all and Nov 18 with a third of its ASINs — while sessions were complete.
 * The sync only ever wrote yesterday once, so a late day stayed null for
 * good. runFullSync now calls this for day-2 and day-3 after every sync, and
 * POST /api/traffic/refresh?date=… runs it by hand.
 *
 * Money columns are never touched: the Orders API owns units/revenue
 * (see writeDailyMetrics in server.js for the same authority rule).
 */
const {
  getAccessToken, getMarketplaceIds, createReport, waitForReport, downloadReport,
  parseSalesTrafficReport, sleep,
} = require('./amazon');
const { pstMidnightAsUTC, pstEndOfDayAsUTC } = require('./dateUtils');
const { trafficRows, replaceDay } = require('./metricsMp');

// mpId → asin → { sessions, pageViews, buyBox, ... } for one PST day.
async function fetchDayTraffic(date, { marketplaceIds } = {}) {
  const token = await getAccessToken();
  const mps = marketplaceIds || getMarketplaceIds();
  const reportIds = {};
  for (const mpId of mps) {
    reportIds[mpId] = await createReport(
      'GET_SALES_AND_TRAFFIC_REPORT', [mpId],
      { dateGranularity: 'SUMMARY', asinGranularity: 'CHILD' },
      { start: pstMidnightAsUTC(date), end: pstEndOfDayAsUTC(date) },
      token
    );
    await sleep(2000);
  }
  const out = {};
  for (const [mpId, id] of Object.entries(reportIds)) {
    const docId = await waitForReport(id, token);
    out[mpId] = parseSalesTrafficReport(await downloadReport(docId, token));
  }
  return out;
}

// Wide-row blend, same rule the sync uses: sessions / page views summed
// across marketplaces, buy box = mean of the marketplaces that reported one.
function blendWide(byMp) {
  const wide = {};
  for (const byAsin of Object.values(byMp)) {
    for (const [asin, d] of Object.entries(byAsin)) {
      const w = wide[asin] || (wide[asin] = { sessions: 0, pageViews: 0, bb: [] });
      w.sessions  += Number(d.sessions)  || 0;
      w.pageViews += Number(d.pageViews) || 0;
      if (d.buyBox != null && Number.isFinite(d.buyBox)) w.bb.push(d.buyBox);
    }
  }
  for (const w of Object.values(wide)) {
    w.buyBox = w.bb.length ? Math.round(w.bb.reduce((s, v) => s + v, 0) / w.bb.length * 10) / 10 : null;
    delete w.bb;
  }
  return wide;
}

async function refreshTrafficDay(supabase, date, { tag = 'TrafficRefresh', asinBrand = {}, marketplaceIds, requireBuyBox = true } = {}) {
  const byMp = await fetchDayTraffic(date, { marketplaceIds });
  const mpIds = Object.keys(byMp);
  const asinCount = new Set(mpIds.flatMap(mp => Object.keys(byMp[mp]))).size;
  const anyBuyBox = mpIds.some(mp => Object.values(byMp[mp]).some(d => d.buyBox != null));
  // If the re-pull STILL has no buy box, Amazon hasn't posted it yet — leave
  // the day exactly as it is rather than rewriting good sessions with the
  // same hole. The next sync tries again.
  if (requireBuyBox && !anyBuyBox) {
    console.log(`[${tag}] ${date}: S&T still carries no buy box (${asinCount} ASINs) — day left untouched`);
    return { date, skipped: 'no-buybox', asins: asinCount };
  }

  const wide = blendWide(byMp);
  const rows = Object.entries(wide).map(([asin, t]) => ({
    asin, date, brand_id: asinBrand[asin] || 'unknown-brand',
    sessions: t.sessions, page_views: t.pageViews, buy_box_pct: t.buyBox,
  }));
  let wideWritten = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const { error } = await supabase.from('daily_metrics').upsert(batch, { onConflict: 'asin,date' });
    if (error) { console.warn(`[${tag}] ${date}: wide traffic upsert failed:`, error.message); continue; }
    wideWritten += batch.length;
  }
  const mpWritten = await replaceDay(supabase, date, 'traffic', trafficRows(date, byMp, asinBrand), tag, mpIds);
  console.log(`[${tag}] ${date}: traffic rewritten — ${wideWritten} wide rows, ${mpWritten} per-marketplace rows across ${mpIds.length} marketplaces`);
  return { date, wideRows: wideWritten, mpRows: mpWritten, mps: mpIds };
}

module.exports = { refreshTrafficDay, fetchDayTraffic, blendWide };
