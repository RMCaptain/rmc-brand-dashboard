#!/usr/bin/env node
/**
 * One-off recovery: delete zero-filled phantom rows from daily_metrics for
 * dates corrupted by premature syncs, then backfill them with real S&T data.
 *
 * Usage: node scripts/recover-corrupted-dates.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { backfillDays, findMissingDates } = require('../sync/backfill');

const CORRUPTED_DATES = [
  // June 1 and 2 were already deleted in a prior pass; only need May 21 deleted here.
  '2026-05-21',  // 75 rows, 0 CA revenue — partial data (US-only report succeeded)
];

// Dates to force-backfill regardless of findMissingDates result.
const FORCE_BACKFILL = ['2026-06-01', '2026-05-21'];
// (June 2 deferred — S&T won't have data until ~24h after day end)

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error: bErr } = await supabase
    .from('brands').select('data').eq('id', 'main').single();
  if (bErr) { console.error('Failed to load brands:', bErr.message); process.exit(1); }
  const brands = data?.data?.brands || [];

  console.log(`Deleting all rows for ${CORRUPTED_DATES.length} corrupted dates...`);
  for (const date of CORRUPTED_DATES) {
    const { error: delErr, count } = await supabase
      .from('daily_metrics')
      .delete({ count: 'exact' })
      .eq('date', date);
    if (delErr) console.warn(`  ${date}: delete failed —`, delErr.message);
    else console.log(`  ${date}: deleted ${count ?? '?'} rows`);
  }

  console.log('\nNow running backfill to re-fetch with current S&T data...');
  console.log('Targeting force-backfill dates:', FORCE_BACKFILL.join(', '));

  // Look back 14 days so May 21 is in scope. Backfill will pick up any zero-flagged
  // or fully-missing dates within that window (now includes our FORCE_BACKFILL dates).
  const LOOKBACK = 14;

  let pass = 1;
  let consecutiveEmpty = 0;
  while (pass <= 12) {
    const missing = await findMissingDates(supabase, LOOKBACK);
    const stillNeeded = FORCE_BACKFILL.filter(d => missing.includes(d));
    console.log(`\nPass ${pass}: missing in window = [${missing.join(', ')}]`);
    console.log(`  force-backfill remaining: [${stillNeeded.join(', ') || 'none'}]`);
    if (stillNeeded.length === 0) { console.log('✓ All force-backfill dates re-fetched.'); break; }

    const result = await backfillDays(supabase, brands, 3, LOOKBACK);
    console.log(`Filled ${result.filled}. Remaining: ${result.remaining}.`);
    if (result.dates?.length) console.log('Dates:', result.dates.join(', '));

    if (result.filled === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) { console.log('⚠ 3 empty passes — stopping (likely S&T not ready or quota).'); break; }
    } else {
      consecutiveEmpty = 0;
    }

    console.log('Sleeping 6 min to let report quota restore...');
    await new Promise(r => setTimeout(r, 6 * 60 * 1000));
    pass++;
  }
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
