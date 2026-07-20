/**
 * Repeat Purchase Rate — per-ASIN from Amazon Brand Analytics.
 *
 * Source: GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT (MONTH period). Amazon
 * matches customer accounts internally and returns aggregates per ASIN:
 * orders, uniqueCustomers, repeatCustomersPctTotal, repeatPurchaseRevenue.
 * This is the only legitimate source of true repeat-purchase data — the
 * Orders API carries no customer identity (and buyer PII may not be used for
 * analytics), so any non-BA number is an estimate by definition.
 *
 * Coverage follows Brand Registry authorization: ASINs of brands the account
 * isn't registered/authorized for simply don't appear in the report. Callers
 * fall back to an S&S-derived estimate for those (clearly labeled as such).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createReport, waitForReport, downloadReport, sleep } = require('./amazon');
const { pstDateStr } = require('./dateUtils');

// Last full calendar month in PST: e.g. on 2026-07-20 → June 1-30.
function lastFullMonth() {
  const today = pstDateStr();                       // YYYY-MM-DD
  const [y, m] = today.split('-').map(Number);
  const firstThis = new Date(Date.UTC(y, m - 1, 1));
  const firstPrev = new Date(Date.UTC(y, m - 2, 1));
  const lastPrev  = new Date(firstThis.getTime() - 24 * 3600 * 1000);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(firstPrev), end: fmt(lastPrev) };
}

/**
 * Fetch per-ASIN repeat purchase data for the last full month, both
 * marketplaces combined. Returns:
 *   { byAsin: { ASIN: { orders, uniqueCustomers, repeatCustomers,
 *                       repeatRevenueCad, repeatRevenueUsd } },
 *     period: { start, end } }
 * or null if every marketplace failed (callers keep previous data).
 */
async function fetchRepeatPurchase(marketplaceIds, token) {
  const { start, end } = lastFullMonth();
  const byAsin = {};
  let anySuccess = false;

  for (const mpId of marketplaceIds) {
    try {
      const reportId = await createReport(
        'GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT', [mpId],
        { reportPeriod: 'MONTH' },
        { start: `${start}T00:00:00Z`, end: `${end}T23:59:59Z` },
        token
      );
      const docId = await waitForReport(reportId, token, 300000);
      const raw   = await downloadReport(docId, token);
      const rows  = JSON.parse(raw).dataByAsin || [];

      for (const r of rows) {
        const asin = (r.asin || '').trim().toUpperCase();
        if (!asin) continue;
        if (!byAsin[asin]) {
          byAsin[asin] = { orders: 0, uniqueCustomers: 0, repeatCustomers: 0, repeatRevenueCad: 0, repeatRevenueUsd: 0 };
        }
        const a = byAsin[asin];
        const unique = r.uniqueCustomers || 0;
        a.orders          += r.orders || 0;
        a.uniqueCustomers += unique;
        // repeatCustomersPctTotal is a FRACTION (0.0909 = 9.09%, 1 = 100%) —
        // verified against raw data 2026-07-20 (B003Z4UKGM: 7/77 = 0.0909).
        // Convert to a count so brand rollups are customer-weighted.
        a.repeatCustomers += Math.round((r.repeatCustomersPctTotal || 0) * unique);
        const rev = r.repeatPurchaseRevenue || {};
        if (rev.currencyCode === 'CAD') a.repeatRevenueCad += rev.amount || 0;
        else                            a.repeatRevenueUsd += rev.amount || 0;
      }
      anySuccess = true;
      console.log(`[RepeatPurchase] ${mpId}: ${rows.length} ASINs for ${start} → ${end}`);
    } catch (e) {
      console.warn(`[RepeatPurchase] ${mpId} failed: ${e.message.slice(0, 160)}`);
    }
    await sleep(2000);
  }

  return anySuccess ? { byAsin, period: { start, end } } : null;
}

/**
 * Roll per-ASIN data up to one brand-level record.
 *
 * Primary (source: 'brand_analytics') — true rate from Amazon's customer
 * matching: repeat customers ÷ unique customers across the brand's ASINs.
 *
 * Fallback (source: 'sns_estimate') — for brands with no BA coverage: S&S
 * subscription revenue as a share of the brand's month revenue. A FLOOR, not
 * the true rate (manual re-orders invisible). Every surface showing it must
 * label it as an estimate.
 *
 * @param brand        brand object (asins, asinSnsRevenue from S&S fetch)
 * @param rp           result of fetchRepeatPurchase (may be null)
 * @param monthRevenue { cad, usd } brand revenue for the same period (for the estimate)
 */
function rollupBrandRepeatPurchase(brand, rp, monthRevenue) {
  const period = rp?.period || null;

  // ── Primary: Brand Analytics ──
  if (rp) {
    let unique = 0, repeat = 0, orders = 0, revCad = 0, revUsd = 0, covered = 0;
    for (const asin of (brand.asins || [])) {
      const a = rp.byAsin[asin];
      if (!a) continue;
      covered++;
      unique += a.uniqueCustomers; repeat += a.repeatCustomers;
      orders += a.orders; revCad += a.repeatRevenueCad; revUsd += a.repeatRevenueUsd;
    }
    if (covered > 0 && unique > 0) {
      return {
        source: 'brand_analytics',
        period,
        repeatCustomersPct: Math.round(repeat / unique * 1000) / 10,
        uniqueCustomers:    unique,
        repeatCustomers:    repeat,
        orders,
        repeatRevenueCad:   Math.round(revCad * 100) / 100,
        repeatRevenueUsd:   Math.round(revUsd * 100) / 100,
        coveredAsins:       covered,
        updatedAt:          new Date().toISOString(),
      };
    }
  }

  // ── Fallback: S&S-derived estimate ──
  const snsRev = brand.asinSnsRevenue || {};
  let snsCad = 0, snsUsd = 0;
  for (const v of Object.values(snsRev)) { snsCad += v.cad || 0; snsUsd += v.usd || 0; }
  const totalRev = (monthRevenue?.cad || 0) + (monthRevenue?.usd || 0);
  const snsTotal = snsCad + snsUsd;
  if (snsTotal > 0 && totalRev > 0) {
    return {
      source: 'sns_estimate',
      period,
      // Share of revenue on subscription — a floor on true repeat behaviour.
      repeatRevenueSharePct: Math.min(100, Math.round(snsTotal / totalRev * 1000) / 10),
      snsRevenueCad: Math.round(snsCad * 100) / 100,
      snsRevenueUsd: Math.round(snsUsd * 100) / 100,
      updatedAt: new Date().toISOString(),
    };
  }

  return null; // no signal at all — surfaces show "—"
}

module.exports = { fetchRepeatPurchase, rollupBrandRepeatPurchase, lastFullMonth };
