/**
 * Daily data integrity checks for daily_metrics.
 * Each pattern here corresponds to a real corruption incident we've debugged.
 * Pure / deterministic — no LLM. Returns a structured findings object.
 */

const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

const LOOKBACK_DAYS  = 35;
const ZERO_ROW_FLOOR = 50;   // ≥50 rows but <10 units → phantom-zero corruption
const ZERO_UNIT_CAP  = 10;
const INFLATION_RATIO   = 1.80; // a day >1.8x the surrounding median = S&T-era leftover
const DEPLETION_RATIO   = 0.50; // a day <50% surrounding median = under-fetched

// Fetch one row per date with limit:1, in batches — works around Supabase's 1000-row cap.
async function fetchDayShape(supabase, date) {
  const all = [];
  for (let off = 0; off < 5000; off += 1000) {
    const { data, error } = await supabase
      .from('daily_metrics')
      .select('units,units_ca,units_us,revenue_cad,revenue_usd,sessions,spend_cad,spend_usd,updated_at')
      .eq('date', date)
      .range(off, off + 999);
    if (error) throw new Error(`fetch ${date}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
  }
  let units = 0, unitsCa = 0, unitsUs = 0, revCad = 0, revUsd = 0, withSessions = 0;
  let spendCad = 0, spendUsd = 0, rowsWithSpend = 0;
  let maxUpdatedAt = null;
  for (const r of all) {
    units    += r.units || 0;
    unitsCa  += r.units_ca || 0;
    unitsUs  += r.units_us || 0;
    revCad   += r.revenue_cad || 0;
    revUsd   += r.revenue_usd || 0;
    spendCad += r.spend_cad || 0;
    spendUsd += r.spend_usd || 0;
    if ((r.spend_cad || 0) > 0 || (r.spend_usd || 0) > 0) rowsWithSpend++;
    if (r.sessions != null && r.sessions > 0) withSessions++;
    if (r.updated_at && (!maxUpdatedAt || r.updated_at > maxUpdatedAt)) maxUpdatedAt = r.updated_at;
  }
  return {
    date, rows: all.length, units, unitsCa, unitsUs, revCad, revUsd, withSessions,
    spendCad, spendUsd, rowsWithSpend,
    blended: revCad + revUsd * 1.38,
    adSpendBlended: spendCad + spendUsd * 1.38,
    maxUpdatedAt,
  };
}

function median(nums) {
  const sorted = nums.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function runChecks(supabase) {
  const todayPst = pstDateStr();
  const yest     = pstSubtractDays(todayPst, 1);

  // Build the date window: yesterday backwards LOOKBACK_DAYS days
  const dates = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i++) dates.push(pstSubtractDays(todayPst, i));

  const shapes = [];
  for (const d of dates) shapes.push(await fetchDayShape(supabase, d));

  const findings = [];

  // Baselines from the window (use median to ignore the outliers we're hunting)
  const rowMedian   = median(shapes.map(s => s.rows));
  const unitsMedian = median(shapes.filter(s => s.units > 0).map(s => s.units));
  const revMedian   = median(shapes.filter(s => s.blended > 0).map(s => s.blended));

  for (const s of shapes) {
    // 1. ENTIRELY MISSING — no rows for the date at all
    if (s.rows === 0) {
      findings.push({
        severity: 'critical',
        date: s.date,
        type: 'missing_date',
        message: `No rows in daily_metrics for ${s.date}`,
        remediation: `node scripts/rebuild-from-orders.js ${s.date}`,
      });
      continue;
    }

    // 2. ZERO-FILLED — rows exist but units/revenue are wiped (Jun 8 pattern)
    if (s.rows >= ZERO_ROW_FLOOR && s.units < ZERO_UNIT_CAP && s.blended < 200) {
      findings.push({
        severity: 'critical',
        date: s.date,
        type: 'zero_filled',
        message: `${s.date} has ${s.rows} rows but only ${s.units} units / CA$${s.blended.toFixed(0)} — likely a finalize ran without replacement data`,
        remediation: `node scripts/rebuild-from-orders.js ${s.date}`,
      });
      continue;
    }

    // 3. ONE-MARKETPLACE-ONLY — the true partial-sync signature. A day where one
    // of CA/US revenue is exactly zero while the other has activity, AND the
    // window typically shows both. This catches the May 21 original corruption
    // (only US report succeeded) without false-positiving on low-traffic days
    // that legitimately have a smaller ASIN footprint.
    if (s.units > 0) {
      const onlyCa = s.revUsd === 0 && s.unitsUs === 0 && (s.revCad > 0 || s.unitsCa > 0);
      const onlyUs = s.revCad === 0 && s.unitsCa === 0 && (s.revUsd > 0 || s.unitsUs > 0);
      const caDaysInWindow = shapes.filter(x => x.revCad > 0).length;
      const usDaysInWindow = shapes.filter(x => x.revUsd > 0).length;
      const windowHasBoth = caDaysInWindow > shapes.length * 0.5 && usDaysInWindow > shapes.length * 0.5;
      if (windowHasBoth && (onlyCa || onlyUs)) {
        findings.push({
          severity: 'warning',
          date: s.date,
          type: 'one_marketplace_only',
          message: `${s.date} has ${onlyCa ? 'CA only' : 'US only'} revenue (${s.units} units) — partial sync, one marketplace report failed.`,
          remediation: `node scripts/rebuild-from-orders.js ${s.date}`,
        });
      }
    }

    // 4. INFLATED — revenue or units >1.8x the window median (May 1-14 S&T-era pattern)
    if (revMedian > 0 && s.blended > revMedian * INFLATION_RATIO && s.units > unitsMedian * INFLATION_RATIO) {
      findings.push({
        severity: 'warning',
        date: s.date,
        type: 'inflated',
        message: `${s.date}: ${s.units} units / CA$${s.blended.toFixed(0)} — ${(s.blended / revMedian).toFixed(1)}× the 35-day median (CA$${revMedian.toFixed(0)}). Possible un-rebuilt S&T data.`,
        remediation: `node scripts/rebuild-from-orders.js ${s.date}`,
      });
    }

    // 5. DEPLETED — much lower than the window. Could be a real slow day or under-fetched.
    if (revMedian > 0 && s.blended < revMedian * DEPLETION_RATIO && s.units > 0) {
      findings.push({
        severity: 'info',
        date: s.date,
        type: 'depleted',
        message: `${s.date}: ${s.units} units / CA$${s.blended.toFixed(0)} — only ${(s.blended / revMedian * 100).toFixed(0)}% of median. May be slow day or rate-limited fetch.`,
        remediation: null,
      });
    }
  }

  // 6. RANGE MONOTONICITY — 7d revenue should be ≤ 14d ≤ 30d. Violation = stale cache or bad sum.
  const sumWindow = (n) => shapes
    .filter(s => s.date <= yest && s.date >= pstSubtractDays(yest, n - 1))
    .reduce((a, s) => a + s.blended, 0);
  const r7 = sumWindow(7), r14 = sumWindow(14), r30 = sumWindow(30);
  if (r7 > r14) findings.push({ severity: 'critical', date: null, type: 'monotonicity', message: `7d total (CA$${r7.toFixed(0)}) > 14d total (CA$${r14.toFixed(0)}). Either truncation bug or bad day in 14-day window.`, remediation: 'Investigate days in the 8-14 day range' });
  if (r14 > r30) findings.push({ severity: 'critical', date: null, type: 'monotonicity', message: `14d total (CA$${r14.toFixed(0)}) > 30d total (CA$${r30.toFixed(0)}).`, remediation: 'Investigate days in the 15-30 day range' });

  // 7. YESTERDAY FRESHNESS — if yesterday's row count is way below window median, finalize didn't run
  const yShape = shapes.find(s => s.date === yest);
  if (yShape && yShape.rows < rowMedian * 0.30 && rowMedian > 100) {
    findings.push({
      severity: 'warning',
      date: yest,
      type: 'yesterday_thin',
      message: `Yesterday (${yest}) has only ${yShape.rows} rows. Did finalizeYesterdayFromOrders run? Expected ~${rowMedian.toFixed(0)}.`,
      remediation: `Manually trigger via POST /api/finalize-yesterday or wait for next 8:30 UTC cron`,
    });
  }

  // 8. STALE WRITE — if yesterday's most recent updated_at is >12h old, the
  // finalize cron didn't run today (or failed silently). Catches the case
  // where row count looks plausible but the data is from yesterday-morning's
  // poll, never re-finalized.
  if (yShape && yShape.maxUpdatedAt) {
    const ageHours = (Date.now() - new Date(yShape.maxUpdatedAt).getTime()) / 3.6e6;
    if (ageHours > 12) {
      findings.push({
        severity: 'warning',
        date: yest,
        type: 'stale_write',
        message: `Yesterday (${yest}) hasn't been written in ${ageHours.toFixed(1)}h. Finalize cron may not be running.`,
        remediation: `Check Render logs for [Orders] Finalize messages; manually trigger via POST /api/audit/run after fixing.`,
      });
    }
  }

  // 9. MISSING IMAGES — ASINs with sales in the window but no image in asin_images.
  // Flagged as info (not warning) — frontend handles gracefully with the
  // ASIN-code placeholder. But worth tracking so the backfill cron has
  // a manual trigger target.
  try {
    const recentAsins = new Set();
    const since = pstSubtractDays(todayPst, 14);
    const { data: salesAsins } = await supabase
      .from('daily_metrics')
      .select('asin')
      .gte('date', since)
      .gt('units', 0)
      .limit(5000);
    for (const r of (salesAsins || [])) recentAsins.add(r.asin);

    if (recentAsins.size > 0) {
      const asinList = [...recentAsins];
      const haveImage = new Set();
      for (let i = 0; i < asinList.length; i += 200) {
        const chunk = asinList.slice(i, i + 200);
        const { data } = await supabase
          .from('asin_images')
          .select('asin')
          .in('asin', chunk);
        for (const r of (data || [])) haveImage.add(r.asin);
      }
      const missing = [...recentAsins].filter(a => !haveImage.has(a));
      if (missing.length > 0) {
        findings.push({
          severity: 'info',
          date: null,
          type: 'missing_images',
          message: `${missing.length} ASINs sold in the last 14 days have no image cached (${asinList.length - missing.length}/${asinList.length} have images).`,
          remediation: `POST /api/asins/images/backfill?limit=200 (catalog API; ~2 min)`,
        });
      }
    }
  } catch (e) {
    // Audit shouldn't fail if asin_images table doesn't exist yet
    if (!/asin_images.*does not exist/i.test(e.message || '')) {
      console.warn('[Audit] missing_images check failed:', e.message);
    }
  }

  // 10. MISSING AD SPEND — a day with real sales but zero ad spend is suspicious.
  // Most days RMC has Sponsored Products spend on at least some ASINs. If a
  // day in the window has units > some threshold but adSpend == 0, the daily
  // ads cron didn't write it (or its run failed silently). Skips today
  // since the 2h ads cron may not have fired yet on a fresh start.
  for (const s of shapes) {
    if (s.date === yest || s.date === todayPst) continue; // today/yesterday are still settling
    if (s.units >= 20 && s.adSpendBlended === 0 && s.rowsWithSpend === 0) {
      findings.push({
        severity: 'warning',
        date: s.date,
        type: 'missing_ad_spend',
        message: `${s.date} has ${s.units} units / CA$${s.blended.toFixed(0)} sales but $0 ad spend. The :20 hourly or 9:10 daily ads cron didn't write it.`,
        remediation: `POST /api/ads/sync-daily?windowDays=3 (will backfill recent days)`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    window: { from: dates[dates.length - 1], to: dates[0] },
    baselines: { rowMedian, unitsMedian, revMedianBlended: revMedian },
    totals: { last7d: r7, last14d: r14, last30d: r30 },
    shapes,
    findings,
    findingsBySeverity: {
      critical: findings.filter(f => f.severity === 'critical').length,
      warning:  findings.filter(f => f.severity === 'warning').length,
      info:     findings.filter(f => f.severity === 'info').length,
    },
  };
}

module.exports = { runChecks };
