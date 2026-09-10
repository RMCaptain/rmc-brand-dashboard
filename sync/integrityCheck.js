// Nightly data-integrity checks — internal invariants only, no external
// reference needed. Each check returns findings; the cron in server.js posts
// a Slack alert when any 'fail' exists (warns ride along Mondays only, so a
// known-but-unchanged gap like missing COGS doesn't spam daily).
//
// Checks:
//   freshness   — yesterday has revenue rows (a $0 day = sync failure, we sell daily)
//   fees        — daily_fees has no gaps since FEES_EPOCH and covers yesterday
//   mp_mirror   — daily_metrics (wide) and daily_metrics_mp (long) agree on
//                 units/revenue/ad spend/refunds by currency over the last 30 full days
//   sanity      — no negative units/revenue/spend in the last 30 days
//   unknown     — revenue attributed to unknown-brand in the last 30 days.
//                 Fail, not warn: it's sales no brand report will ever show
//                 (how $9.8k of Zellies revenue went missing, 2026-08-06).
//                 Self-clearing — remapping the ASIN in Products moves its
//                 history, so the alert stops the day it's dealt with.
//   fees_asin   — per-ASIN fee rows (daily_fees_asin) sum to the wide daily_fees
//                 totals per day/currency over the last 7 days; warns on fee
//                 dollars stuck on unmapped SKUs
//   cogs        — % of last-30d revenue from ASINs with COGS, per brand (warn < 95%)

const { pstDateStr, pstSubtractDays } = require('./dateUtils');

const FEES_EPOCH = '2026-01-01'; // daily_fees backfill start — nothing before it
const MONEY_TOL = 0.5;           // dollars; both sides round to cents at write
const COGS_WARN_PCT = 95;

// tiebreak: second ordering key for tables with many rows per date. Ordering
// by date alone leaves same-date rows in unspecified order — page boundaries
// then duplicate/skip rows ("shredding"), producing phantom mp_mirror
// mismatches or masking real drift. Pass null for one-row-per-date tables.
async function fetchAll(supabase, table, columns, from, to, tiebreak = 'asin') {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    let q = supabase.from(table).select(columns).order('date', { ascending: true });
    for (const key of (Array.isArray(tiebreak) ? tiebreak : tiebreak ? [tiebreak] : [])) {
      q = q.order(key, { ascending: true });
    }
    q = q.range(start, start + 999);
    if (from) q = q.gte('date', from);
    if (to)   q = q.lte('date', to);
    const { data, error } = await q;
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

const num = v => (Number.isFinite(v) ? v : (Number.isFinite(Number(v)) ? Number(v) : 0));
const r2  = v => Math.round(v * 100) / 100;

async function runIntegrityChecks({ supabase, loadBrands }) {
  const findings = [];   // { check, level: 'fail'|'warn', detail }
  const yesterday = pstSubtractDays(pstDateStr(), 1);
  const from30 = pstSubtractDays(yesterday, 29);

  const wide = await fetchAll(supabase, 'daily_metrics',
    'date,asin,brand_id,units,units_ca,units_us,revenue_cad,revenue_usd,spend_cad,spend_usd,refund_amount_cad,refund_amount_usd,attributed_sales_cad,attributed_sales_usd,sessions',
    from30, yesterday);

  // freshness — yesterday must have real revenue
  const yRev = wide.filter(r => r.date === yesterday)
    .reduce((s, r) => s + num(r.revenue_cad) + num(r.revenue_usd), 0);
  if (yRev <= 0) {
    findings.push({ check: 'freshness', level: 'fail', detail: `No revenue recorded for ${yesterday} — finalize/sync likely failed.` });
  }

  // fees — gaps + freshness
  const feeRows = await fetchAll(supabase, 'daily_fees', 'date', FEES_EPOCH, yesterday, null); // one row/date — no tiebreak column
  const feeDates = new Set(feeRows.map(r => r.date));
  const gaps = [];
  for (let d = FEES_EPOCH; d <= yesterday; d = pstSubtractDays(d, -1)) {
    if (!feeDates.has(d)) gaps.push(d);
  }
  if (gaps.length) {
    const shown = gaps.slice(0, 5).join(', ');
    findings.push({ check: 'fees', level: 'fail', detail: `daily_fees missing ${gaps.length} day(s): ${shown}${gaps.length > 5 ? ', …' : ''}` });
  }

  // mp_mirror — wide vs long sums by currency over the 30-day window
  const mp = await fetchAll(supabase, 'daily_metrics_mp',
    'date,mp_id,currency,units,revenue,ad_spend,ad_attributed_sales,refund_amount,sessions', from30, yesterday, ['asin', 'mp_id']);
  const wideSum = { CAD: { units: 0, revenue: 0, ad_spend: 0, ad_attributed_sales: 0, refund_amount: 0 },
                    USD: { units: 0, revenue: 0, ad_spend: 0, ad_attributed_sales: 0, refund_amount: 0 } };
  for (const r of wide) {
    wideSum.CAD.units += num(r.units_ca);           wideSum.USD.units += num(r.units_us);
    wideSum.CAD.revenue += num(r.revenue_cad);      wideSum.USD.revenue += num(r.revenue_usd);
    wideSum.CAD.ad_spend += num(r.spend_cad);       wideSum.USD.ad_spend += num(r.spend_usd);
    wideSum.CAD.ad_attributed_sales += num(r.attributed_sales_cad); wideSum.USD.ad_attributed_sales += num(r.attributed_sales_usd);
    wideSum.CAD.refund_amount += num(r.refund_amount_cad); wideSum.USD.refund_amount += num(r.refund_amount_usd);
  }
  const mpSum = { CAD: { units: 0, revenue: 0, ad_spend: 0, ad_attributed_sales: 0, refund_amount: 0 },
                  USD: { units: 0, revenue: 0, ad_spend: 0, ad_attributed_sales: 0, refund_amount: 0 } };
  for (const r of mp) {
    const side = mpSum[r.currency];
    if (!side) continue;
    side.units += num(r.units); side.revenue += num(r.revenue);
    side.ad_spend += num(r.ad_spend); side.ad_attributed_sales += num(r.ad_attributed_sales);
    side.refund_amount += num(r.refund_amount);
  }
  for (const cur of ['CAD', 'USD']) {
    for (const metric of ['units', 'revenue', 'ad_spend', 'ad_attributed_sales', 'refund_amount']) {
      const w = wideSum[cur][metric], m = mpSum[cur][metric];
      const tol = metric === 'units' ? 0 : MONEY_TOL;
      if (Math.abs(w - m) > tol) {
        findings.push({ check: 'mp_mirror', level: 'fail',
          detail: `${cur} ${metric} mismatch over last 30d: wide ${r2(w)} vs per-marketplace ${r2(m)} — a sync path isn't double-writing.` });
      }
    }
  }

  // mp_traffic — per-day session sums agree between the wide table and the
  // mp mirror, on days the mirror has traffic (forward-only from 2026-09-10;
  // untracked history is silent, not a finding). Wide sessions only ever
  // cover the wide-table marketplaces (CA/US), so UK/Walmart mp sessions are
  // excluded from the comparison — they have no wide counterpart by design.
  // Warn, not fail, while the writer is new; promote after a clean week.
  {
    const { isWideTableMp } = require('./marketplaces');
    const wideSess = {}, mpSess = {};
    for (const r of wide) wideSess[r.date] = (wideSess[r.date] || 0) + num(r.sessions);
    for (const r of mp) {
      if (r.sessions == null || !isWideTableMp(r.mp_id)) continue;
      mpSess[r.date] = (mpSess[r.date] || 0) + num(r.sessions);
    }
    const bad = Object.entries(mpSess).filter(([d, v]) => Math.abs(v - (wideSess[d] || 0)) > 0);
    if (bad.length) {
      const [d, v] = bad[0];
      findings.push({ check: 'mp_traffic', level: 'warn',
        detail: `${bad.length} day(s) where mp-mirror sessions disagree with the wide table (first: ${d} — mp ${v} vs wide ${wideSess[d] || 0}). Traffic writer drift.` });
    }
  }

  // sanity — negatives indicate a write bug
  const negs = wide.filter(r =>
    num(r.units) < 0 || num(r.revenue_cad) < 0 || num(r.revenue_usd) < 0 ||
    num(r.spend_cad) < 0 || num(r.spend_usd) < 0);
  if (negs.length) {
    findings.push({ check: 'sanity', level: 'fail',
      detail: `${negs.length} row(s) with negative units/revenue/spend in last 30d (first: ${negs[0].asin} on ${negs[0].date}).` });
  }

  // unknown — sales on ASINs no brand claims (attribution stamped at sync time)
  const unknownByAsin = {};
  for (const r of wide) {
    if (r.brand_id !== 'unknown-brand') continue;
    const rev = num(r.revenue_cad) + num(r.revenue_usd);
    const u = num(r.units);
    if (rev <= 0 && u <= 0) continue;
    const acc = unknownByAsin[r.asin] || (unknownByAsin[r.asin] = { rev: 0, units: 0 });
    acc.rev += rev; acc.units += u;
  }
  const unknownAsins = Object.entries(unknownByAsin).sort((a, b) => b[1].rev - a[1].rev);
  if (unknownAsins.length) {
    const totRev = unknownAsins.reduce((s, [, v]) => s + v.rev, 0);
    const totU   = unknownAsins.reduce((s, [, v]) => s + v.units, 0);
    const top = unknownAsins.slice(0, 5).map(([a, v]) => `${a} $${r2(v.rev)}`).join(', ');
    findings.push({ check: 'unknown', level: 'fail',
      detail: `$${r2(totRev)} / ${totU} unit(s) in last 30d on ${unknownAsins.length} unmapped ASIN(s) — no brand report shows this. Remap in Products: ${top}${unknownAsins.length > 5 ? ', …' : ''}` });
  }

  // fees_asin — per-ASIN fee rows must sum to the day's wide daily_fees totals
  // (both are built from the SAME Finances ItemFeeList events; service fees are
  // account-level and live only in the wide row, so they're excluded here).
  // Only days that HAVE asin rows are compared — days the backfill hasn't
  // reached yet aren't failures. Yesterday missing entirely = warn (cron gap).
  const from7 = pstSubtractDays(yesterday, 6);
  const asinFees = await fetchAll(supabase, 'daily_fees_asin', 'date,currency,fees,asin', from7, yesterday);
  if (asinFees.length) {
    const wideFees = await fetchAll(supabase, 'daily_fees', 'date,fees_cad,fees_usd', from7, yesterday, null);
    const wideByDate = Object.fromEntries(wideFees.map(r => [r.date, r]));
    const asinByDate = {};
    for (const r of asinFees) {
      const acc = asinByDate[r.date] || (asinByDate[r.date] = { CAD: 0, USD: 0 });
      if (acc[r.currency] != null) acc[r.currency] += num(r.fees);
    }
    const FEE_TOL = 1.0; // dollars — per-SKU rows round independently of the wide sum
    for (const [date, sums] of Object.entries(asinByDate)) {
      const w = wideByDate[date];
      if (!w) continue;
      for (const [cur, col] of [['CAD', 'fees_cad'], ['USD', 'fees_usd']]) {
        if (Math.abs(sums[cur] - num(w[col])) > FEE_TOL) {
          findings.push({ check: 'fees_asin', level: 'fail',
            detail: `${date} ${cur}: per-ASIN fees sum ${r2(sums[cur])} ≠ daily_fees ${r2(num(w[col]))} — per-product margins are off for that day.` });
        }
      }
    }
    if (!asinByDate[yesterday] && num(wideByDate[yesterday]?.fees_cad) + num(wideByDate[yesterday]?.fees_usd) > 0) {
      findings.push({ check: 'fees_asin', level: 'warn',
        detail: `No per-ASIN fee rows for ${yesterday} though wide fees exist — fees cron may not have written daily_fees_asin.` });
    }
    // Unmapped SKUs carry real fee dollars no product row will show
    const unmapped = asinFees.filter(r => r.asin.startsWith('sku:'));
    const unmappedTotal = unmapped.reduce((s, r) => s + num(r.fees), 0);
    if (unmappedTotal > 5) {
      const skus = [...new Set(unmapped.map(r => r.asin))].slice(0, 5).join(', ');
      findings.push({ check: 'fees_asin', level: 'warn',
        detail: `$${r2(unmappedTotal)} of last-7d fees on unmapped SKUs (${skus}) — add them to sku_prices/brand mapping.` });
    }
  }

  // cogs — revenue-weighted coverage per brand (warn only; posts Mondays)
  const { brands } = await loadBrands();
  const hasCogs = {};
  for (const b of brands || []) {
    const perMp = b.cogsPerMarketplace || {};
    for (const a of (b.asins || [])) {
      const mpVals = perMp[a] || {};
      hasCogs[a] = num(mpVals.CA) > 0 || num(mpVals.US) > 0 || num((b.cogs || {})[a]) > 0;
    }
  }
  const byBrand = {};
  for (const r of wide) {
    const rev = num(r.revenue_cad) + num(r.revenue_usd);
    if (rev <= 0) continue;
    const acc = byBrand[r.brand_id] || (byBrand[r.brand_id] = { total: 0, covered: 0, missing: new Set() });
    acc.total += rev;
    if (hasCogs[r.asin]) acc.covered += rev;
    else acc.missing.add(r.asin);
  }
  const low = Object.entries(byBrand)
    .map(([id, a]) => ({ id, pct: a.total ? Math.round(a.covered / a.total * 100) : 100, missing: a.missing.size, total: a.total }))
    .filter(b => b.pct < COGS_WARN_PCT)
    .sort((a, b) => (a.pct - b.pct) || (b.total - a.total));
  for (const b of low) {
    findings.push({ check: 'cogs', level: 'warn',
      detail: `${b.id}: ${b.pct}% of last-30d revenue has COGS (${b.missing} ASIN(s) missing) — profit overstated for the rest.` });
  }

  // sellerboard — the external reference (sync/reconcileSellerboard.js).
  // fail: a trailing-7d account-level flag on sales/units/ad_spend for any
  //       marketplace — the two sources disagree beyond tolerance in a way
  //       the day-boundary can't explain.
  // warn: feed stale (no Sellerboard rows for the day before yesterday), or
  //       daily account-level flags in the last 3 days (posting-lag noise until
  //       proven otherwise; posts Mondays).
  // Wrapped: the tables only exist once the boot migration has run.
  try {
    const dayBefore = pstSubtractDays(yesterday, 1);
    const recon = await fetchAll(supabase, 'metric_reconciliation',
      'date,mp_id,scope,scope_id,metric,amazon_value,sellerboard_value,delta,delta_pct,status',
      pstSubtractDays(yesterday, 2), yesterday, ['scope', 'scope_id', 'metric']);
    const { codeOf } = require('./marketplaces');
    const fmt = r => `${codeOf(r.mp_id) || r.mp_id} ${r.metric} Amazon ${r.amazon_value} vs Sellerboard ${r.sellerboard_value} (${r.delta > 0 ? '+' : ''}${r.delta}${r.delta_pct != null ? `, ${r.delta_pct}%` : ''})`;
    const hard = recon.filter(r => r.scope === 'account_7d' && r.status === 'flag' && ['sales', 'units', 'ad_spend'].includes(r.metric));
    for (const r of hard) {
      // warn, not fail: reconciliation is reviewed internally (Claude's overnight
      // check), not something the team acts on from Slack (Mike, 2026-09-09).
      findings.push({ check: 'sellerboard', level: 'warn', detail: `7-day ${fmt(r)} — Amazon-side data and Sellerboard disagree beyond tolerance; Sellerboard is shown, Amazon path needs a look.` });
    }
    const soft = recon.filter(r => r.scope === 'account' && r.status === 'flag');
    if (soft.length) {
      const top = soft.slice(0, 3).map(r => `${r.date} ${fmt(r)}`).join('; ');
      findings.push({ check: 'sellerboard', level: 'warn', detail: `${soft.length} daily account-level flag(s) in last 3d (fee/refund posting lag unless the 7-day row also flags): ${top}${soft.length > 3 ? '; …' : ''}` });
    }
    const sbCover = await fetchAll(supabase, 'sellerboard_daily', 'date', dayBefore, dayBefore, ['mp_id', 'sku']);
    if (!sbCover.length) {
      findings.push({ check: 'sellerboard', level: 'warn', detail: `No Sellerboard rows for ${dayBefore} — feed not ingested (link stale, "report not ready" on both crons, or env SELLERBOARD_FEED_* unset).` });
    }
  } catch (e) {
    findings.push({ check: 'sellerboard', level: 'warn', detail: `Sellerboard reconciliation unreadable: ${e.message}` });
  }

  return { findings, checkedAt: new Date().toISOString(), window: `${from30} → ${yesterday}` };
}

function buildSlackText({ findings, window }) {
  const fails = findings.filter(f => f.level === 'fail');
  const warns = findings.filter(f => f.level === 'warn');
  const lines = [
    `RMC DATA INTEGRITY — ${fails.length} failure(s), ${warns.length} warning(s)  (window ${window})`,
    '',
    ...fails.map(f => `• [${f.check}] ${f.detail}`),
    ...warns.map(f => `• [${f.check}] ${f.detail}`),
  ];
  return lines.join('\n');
}

async function postIntegrityAlert(payload) {
  // Own channel when SLACK_INTEGRITY_WEBHOOK_URL is set; falls back to the
  // health-digest webhook (#account-health) so alerts never silently drop.
  const webhook = process.env.SLACK_INTEGRITY_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!webhook) return { posted: false, reason: 'no_webhook' };
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: buildSlackText(payload) }),
  });
  if (!res.ok) return { posted: false, reason: 'webhook_error', status: res.status };
  return { posted: true };
}

module.exports = { runIntegrityChecks, buildSlackText, postIntegrityAlert };
