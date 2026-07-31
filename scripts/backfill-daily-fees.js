#!/usr/bin/env node
/**
 * Backfill daily_fees from the Finances API, one PST posted-day at a time.
 * Newest-first so the ranges people actually look at correct soonest.
 * Idempotent — a failed day is skipped (kept for a later pass), never zeroed.
 *
 * Usage:
 *   node scripts/backfill-daily-fees.js                 # 2026-01-01 -> yesterday
 *   node scripts/backfill-daily-fees.js 2025-07-13      # custom start
 *   node scripts/backfill-daily-fees.js 2026-01-01 2026-03-31
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { syncDailyFees } = require('../sync/dailyFees');
const { pstDateStr, pstSubtractDays } = require('../sync/dateUtils');

const START = process.argv[2] || '2026-01-01';
const END   = process.argv[3] || pstSubtractDays(pstDateStr(), 1);

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  const dates = [];
  let d = END;
  while (d >= START) { dates.push(d); d = pstSubtractDays(d, 1); }  // newest first
  console.log(`Backfilling daily_fees for ${dates.length} days: ${END} -> ${START}`);

  const t0 = Date.now();
  const { done, failed } = await syncDailyFees(supabase, dates, { label: 'FeesBackfill' });
  console.log(`\nDone in ${((Date.now() - t0) / 60000).toFixed(1)} min — ${done} days written, ${failed} failed.`);
  if (failed > 0) console.log('Re-run the same command to retry failed days (idempotent).');
  process.exit(0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
