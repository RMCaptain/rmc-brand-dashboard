#!/usr/bin/env node
/**
 * Backfill daily_metrics from ~May 1 forward. Uses small batches with long sleeps
 * so we don't burst-exceed the GetReports quota (burst 15, restore ~1/min).
 *
 * Each pass: 3 days × 2 marketplaces = 6 createReport calls. ~6 reports per pass
 * lets the quota restore between passes (6 min sleep restores 6 slots).
 *
 * Run: node scripts/backfill-month.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { backfillDays } = require('../sync/backfill');

const LOOKBACK_DAYS  = 35;     // covers May 1 → yesterday
const BATCH_SIZE     = 3;      // days per pass → 6 createReport calls (3 × 2 mp)
const SLEEP_MS       = 6 * 60 * 1000; // 6 min between passes (restores ~6 quota slots)
const INITIAL_SLEEP  = 4 * 60 * 1000; // give quota time to restore from any prior attempts

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const { data, error } = await supabase
    .from('brands').select('data').eq('id', 'main').single();
  if (error) { console.error('Failed to load brands:', error.message); process.exit(1); }

  const brands = data?.data?.brands || [];
  console.log(`Loaded ${brands.length} brands.`);
  console.log(`Strategy: ${BATCH_SIZE} days per pass, ${SLEEP_MS/60000} min between passes.`);
  console.log(`Initial pause: ${INITIAL_SLEEP/60000} min (let quota restore from earlier attempts)...\n`);
  await new Promise(r => setTimeout(r, INITIAL_SLEEP));

  let pass = 1;
  let stuckPasses = 0;
  while (pass <= 20) {
    console.log(`── Pass ${pass} (${new Date().toISOString()}) ──`);
    const result = await backfillDays(supabase, brands, BATCH_SIZE, LOOKBACK_DAYS);
    console.log(`Filled ${result.filled}. Remaining: ${result.remaining}.`);
    if (result.dates?.length) console.log('Dates:', result.dates.join(', '));

    if (result.remaining <= 0) { console.log('\n✓ Backfill complete.'); break; }

    if (result.filled === 0) {
      stuckPasses++;
      if (stuckPasses >= 3) { console.log('\n⚠ 3 passes with no progress — stopping.'); break; }
      console.log(`(No progress this pass — quota likely depleted. Sleeping ${SLEEP_MS/60000} min anyway.)`);
    } else {
      stuckPasses = 0;
    }

    console.log(`Sleeping ${SLEEP_MS/60000} min...\n`);
    await new Promise(r => setTimeout(r, SLEEP_MS));
    pass++;
  }
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
