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

const MP_CODE = { 'A2EUQ1WTGCTBG2': 'CA', 'ATVPDKIKX0DER': 'US' };

/**
 * Fetch per-ASIN repeat purchase data for the last full month, kept SEPARATE
 * per marketplace. Brand Analytics is brand-scoped per marketplace: it returns
 * the brand's ENTIRE Amazon business in that marketplace, including sales by
 * other sellers/the brand owner. Rollups must therefore only consume the
 * marketplaces a brand actually sells in with us — otherwise we'd report
 * someone else's sales data as the brand's repeat rate.
 *
 * Returns:
 *   { byMarketplace: { CA: { ASIN: { orders, uniqueCustomers, repeatCustomers,
 *                                    repeatRevenueCad, repeatRevenueUsd } }, US: {...} },
 *     period: { start, end } }
 * or null if every marketplace failed (callers keep previous data).
 */
async function fetchRepeatPurchase(marketplaceIds, token) {
  const { start, end } = lastFullMonth();
  const byMarketplace = {};
  let anySuccess = false;

  for (const mpId of marketplaceIds) {
    const mpCode = MP_CODE[mpId] || mpId;
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

      const byAsin = {};
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
      byMarketplace[mpCode] = byAsin;
      anySuccess = true;
      console.log(`[RepeatPurchase] ${mpCode}: ${rows.length} ASINs for ${start} → ${end}`);
    } catch (e) {
      console.warn(`[RepeatPurchase] ${mpCode} failed: ${e.message.slice(0, 160)}`);
    }
    await sleep(2000);
  }

  return anySuccess ? { byMarketplace, period: { start, end } } : null;
}

// Which marketplaces does this brand actually sell in (with us)?
// Source of truth: the brand's marketplace field ('CA', 'US', or 'CA,US').
// Defaults to CA if unset — every current brand sells .ca only.
function brandMarketplaces(brand) {
  const raw = (brand.marketplace || 'CA').toUpperCase();
  return raw.split(',').map(s => s.trim()).filter(s => s === 'CA' || s === 'US');
}

/**
 * Roll per-ASIN data up to one brand-level record — Brand Analytics ONLY,
 * and ONLY the marketplaces this brand sells in with us (BA is brand-scoped,
 * so an unsold marketplace's rows are other sellers' business, not ours).
 *
 * No estimate fallback by design: S&S subscriptions are shown as their own
 * metric and must not be dressed up as a repeat-purchase rate. Brands without
 * BA coverage simply have no repeat data (surfaces show nothing).
 */
function rollupBrandRepeatPurchase(brand, rp) {
  if (!rp) return null;

  const allowed = brandMarketplaces(brand);
  let unique = 0, repeat = 0, orders = 0, revCad = 0, revUsd = 0, covered = 0;

  for (const mpCode of allowed) {
    const byAsin = rp.byMarketplace[mpCode];
    if (!byAsin) continue;
    for (const asin of (brand.asins || [])) {
      const a = byAsin[asin];
      if (!a) continue;
      covered++;
      unique += a.uniqueCustomers; repeat += a.repeatCustomers;
      orders += a.orders; revCad += a.repeatRevenueCad; revUsd += a.repeatRevenueUsd;
    }
  }

  if (covered === 0 || unique === 0) return null;
  return {
    source: 'brand_analytics',
    period: rp.period,
    marketplaces: allowed,
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

module.exports = { fetchRepeatPurchase, rollupBrandRepeatPurchase, brandMarketplaces, lastFullMonth };
