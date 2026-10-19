'use strict';
/**
 * Fee breakdown aggregation — pure functions behind GET /api/fees (Mike,
 * 2026-10-19: Sellerboard-grade fee granularity in the app + a fee-level
 * recon of Sellerboard vs our Amazon account).
 *
 * Two sides, aggregated per marketplace CODE in native currency; the client
 * (public/fee-breakdown.js) scopes, converts to display currency and lays the
 * recon table over the shared group mapping.
 *
 *  - Sellerboard: sellerboard_daily rows; per-type amounts ride fee_detail
 *    (SELLERBOARD'S SIGN: costs negative, reimbursements positive — shown as
 *    Sellerboard's own expanded panel shows them).
 *  - Amazon: daily_fees_asin rows (per-item fees; brand-scopable) or
 *    daily_fees_mp rows (account-level incl. storage/inbound service fees).
 *    breakdown groups are positive costs (Finances-walk convention).
 *
 * BASIS: Sellerboard books fees/refunds to the ORDER day, Amazon's Finances
 * walk to the POSTED day — a few % of window noise is structural, same as the
 * nightly reconciliation's 10% fee tolerance. Storage is amortized daily by
 * Sellerboard but posted monthly by Amazon, so short windows diverge hard.
 */

const MP = require('./marketplaces');

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

function aggSellerboard(rows) {
  const byMp = {};
  for (const r of rows || []) {
    const code = MP.codeOf(r.mp_id) || r.mp_id;
    const s = byMp[code] || (byMp[code] = {
      code, currency: r.currency,
      sales: 0, units: 0, refundUnits: 0, refundAmount: 0, promo: 0,
      amazonFees: 0, feeCharges: 0, reimbursements: 0, productCosts: 0,
      adSpend: 0, adSplit: { sp: 0, sb: 0, sbv: 0, sd: 0 },
      types: {},
    });
    s.sales += +r.sales || 0;
    s.units += +r.units || 0;
    s.refundUnits += +r.refunds || 0;
    s.refundAmount += +r.refund_amount || 0;
    s.promo += +r.promo_value || 0;
    s.amazonFees += +r.amazon_fees || 0;
    s.feeCharges += +r.fee_charges || 0;
    s.reimbursements += +r.reimbursements || 0;
    s.productCosts += +r.product_costs || 0;
    s.adSpend += +r.ad_spend || 0;
    s.adSplit.sp += +r.ad_spend_sp || 0;
    s.adSplit.sb += +r.ad_spend_sb || 0;
    s.adSplit.sbv += +r.ad_spend_sbv || 0;
    s.adSplit.sd += +r.ad_spend_sd || 0;
    for (const [k, v] of Object.entries(r.fee_detail || {})) {
      if (+v) s.types[k] = (s.types[k] || 0) + +v;
    }
  }
  for (const s of Object.values(byMp)) {
    for (const k of ['sales', 'refundAmount', 'promo', 'amazonFees', 'feeCharges', 'reimbursements', 'productCosts', 'adSpend']) s[k] = r2(s[k]);
    for (const k of Object.keys(s.adSplit)) s.adSplit[k] = r2(s.adSplit[k]);
    for (const k of Object.keys(s.types)) { s.types[k] = r2(s.types[k]); if (s.types[k] === 0) delete s.types[k]; }
  }
  return byMp;
}

// daily_fees_asin rows (per-item fees only — storage/subscriptions stay
// account-level by design). `asinFilter` is a Set of ASINs or null for all.
function aggAmazonAsin(rows, asinFilter = null) {
  const byMp = {};
  for (const r of rows || []) {
    if (asinFilter && !asinFilter.has(r.asin)) continue;
    const code = MP.codeOf(r.mp_id) || r.mp_id;
    const s = byMp[code] || (byMp[code] = {
      code, currency: r.currency,
      fees: 0, refundAmount: 0, refundFees: 0, refundCount: 0, serviceFees: null,
      groups: {},
    });
    s.fees += +r.fees || 0;
    s.refundAmount += +r.refund_amount || 0;
    s.refundFees += +r.refund_fees || 0;
    s.refundCount += +r.refund_count || 0;
    for (const [k, v] of Object.entries(r.breakdown || {})) {
      if (+v) s.groups[k] = (s.groups[k] || 0) + +v;
    }
  }
  roundAmz(byMp);
  return byMp;
}

// daily_fees_mp rows (account-level: per-item fees + service fees, full
// breakdown incl. Storage / Inbound / Removal).
function aggAmazonMp(rows) {
  const byMp = {};
  for (const r of rows || []) {
    const code = MP.codeOf(r.mp_id) || r.mp_id;
    const s = byMp[code] || (byMp[code] = {
      code, currency: r.currency,
      fees: 0, refundAmount: 0, refundFees: 0, refundCount: 0, serviceFees: 0,
      groups: {},
    });
    s.fees += +r.fees || 0;
    s.serviceFees += +r.service_fees || 0;
    s.refundAmount += +r.refund_amount || 0;
    s.refundFees += +r.refund_fees || 0;
    s.refundCount += +r.refund_count || 0;
    for (const [k, v] of Object.entries(r.breakdown || {})) {
      if (+v) s.groups[k] = (s.groups[k] || 0) + +v;
    }
  }
  roundAmz(byMp);
  return byMp;
}

function roundAmz(byMp) {
  for (const s of Object.values(byMp)) {
    for (const k of ['fees', 'refundAmount', 'refundFees', 'serviceFees']) if (s[k] != null) s[k] = r2(s[k]);
    for (const k of Object.keys(s.groups)) { s.groups[k] = r2(s.groups[k]); if (s.groups[k] === 0) delete s.groups[k]; }
  }
}

module.exports = { aggSellerboard, aggAmazonAsin, aggAmazonMp };
