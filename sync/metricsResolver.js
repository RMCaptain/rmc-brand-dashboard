'use strict';
/**
 * Source-of-truth resolver: Sellerboard first, Amazon otherwise, flag when
 * both exist and disagree. Mike's rule (2026-09-09): every marketplace reads
 * through ONE path so CA, US, UK (and Walmart later) behave identically.
 *
 * Per (asin, marketplace, day):
 *   - if Sellerboard has rows for that marketplace on that day → Sellerboard's
 *     numbers are the resolved value; Amazon's numbers for the same day are
 *     kept aside and compared (flag when outside tolerance)
 *   - otherwise → Amazon's numbers (the wide daily_metrics row, split CA/US by
 *     its currency columns, plus daily_fees_asin for fees)
 * Coverage is decided per marketplace-day, not per ASIN: a Sellerboard day
 * with no row for an ASIN means that ASIN sold nothing that day.
 *
 * Money metrics: units, sales, adSpend, attributedSales (Amazon-only — SB has
 * no attributed sales), refunds (units), refundAmount, fees, netProfit
 * (Sellerboard-only), promo (Sellerboard-only), cogsSb (Sellerboard's COGS,
 * informational — the dashboard prices COGS from its own buy costs).
 * Traffic (sessions, page views, buy box), inventory and ad engagement never
 * come through here — they stay Amazon-only in the caller.
 *
 * Output is native-currency per marketplace; FX conversion is the caller's
 * job (fx.rates in /api/fx).
 */

const MP = require('./marketplaces');
const { compare } = require('./reconcileSellerboard');

const CA = MP.idByCode('CA');
const US = MP.idByCode('US');
const RESOLVED_METRICS = ['units', 'sales', 'adSpend', 'attributedSales', 'refunds', 'refundAmount', 'fees', 'netProfit', 'promo', 'cogsSb'];
// Metrics compared for flags (both sides carry them). Fees compare only when
// the Amazon side has per-ASIN fee rows for the day.
const FLAG_METRICS = { units: 'units', sales: 'sales', adSpend: 'ad_spend', refunds: 'refunds', refundAmount: 'refund_amount', fees: 'amazon_fees' };

const num = v => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : 0));
const r2  = v => Math.round(v * 100) / 100;
const empty = () => ({ units: 0, sales: 0, adSpend: 0, attributedSales: 0, refunds: 0, refundAmount: 0, fees: 0, netProfit: 0, promo: 0, cogsSb: 0 });

function slot(byAsin, asin, mp) {
  const a = byAsin[asin] || (byAsin[asin] = {});
  return a[mp] || (a[mp] = { resolved: empty(), amz: empty(), sb: empty(), sbDays: new Set(), amzDays: new Set(), amzFeeDays: new Set() });
}

// Split a wide daily_metrics row into its CA / US marketplace parts.
function wideParts(r) {
  const refUnits = num(r.refunded_units);
  const rc = num(r.refund_amount_cad), ru = num(r.refund_amount_usd);
  // refunded_units is blended on the wide row — allocate by refund dollars,
  // else by where the ASIN sold that day.
  let refCa = 0, refUs = 0;
  if (refUnits > 0) {
    if (rc > 0 && ru > 0) { refCa = Math.round(refUnits * rc / (rc + ru)); refUs = refUnits - refCa; }
    else if (ru > 0) refUs = refUnits;
    else if (rc > 0) refCa = refUnits;
    else if (num(r.units_us) > 0 && num(r.units_ca) === 0) refUs = refUnits;
    else refCa = refUnits;
  }
  return {
    [CA]: { units: num(r.units_ca), sales: num(r.revenue_cad), adSpend: num(r.spend_cad), attributedSales: num(r.attributed_sales_7d_cad ?? r.attributed_sales_cad), refunds: refCa, refundAmount: rc },
    [US]: { units: num(r.units_us), sales: num(r.revenue_usd), adSpend: num(r.spend_usd), attributedSales: num(r.attributed_sales_7d_usd ?? r.attributed_sales_usd), refunds: refUs, refundAmount: ru },
  };
}

/**
 * @param wideRows   daily_metrics rows for the range (any columns; uses the currency-split ones)
 * @param sbRows     sellerboard_daily rows for the range (date, mp_id, asin, units, sales, ad_spend, refunds, refund_amount, amazon_fees, net_profit, promo_value, product_costs)
 * @param feeByAsinMpDate  { `${asin}|${mp_id}|${date}`: fees } from daily_fees_asin (positive)
 * @returns { byAsin, coverage, marketplaces }
 */
function resolveByAsin({ wideRows = [], sbRows = [], feeByAsinMpDate = {}, from, to }) {
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  const coverage = {}; // mp → Set(dates)
  for (const r of sbRows) {
    if (!inRange(r.date)) continue;
    (coverage[r.mp_id] || (coverage[r.mp_id] = new Set())).add(r.date);
  }
  const covered = (mp, date) => !!coverage[mp]?.has(date);

  const byAsin = {};

  // Sellerboard side — always the resolved value on its days.
  for (const r of sbRows) {
    if (!inRange(r.date)) continue;
    const s = slot(byAsin, r.asin, r.mp_id);
    const add = { units: num(r.units), sales: num(r.sales), adSpend: num(r.ad_spend), attributedSales: 0, refunds: num(r.refunds), refundAmount: num(r.refund_amount), fees: num(r.amazon_fees), netProfit: num(r.net_profit), promo: num(r.promo_value), cogsSb: num(r.product_costs) };
    for (const k of RESOLVED_METRICS) { s.resolved[k] += add[k]; s.sb[k] += add[k]; }
    s.sbDays.add(r.date);
  }

  // Amazon side — resolved on uncovered days, comparison-only on covered days.
  for (const r of wideRows) {
    if (!inRange(r.date)) continue;
    const parts = wideParts(r);
    for (const mp of [CA, US]) {
      const p = parts[mp];
      const fees = num(feeByAsinMpDate[`${r.asin}|${mp}|${r.date}`]);
      const any = p.units || p.sales || p.adSpend || p.attributedSales || p.refunds || p.refundAmount || fees;
      if (!any) continue;
      const s = slot(byAsin, r.asin, mp);
      const target = covered(mp, r.date) ? s.amz : s.resolved;
      target.units += p.units; target.sales += p.sales; target.adSpend += p.adSpend;
      target.attributedSales += p.attributedSales; target.refunds += p.refunds; target.refundAmount += p.refundAmount;
      target.fees += fees;
      // Attributed sales exist only on the Amazon side — carry them into the
      // resolved view even on Sellerboard days (Sellerboard has no equivalent).
      if (target === s.amz) s.resolved.attributedSales += p.attributedSales;
      if (covered(mp, r.date)) { s.amzDays.add(r.date); if (fees) s.amzFeeDays.add(r.date); }
    }
  }
  // Fee rows for (asin, mp, date) with no wide row that day (rare: fees posted
  // on a no-sale day) — still Amazon-side fees.
  for (const [key, fees] of Object.entries(feeByAsinMpDate)) {
    const [asin, mp, date] = key.split('|');
    if (!inRange(date) || !num(fees)) continue;
    const s = slot(byAsin, asin, mp);
    const seenViaWide = wideRows.some(r => r.asin === asin && r.date === date);
    if (seenViaWide) continue;
    if (covered(mp, date)) { s.amz.fees += num(fees); s.amzDays.add(date); s.amzFeeDays.add(date); }
    else s.resolved.fees += num(fees);
  }

  // Finalize: source label + flags per (asin, mp).
  const marketplaces = new Set();
  for (const [asin, mps] of Object.entries(byAsin)) {
    for (const [mp, s] of Object.entries(mps)) {
      marketplaces.add(mp);
      const sbDays = s.sbDays.size;
      const amzOnlyDays = [...(coverage[mp] ? [] : [])]; // placeholder for clarity
      const hasAmzResolved = Object.values(s.resolved).some(Boolean) && !sbDays;
      s.source = sbDays ? (s.resolved.units !== s.sb.units || s.resolved.sales !== s.sb.sales ? 'mixed' : 'sellerboard') : 'amazon';
      // 'mixed' = Sellerboard on its days, Amazon on the rest (range extends
      // past Sellerboard coverage). Computed on units/sales identity above.
      s.flags = {};
      if (sbDays && s.amzDays.size) {
        for (const [k, metric] of Object.entries(FLAG_METRICS)) {
          if (k === 'fees' && !s.amzFeeDays.size) continue;
          const c = compare(metric, s.amz[k], s.sb[k]);
          if (c && c.status !== 'match') s.flags[k] = { amazon: c.amazon_value, sellerboard: c.sellerboard_value, delta: c.delta, deltaPct: c.delta_pct, status: c.status };
        }
      }
      for (const k of RESOLVED_METRICS) { s.resolved[k] = r2(s.resolved[k]); s.amz[k] = r2(s.amz[k]); s.sb[k] = r2(s.sb[k]); }
      s.sbDays = sbDays; s.amzDays = s.amzDays.size; delete s.amzFeeDays;
      void hasAmzResolved; void amzOnlyDays;
    }
  }

  const cov = {};
  for (const [mp, dates] of Object.entries(coverage)) {
    const sorted = [...dates].sort();
    cov[mp] = { days: sorted.length, from: sorted[0], to: sorted[sorted.length - 1] };
  }
  return { byAsin, coverage: cov, coverageDates: coverage, marketplaces: [...marketplaces] };
}

// Sum resolved slots into one per-marketplace aggregate with source + flags.
// `slots` = array of per-(asin,mp) slot objects for one marketplace.
function aggregateMp(slots) {
  const out = { ...empty(), source: 'amazon', flags: {}, sbDays: 0, amzDays: 0 };
  const amz = empty(), sb = empty();
  let anySb = false, anyAmz = false, anyMixed = false, anyAmzFlagSide = false;
  for (const s of slots) {
    for (const k of RESOLVED_METRICS) { out[k] += s.resolved[k]; amz[k] += s.amz[k]; sb[k] += s.sb[k]; }
    if (s.source === 'sellerboard') anySb = true;
    else if (s.source === 'mixed') anyMixed = true;
    else anyAmz = true;
    if (s.amzDays) anyAmzFlagSide = true;
    out.sbDays = Math.max(out.sbDays, s.sbDays || 0);
    out.amzDays = Math.max(out.amzDays, s.amzDays || 0);
  }
  out.source = anyMixed || (anySb && anyAmz) ? 'mixed' : anySb ? 'sellerboard' : 'amazon';
  if ((anySb || anyMixed) && anyAmzFlagSide) {
    for (const [k, metric] of Object.entries(FLAG_METRICS)) {
      if (k === 'fees' && !amz.fees) continue;
      const c = compare(metric, amz[k], sb[k]);
      if (c && c.status !== 'match') out.flags[k] = { amazon: c.amazon_value, sellerboard: c.sellerboard_value, delta: c.delta, deltaPct: c.delta_pct, status: c.status };
    }
  }
  for (const k of RESOLVED_METRICS) out[k] = r2(out[k]);
  out.amazonSide = amz; out.sellerboardSide = sb;
  return out;
}

/**
 * Account-level financials per marketplace, Sellerboard first.
 * @param feeRows  daily_fees rows (wide: fees_cad/usd, service_fees_*, refund_amount_*, refund_fees_*, breakdown_*)
 * @param sbRows   sellerboard_daily rows
 * @param coverageDates { mp: Set(dates) } from resolveByAsin
 * Returns { [mp]: { amazonFees, serviceFees, refundAmount, refundFees, breakdown, netProfit, days, sbDays, source } }
 */
function resolveFinancials({ feeRows = [], sbRows = [], coverageDates = {}, from, to }) {
  const inRange = d => (!from || d >= from) && (!to || d <= to);
  const out = {};
  const get = mp => out[mp] || (out[mp] = { amazonFees: 0, serviceFees: 0, refundAmount: 0, refundFees: 0, refundCount: 0, breakdown: {}, netProfit: 0, days: new Set(), sbDays: new Set(), amazonSide: { amazonFees: 0, refundAmount: 0 }, sellerboardSide: { amazonFees: 0, refundAmount: 0 } });
  const covered = (mp, d) => !!coverageDates[mp]?.has(d);

  for (const r of sbRows) {
    if (!inRange(r.date)) continue;
    const f = get(r.mp_id);
    f.amazonFees += num(r.amazon_fees); f.refundAmount += num(r.refund_amount); f.refundCount += num(r.refunds);
    f.netProfit += num(r.net_profit);
    f.sellerboardSide.amazonFees += num(r.amazon_fees); f.sellerboardSide.refundAmount += num(r.refund_amount);
    f.days.add(r.date); f.sbDays.add(r.date);
  }
  for (const r of feeRows) {
    if (!inRange(r.date)) continue;
    for (const [mp, sfx] of [[CA, 'cad'], [US, 'usd']]) {
      const fees = num(r[`fees_${sfx}`]), svc = num(r[`service_fees_${sfx}`]);
      const ref = num(r[`refund_amount_${sfx}`]), refFees = num(r[`refund_fees_${sfx}`]);
      const brk = r[`breakdown_${sfx}`] || {};
      if (!fees && !svc && !ref && !refFees) continue;
      const f = get(mp);
      f.days.add(r.date);
      for (const [k, v] of Object.entries(brk)) f.breakdown[k] = r2((f.breakdown[k] || 0) + num(v));
      f.refundFees += refFees;
      if (covered(mp, r.date)) {
        // Sellerboard's per-product fees already carry storage; keep the
        // rest of the account-level service fees (subscription, Vine, coupons…).
        f.serviceFees += Math.max(0, svc - num(brk.Storage));
        f.amazonSide.amazonFees += fees; f.amazonSide.refundAmount += ref;
      } else {
        f.amazonFees += fees; f.serviceFees += svc; f.refundAmount += ref;
        f.refundCount += num(r.refund_count) && mp === CA ? num(r.refund_count) : 0; // wide count is blended; ride CA (same as daily_fees_mp backfill)
      }
    }
  }
  for (const [mp, f] of Object.entries(out)) {
    const sbDays = f.sbDays.size, days = f.days.size;
    f.source = sbDays === 0 ? 'amazon' : sbDays === days ? 'sellerboard' : 'mixed';
    f.flags = {};
    if (sbDays && (f.amazonSide.amazonFees || f.amazonSide.refundAmount)) {
      for (const [k, metric] of [['amazonFees', 'amazon_fees'], ['refundAmount', 'refund_amount']]) {
        const c = compare(metric, f.amazonSide[k], f.sellerboardSide[k]);
        if (c && c.status !== 'match') f.flags[k] = { amazon: c.amazon_value, sellerboard: c.sellerboard_value, delta: c.delta, deltaPct: c.delta_pct, status: c.status };
      }
    }
    for (const k of ['amazonFees', 'serviceFees', 'refundAmount', 'refundFees', 'netProfit']) f[k] = r2(f[k]);
    f.days = days; f.sbDays = sbDays;
    f.currency = MP.currencyOf(mp);
  }
  return out;
}

module.exports = { resolveByAsin, aggregateMp, resolveFinancials, RESOLVED_METRICS, FLAG_METRICS, empty };
