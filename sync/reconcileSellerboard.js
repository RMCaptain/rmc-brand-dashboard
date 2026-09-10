'use strict';
/**
 * Amazon-API vs Sellerboard reconciliation → metric_reconciliation.
 *
 * Runs after every Sellerboard feed ingest (sync/sellerboard.js). For each
 * day in the window, marketplace, and scope, it sums both sides and writes a
 * row per metric with a status. The UI and the integrity alert read those
 * rows; this module never decides what to DISPLAY, only what disagrees.
 *
 * Amazon side (what the dashboard computes itself):
 *   units / sales / ad_spend        ← daily_metrics_mp (ad_spend is Sponsored
 *                                     Products only, so the Sellerboard side is
 *                                     ad_spend_sp, not the SB+SD-inclusive total)
 *   amazon_fees                     ← daily_fees_asin (per ASIN), daily_fees_mp
 *                                     (account): `fees` = referral + FBA fulfillment
 *                                     (+ Other); storage / inbound / removal live in
 *                                     service_fees and are NOT compared
 *   refunds / refund_amount         ← daily_fees_asin / daily_fees_mp (posted-day
 *                                     refund events — the basis Sellerboard uses;
 *                                     daily_metrics_mp keys refunds to the ORDER day)
 * Sellerboard side: sellerboard_daily, aggregated SKU → ASIN, in marketplace
 * currency (the ingest converts the account-currency feed; see sync/sellerboard.js).
 *   amazon_fees ← order_fees (commission + FBA per-unit + sales-tax collection),
 *   the same per-order basis; reimbursements, storage, inbound and removal are
 *   excluded on both sides (verified 2026-09-10: CA -5%, US -1.4% over 7 days).
 *
 * Sessions are not reconciled: traffic is Amazon-first by design and
 * Sellerboard's sessions lag and count differently (~10% low, verified 2026-09-09).
 *
 * Tolerance (Mike, 2026-09-09): money max($25, 1%), counts max(2, 1%) for
 * units / sales / ad_spend, which share a basis with Amazon and match to the
 * cent on a clean day. Fees and refunds get 10%: Sellerboard books them to
 * the order day, Amazon's Finances walk to the posted day (a day or two
 * later), so daily rows lag each other by design and the `account_7d` scope
 * (trailing 7-day sums) is the row that should stay green.
 *
 * Volume control: account / account_7d / brand rows are stored for every
 * status; asin rows only when status != 'match', and only for the trailing
 * ASIN_DAYS days (the window's asin rows are deleted first so a cleared flag
 * disappears rather than lingering).
 */

const MP = require('./marketplaces');
const { pstDateStr, pstSubtractDays } = require('./dateUtils');

const MONEY_METRICS = new Set(['sales', 'ad_spend', 'refund_amount', 'amazon_fees']);
const LAGGED_METRICS = new Set(['amazon_fees', 'refunds', 'refund_amount']); // order-day vs posted-day basis
const METRICS = ['units', 'sales', 'ad_spend', 'refunds', 'refund_amount', 'amazon_fees', 'sessions'];
const TOL = { moneyAbs: 25, countAbs: 2, pct: 0.01, laggedPct: 0.10 };
const ASIN_DAYS = 7;

const num = v => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : 0));
const r2  = v => Math.round(v * 100) / 100;

function tolerance(metric, a, b) {
  const pct = LAGGED_METRICS.has(metric) ? TOL.laggedPct : TOL.pct;
  const base = Math.max(Math.abs(a), Math.abs(b)) * pct;
  return Math.max(MONEY_METRICS.has(metric) ? TOL.moneyAbs : TOL.countAbs, base);
}

// Amazon fee row → per-order fees. `fees` already excludes storage / inbound /
// removal (those are service_fees); subtracting the Storage bucket again made
// 2026-09-07 US read -150.80 on the first live run.
const orderFees = r => num(r.fees);

// One comparison → row fields (or null when both sides are absent/zero).
function compare(metric, amazon, sellerboard) {
  const a = amazon == null ? null : r2(num(amazon));
  const s = sellerboard == null ? null : r2(num(sellerboard));
  const aZero = a == null || a === 0, sZero = s == null || s === 0;
  if (aZero && sZero) return null;
  if (aZero) return { amazon_value: a, sellerboard_value: s, delta: r2((a || 0) - s), delta_pct: null, status: 'sb_only' };
  if (sZero) return { amazon_value: a, sellerboard_value: s, delta: r2(a - (s || 0)), delta_pct: null, status: 'amz_only' };
  const delta = r2(a - s);
  const pct = r2((delta / Math.abs(s)) * 100);
  return { amazon_value: a, sellerboard_value: s, delta, delta_pct: pct, status: Math.abs(delta) > tolerance(metric, a, s) ? 'flag' : 'match' };
}

// Default paginated reader (same shape as integrityCheck's) — injectable for tests.
async function defaultFetchAll(supabase, table, columns, from, to, order) {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    let q = supabase.from(table).select(columns).gte('date', from).lte('date', to);
    for (const key of order) q = q.order(key, { ascending: true });
    const { data, error } = await q.range(start, start + 999);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// Accumulator keyed by `${date}|${mp}|${scope}|${scopeId}` → { metric: value }
function bump(acc, date, mp, scope, scopeId, metric, v) {
  if (v == null) return;
  const key = `${date}|${mp}|${scope}|${scopeId}`;
  const slot = acc[key] || (acc[key] = { date, mp, scope, scopeId, m: {} });
  slot.m[metric] = (slot.m[metric] || 0) + num(v);
}

/**
 * Pure core: given both sides' rows and an asin→brand map, produce the
 * reconciliation rows. Exported for tests.
 */
function reconcileRows({ sbRows, mpRows, feeAsinRows, feeMpRows, asinBrand, yesterday, days = 30 }) {
  const from = pstSubtractDays(yesterday, days - 1);
  const asinFrom = pstSubtractDays(yesterday, ASIN_DAYS - 1);
  const brandOf = asin => asinBrand[asin] || 'unknown-brand';
  const A = {}, S = {};

  // ── Amazon side ──
  for (const r of mpRows) {
    if (r.date < from || r.date > yesterday) continue;
    const b = brandOf(r.asin);
    for (const [metric, v] of [['units', r.units], ['sales', r.revenue], ['ad_spend', r.ad_spend], ['sessions', r.sessions]]) {
      // sessions is NULL on mirror rows predating the traffic writer
      // (2026-09-10) — absent, not zero; a null bump would fake sb_only rows.
      if (metric === 'sessions' && v == null) continue;
      bump(A, r.date, r.mp_id, 'account', '*', metric, v);
      bump(A, r.date, r.mp_id, 'brand', b, metric, v);
      if (r.date >= asinFrom) bump(A, r.date, r.mp_id, 'asin', r.asin, metric, v);
    }
  }
  for (const r of feeAsinRows) {
    if (r.date < from || r.date > yesterday || String(r.asin).startsWith('sku:')) continue;
    const b = brandOf(r.asin);
    for (const [metric, v] of [['amazon_fees', orderFees(r)], ['refunds', r.refund_count], ['refund_amount', r.refund_amount]]) {
      bump(A, r.date, r.mp_id, 'brand', b, metric, v);
      if (r.date >= asinFrom) bump(A, r.date, r.mp_id, 'asin', r.asin, metric, v);
    }
  }
  for (const r of feeMpRows) {
    if (r.date < from || r.date > yesterday) continue;
    for (const [metric, v] of [['amazon_fees', orderFees(r)], ['refunds', r.refund_count], ['refund_amount', r.refund_amount]]) {
      bump(A, r.date, r.mp_id, 'account', '*', metric, v);
    }
  }

  // ── Sellerboard side (SKU rows → ASIN) ──
  for (const r of sbRows) {
    if (r.date < from || r.date > yesterday) continue;
    const b = brandOf(r.asin);
    for (const [metric, v] of [['units', r.units], ['sales', r.sales], ['ad_spend', r.ad_spend_sp], ['refunds', r.refunds], ['refund_amount', r.refund_amount], ['amazon_fees', r.order_fees], ['sessions', r.sessions]]) {
      if (metric === 'sessions' && v == null) continue;
      bump(S, r.date, r.mp_id, 'account', '*', metric, v);
      bump(S, r.date, r.mp_id, 'brand', b, metric, v);
      if (r.date >= asinFrom) bump(S, r.date, r.mp_id, 'asin', r.asin, metric, v);
    }
  }

  // ── Trailing-7d account scope (per mp) — the alert-grade signal ──
  const sevenFrom = pstSubtractDays(yesterday, 6);
  for (const side of [A, S]) {
    for (const slot of Object.values(side)) {
      if (slot.scope !== 'account' || slot.date < sevenFrom) continue;
      for (const [metric, v] of Object.entries(slot.m)) bump(side, yesterday, slot.mp, 'account_7d', '*', metric, v);
    }
  }

  // ── Compare ──
  const out = [];
  const keys = new Set([...Object.keys(A), ...Object.keys(S)]);
  for (const key of keys) {
    const a = A[key], s = S[key];
    const meta = a || s;
    for (const metric of METRICS) {
      const cmp = compare(metric, a?.m[metric], s?.m[metric]);
      if (!cmp) continue;
      if (meta.scope === 'asin' && cmp.status === 'match') continue;
      out.push({ date: meta.date, mp_id: meta.mp, scope: meta.scope, scope_id: meta.scopeId, metric, ...cmp });
    }
  }
  return { rows: out, from, asinFrom };
}

function summarize(rows, yesterday) {
  const by = {};
  for (const r of rows) {
    const k = `${r.scope}:${r.status}`;
    by[k] = (by[k] || 0) + 1;
  }
  const flags7d = rows.filter(r => r.scope === 'account_7d' && r.status === 'flag');
  const accountFlags = rows.filter(r => r.scope === 'account' && r.status === 'flag').sort((a, b) => (a.date < b.date ? 1 : -1));
  const brandFlags = rows.filter(r => r.scope === 'brand' && r.status === 'flag');
  const fmt = r => `${r.date} ${MP.codeOf(r.mp_id) || r.mp_id} ${r.scope === 'brand' ? r.scope_id + ' ' : ''}${r.metric}: Amazon ${r.amazon_value} vs Sellerboard ${r.sellerboard_value} (${r.delta > 0 ? '+' : ''}${r.delta}${r.delta_pct != null ? `, ${r.delta_pct}%` : ''})`;
  return {
    yesterday,
    counts: by,
    flags7d: flags7d.map(fmt),
    accountFlags: accountFlags.slice(0, 20).map(fmt),
    accountFlagCount: accountFlags.length,
    brandFlagCount: brandFlags.length,
    sbCoverageTo: rows.filter(r => r.sellerboard_value != null).map(r => r.date).sort().pop() || null,
  };
}

/**
 * Entry point. Reads both sides for the trailing `days` window ending
 * yesterday (PST), writes metric_reconciliation, returns a summary.
 */
async function reconcileSellerboard({ supabase, loadBrands, days = 30, fetchAll = defaultFetchAll, label = 'Reconcile:SB' }) {
  const yesterday = pstSubtractDays(pstDateStr(), 1);
  const from = pstSubtractDays(yesterday, days - 1);

  const asinBrand = {};
  const { brands } = await loadBrands();
  for (const b of brands || []) for (const a of (b.asins || [])) asinBrand[a] = b.id;

  const [sbRows, mpRows, feeAsinRows, feeMpRows] = await Promise.all([
    fetchAll(supabase, 'sellerboard_daily', 'date,mp_id,asin,units,sales,ad_spend_sp,refunds,refund_amount,order_fees,sessions', from, yesterday, ['date', 'mp_id', 'sku']),
    fetchAll(supabase, 'daily_metrics_mp', 'date,mp_id,asin,units,revenue,ad_spend,sessions', from, yesterday, ['date', 'asin', 'mp_id']),
    fetchAll(supabase, 'daily_fees_asin', 'date,mp_id,asin,fees,refund_amount,refund_count', from, yesterday, ['date', 'asin', 'mp_id']),
    fetchAll(supabase, 'daily_fees_mp', 'date,mp_id,fees,refund_amount,refund_count', from, yesterday, ['date', 'mp_id']),
  ]);

  if (!sbRows.length) {
    console.warn(`[${label}] no sellerboard_daily rows in ${from}..${yesterday} — nothing to reconcile (feed not ingested yet?)`);
    return { ok: false, reason: 'no_sellerboard_rows', from, yesterday };
  }

  const { rows, asinFrom } = reconcileRows({ sbRows, mpRows, feeAsinRows, feeMpRows, asinBrand, yesterday, days });
  const checkedAt = new Date().toISOString();

  // ASIN scope: clear the window first so resolved flags disappear.
  {
    const { error } = await supabase.from('metric_reconciliation').delete().eq('scope', 'asin').gte('date', asinFrom).lte('date', yesterday);
    if (error) console.warn(`[${label}] asin-scope clear failed: ${error.message}`);
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({ ...r, checked_at: checkedAt }));
    const { error } = await supabase.from('metric_reconciliation').upsert(batch, { onConflict: 'date,mp_id,scope,scope_id,metric' });
    if (error) { console.error(`[${label}] upsert failed at ${i}: ${error.message}`); break; }
    written += batch.length;
  }

  const summary = summarize(rows, yesterday);
  console.log(`[${label}] ${written} rows written (${from}..${yesterday}); 7d flags: ${summary.flags7d.length}, daily account flags: ${summary.accountFlagCount}, brand flags: ${summary.brandFlagCount}`);
  return { ok: true, from, yesterday, written, ...summary };
}

module.exports = { reconcileSellerboard, reconcileRows, compare, tolerance, summarize, METRICS, LAGGED_METRICS, TOL, ASIN_DAYS };
