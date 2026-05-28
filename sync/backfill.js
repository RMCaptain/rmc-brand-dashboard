/**
 * Historical daily_metrics backfill
 * Fills per-ASIN per-day rows working backwards from yesterday.
 * Designed to be called repeatedly (once per API invocation) until history is complete.
 * Rate-limited to 15 days per call to stay within the SP-API Reports burst quota.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAccessToken, spRequest, getMarketplaceIds, MARKETPLACE_CODE, sleep, createReport, waitForReport, downloadReport } = require('./amazon');

const MARKETPLACE_CURRENCY = { 'A2EUQ1WTGCTBG2': 'CAD', 'ATVPDKIKX0DER': 'USD' };

let running = false;
function isBackfillRunning() { return running; }

function fmtDate(d) { return d.toISOString().split('T')[0]; }

function parseSalesTrafficDay(jsonStr) {
  // Returns { asin: { revenueCad, revenueUsd, units, unitsCa, unitsUs, sessions, pageViews, buyBox } }
  // Works for single-day reports (range = 1 day), so salesAndTrafficByAsin is the per-day aggregate
  const data = JSON.parse(jsonStr);
  const result = {};

  for (const item of (data.salesAndTrafficByAsin || [])) {
    const asin = item.childAsin || item.parentAsin;
    if (!asin) continue;
    const sales   = item.salesByAsin   || {};
    const traffic = item.trafficByAsin || {};

    result[asin] = {
      units:    sales.unitsOrdered || 0,
      revenue:  sales.orderedProductSales?.amount || 0,
      sessions: traffic.sessions   || 0,
      pageViews: traffic.pageViews || 0,
      buyBox:   traffic.buyBoxPercentage ?? null,
    };
  }
  return result;
}

// Find dates in the last `lookbackDays` that are missing from daily_metrics.
async function findMissingDates(supabase, lookbackDays = 365) {
  const dates = [];
  const today = new Date();
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(fmtDate(d));
  }

  // Fetch which dates we already have (any ASIN for that date = date is covered)
  const { data } = await supabase
    .from('daily_metrics')
    .select('date')
    .in('date', dates);

  const have = new Set((data || []).map(r => r.date));
  return dates.filter(d => !have.has(d));
}

// Backfill up to `limit` missing days. Returns { filled, remaining, dates }.
async function backfillDays(supabase, brands, limit = 15, lookbackDays = 365) {
  if (running) { console.log('[Backfill] Already running — skipping'); return { filled: 0, remaining: -1, dates: [] }; }
  running = true;
  try {
  const missing = await findMissingDates(supabase, lookbackDays);
  if (missing.length === 0) return { filled: 0, remaining: 0, dates: [] };

  const toFill   = missing.slice(0, limit);
  const token    = await getAccessToken();
  const mpIds    = getMarketplaceIds();

  console.log(`[Backfill] Filling ${toFill.length} days (${missing.length - toFill.length} remaining after this run)`);

  // Build map: asin → brand_id (needed for the brand_id column)
  const asinBrand = {};
  for (const b of brands) {
    for (const asin of b.asins) asinBrand[asin] = b.id;
  }

  // Create all reports up-front (up to burst quota of 15 creates per mp = 30 total for 2 mps)
  const reportJobs = []; // { date, mpId, reportId }
  for (const date of toFill) {
    for (const mpId of mpIds) {
      try {
        const reportId = await createReport(
          'GET_SALES_AND_TRAFFIC_REPORT',
          [mpId],
          { dateGranularity: 'SUMMARY', asinGranularity: 'CHILD' },
          { start: date + 'T00:00:00Z', end: date + 'T23:59:59Z' },
          token
        );
        reportJobs.push({ date, mpId, reportId });
        await sleep(2000); // 2s between creates — stays well within quota
      } catch (e) {
        console.warn(`[Backfill] Failed to create report for ${date}/${mpId}:`, e.message);
      }
    }
  }

  // Wait for all reports in parallel (Amazon processes them concurrently)
  console.log(`[Backfill] Waiting for ${reportJobs.length} reports...`);
  const settled = await Promise.allSettled(
    reportJobs.map(async job => {
      const docId = await waitForReport(job.reportId, token);
      const raw   = await downloadReport(docId, token);
      return { ...job, data: parseSalesTrafficDay(raw) };
    })
  );

  // Group by date, merge CA + US into single rows
  const byDate = {}; // date → { asin: { ... } }
  for (const r of settled) {
    if (r.status !== 'fulfilled') { console.warn('[Backfill] Report failed:', r.reason?.message); continue; }
    const { date, mpId, data } = r.value;
    const currency = MARKETPLACE_CURRENCY[mpId] || 'USD';
    if (!byDate[date]) byDate[date] = {};

    for (const [asin, d] of Object.entries(data)) {
      if (!byDate[date][asin]) byDate[date][asin] = { units: 0, unitsCa: 0, unitsUs: 0, revenueCad: 0, revenueUsd: 0, sessions: 0, pageViews: 0, buyBoxSamples: [] };
      const row = byDate[date][asin];
      row.units    += d.units;
      row.sessions += d.sessions;
      row.pageViews += d.pageViews;
      if (currency === 'CAD') { row.unitsCa += d.units; row.revenueCad += d.revenue; }
      else                    { row.unitsUs += d.units; row.revenueUsd += d.revenue; }
      if (d.buyBox != null) row.buyBoxSamples.push(d.buyBox);
    }
  }

  // Upsert all rows to daily_metrics
  let totalRows = 0;
  const filledDates = [];
  for (const [date, asins] of Object.entries(byDate)) {
    const rows = Object.entries(asins).map(([asin, d]) => ({
      asin,
      date,
      brand_id:         asinBrand[asin] || 'unknown-brand',
      units:            d.units,
      units_ca:         d.unitsCa,
      units_us:         d.unitsUs,
      revenue_cad:      Math.round(d.revenueCad * 100) / 100,
      revenue_usd:      Math.round(d.revenueUsd * 100) / 100,
      sessions:         d.sessions || null,
      page_views:       d.pageViews || null,
      buy_box_pct:      d.buyBoxSamples.length ? Math.round(d.buyBoxSamples.reduce((a, b) => a + b, 0) / d.buyBoxSamples.length * 10) / 10 : null,
    }));

    if (rows.length > 0) {
      const { error } = await supabase.from('daily_metrics').upsert(rows, { onConflict: 'asin,date' });
      if (error) console.warn(`[Backfill] Upsert error for ${date}:`, error.message);
      else { totalRows += rows.length; filledDates.push(date); }
    }
  }

  console.log(`[Backfill] Done: ${filledDates.length} dates, ${totalRows} rows written`);
  return { filled: filledDates.length, remaining: missing.length - toFill.length, dates: filledDates };
  } finally {
    running = false;
  }
}

module.exports = { backfillDays, findMissingDates, isBackfillRunning };
