'use strict';
/**
 * daily_metrics_mp double-writes — the expand phase of the multi-marketplace
 * migration (see sql/daily-metrics-mp.sql for the full plan).
 *
 * Each existing writer keeps its wide daily_metrics upsert untouched and
 * additionally emits long rows here: one row per (date, asin, mp_id), with
 * currency as an attribute of the marketplace. Amazon mp_ids are the raw
 * SP-API ids, matching sns_daily / sku_prices.
 *
 * Every entry point is NON-FATAL by design: the wide table is still the
 * source of truth, so a failed long write must never break the sync path
 * that feeds the dashboards. Failures log loudly and return 0.
 */

const MP_CA = 'A2EUQ1WTGCTBG2'; // amazon.ca  (CAD)
const MP_US = 'ATVPDKIKX0DER';  // amazon.com (USD)

// One NaN in a payload becomes null on the wire and fails the whole batch
// atomically — same lesson as persistOrdersDay (the 2026-07-22 wipe).
const num   = v => (Number.isFinite(v) ? v : 0);
const money = v => Math.round(num(v) * 100) / 100;

async function upsertMpRows(supabase, rows, tag) {
  if (!rows || rows.length === 0) return 0;
  try {
    let written = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('daily_metrics_mp')
        .upsert(batch, { onConflict: 'date,asin,mp_id' });
      if (error) {
        console.warn(`[MetricsMp] ${tag} upsert failed (${batch.length} rows):`, error.message);
        continue;
      }
      written += batch.length;
    }
    return written;
  } catch (e) {
    console.warn(`[MetricsMp] ${tag} exception:`, e.message);
    return 0;
  }
}

// Day rewriters call this instead of upsertMpRows. A rewritten day that
// SHRANK (canceled orders, ads restatements, refund recomputes) must not
// leave stale mirror rows behind — the upsert alone never removes values.
// Zero the group's columns for the date first, then upsert. The zero is
// semantically true, not a NULL-discipline violation: every caller rewrites
// its full day, so an ASIN absent from the new data genuinely did 0 that day.
// Two steps, not atomic — a failure in between leaves zeros, which the
// integrity check + backfill script repair; stale non-zero values would lie.
const DAY_COLUMN_GROUPS = {
  orders:  { units: 0, revenue: 0 },
  ads:     { ad_spend: 0, ad_attributed_sales: 0 },
  refunds: { refunded_units: 0, refund_amount: 0, refund_count: 0 },
};

async function replaceDay(supabase, date, group, rows, tag) {
  const zeros = DAY_COLUMN_GROUPS[group];
  if (!zeros) { console.warn(`[MetricsMp] ${tag}: unknown group '${group}'`); return 0; }
  try {
    const { error } = await supabase.from('daily_metrics_mp').update(zeros).eq('date', date);
    if (error) { console.warn(`[MetricsMp] ${tag} zero pass failed:`, error.message); return 0; }
  } catch (e) {
    console.warn(`[MetricsMp] ${tag} zero pass exception:`, e.message);
    return 0;
  }
  return upsertMpRows(supabase, rows, tag);
}

// Orders shape: byAsin[asin] = { unitsCa, unitsUs, revenueCad, revenueUsd }.
// A marketplace with no activity gets no row (absence = no recorded sales,
// same semantics as the wide table's row filter).
function ordersRows(date, byAsin, asinBrand) {
  const rows = [];
  for (const [asin, d] of Object.entries(byAsin || {})) {
    const brand_id = asinBrand[asin] || 'unknown-brand';
    if (num(d.unitsCa) > 0 || num(d.revenueCad) > 0) {
      rows.push({ date, asin, mp_id: MP_CA, currency: 'CAD', brand_id,
                  units: num(d.unitsCa), revenue: money(d.revenueCad) });
    }
    if (num(d.unitsUs) > 0 || num(d.revenueUsd) > 0) {
      rows.push({ date, asin, mp_id: MP_US, currency: 'USD', brand_id,
                  units: num(d.unitsUs), revenue: money(d.revenueUsd) });
    }
  }
  return rows;
}

// Ads shape (merged daily): d = { spendCad, spendUsd, salesCad, salesUsd }.
// Engagement (clicks/impressions/orders) is blended across profiles before
// this point, so those columns stay NULL until sync/ads.js keeps per-profile
// engagement — never write a blended number into a per-marketplace row.
function adsRows(date, asins, asinBrand) {
  const rows = [];
  for (const [asin, d] of Object.entries(asins || {})) {
    const brand_id = asinBrand[asin] || 'unknown-brand';
    if (num(d.spendCad) > 0 || num(d.salesCad) > 0) {
      rows.push({ date, asin, mp_id: MP_CA, currency: 'CAD', brand_id,
                  ad_spend: money(d.spendCad), ad_attributed_sales: money(d.salesCad) });
    }
    if (num(d.spendUsd) > 0 || num(d.salesUsd) > 0) {
      rows.push({ date, asin, mp_id: MP_US, currency: 'USD', brand_id,
                  ad_spend: money(d.spendUsd), ad_attributed_sales: money(d.salesUsd) });
    }
  }
  return rows;
}

// Refunds shape: byAsin[asin] = { ca: {units, amount, count}, us: {...} },
// split per marketplace at the event level by recomputeRefundAggregates.
function refundRows(date, byAsin, asinBrand) {
  const rows = [];
  for (const [asin, v] of Object.entries(byAsin || {})) {
    const brand_id = asinBrand[asin] || 'unknown-brand';
    if (v.ca && (num(v.ca.units) > 0 || num(v.ca.amount) > 0 || num(v.ca.count) > 0)) {
      rows.push({ date, asin, mp_id: MP_CA, currency: 'CAD', brand_id,
                  refunded_units: num(v.ca.units), refund_amount: money(v.ca.amount),
                  refund_count: num(v.ca.count) });
    }
    if (v.us && (num(v.us.units) > 0 || num(v.us.amount) > 0 || num(v.us.count) > 0)) {
      rows.push({ date, asin, mp_id: MP_US, currency: 'USD', brand_id,
                  refunded_units: num(v.us.units), refund_amount: money(v.us.amount),
                  refund_count: num(v.us.count) });
    }
  }
  return rows;
}

module.exports = { MP_CA, MP_US, upsertMpRows, replaceDay, ordersRows, adsRows, refundRows };
