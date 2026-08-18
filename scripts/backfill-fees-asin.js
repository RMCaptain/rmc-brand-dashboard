#!/usr/bin/env node
/**
 * Backfill per-ASIN fees (daily_fees_asin) by re-collecting daily fees over a
 * trailing window. Reuses syncDailyFees, so the wide daily_fees + mp rows are
 * refreshed too (idempotent upserts — a re-collect is always a refresh).
 *
 *   node scripts/backfill-fees-asin.js [days]   # default 90
 *
 * Finances API is slow (~0.5 rps + pagination): expect a few hours for 90
 * days. Safe to interrupt and re-run — each completed day is durable.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const { syncDailyFees, trailingDates } = require('../sync/dailyFees');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const days = Math.max(1, parseInt(process.argv[2] || '90', 10));

(async () => {
  const dates = trailingDates(days); // newest-first: recent dashboards fill first
  console.log(`[BackfillFeesAsin] ${dates.length} days: ${dates[0]} back to ${dates[dates.length - 1]}`);
  const { done, failed } = await syncDailyFees(supabase, dates, { label: 'BackfillFeesAsin' });
  console.log(`[BackfillFeesAsin] complete: ${done} ok, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('[BackfillFeesAsin] FATAL:', e.message); process.exit(1); });
