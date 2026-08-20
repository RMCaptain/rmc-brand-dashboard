#!/usr/bin/env node
/**
 * Backfill per-ASIN fees (daily_fees_asin) by re-collecting daily fees over a
 * trailing window. Reuses syncDailyFees, so the wide daily_fees + mp rows are
 * refreshed too (idempotent upserts — a re-collect is always a refresh).
 *
 *   node scripts/backfill-fees-asin.js [days] [--only-missing]   # default 90
 *
 * --only-missing skips dates that already have daily_fees_asin rows — use for
 * extending history backward without re-walking days already collected.
 *
 * Finances API is slow (~0.5 rps + pagination): expect a few hours for 90
 * days. Safe to interrupt and re-run — each completed day is durable.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { syncDailyFees, trailingDates } = require('../sync/dailyFees');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const args = process.argv.slice(2);
const onlyMissing = args.includes('--only-missing');
const days = Math.max(1, parseInt(args.find(a => /^\d+$/.test(a)) || '90', 10));

(async () => {
  let dates = trailingDates(days); // newest-first: recent dashboards fill first
  if (onlyMissing) {
    const have = new Set();
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from('daily_fees_asin').select('date').range(off, off + 999);
      if (error) throw new Error(error.message);
      for (const r of (data || [])) have.add(r.date);
      if (!data || data.length < 1000) break;
    }
    const before = dates.length;
    dates = dates.filter(d => !have.has(d));
    console.log(`[BackfillFeesAsin] --only-missing: ${before - dates.length} days already collected, ${dates.length} to do`);
  }
  if (!dates.length) { console.log('[BackfillFeesAsin] Nothing to do.'); process.exit(0); }
  console.log(`[BackfillFeesAsin] ${dates.length} days: ${dates[0]} back to ${dates[dates.length - 1]}`);
  const { done, failed } = await syncDailyFees(supabase, dates, { label: 'BackfillFeesAsin' });
  console.log(`[BackfillFeesAsin] complete: ${done} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('[BackfillFeesAsin] FATAL:', e.message); process.exit(1); });
