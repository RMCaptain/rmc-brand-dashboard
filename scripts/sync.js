/**
 * Local sync script — run from your machine, saves results to Supabase.
 * Usage: node scripts/sync.js
 *
 * Requires .env with SP-API + Supabase credentials.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');
const { syncBrandMetrics } = require('../sync/amazon');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function loadBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('data')
    .eq('id', 'main')
    .single();
  if (error || !data?.data?.brands) throw new Error('Failed to load brands: ' + error?.message);
  return data.data;
}

async function saveBrands(payload) {
  const { error } = await supabase
    .from('brands')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (error) throw new Error('Failed to save brands: ' + error.message);
}

async function savePresetMetrics(payload) {
  const { error } = await supabase
    .from('preset_metrics')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (error) throw new Error('Failed to save preset metrics: ' + error.message);
}

async function main() {
  console.log('=== RMC Local Sync ===');
  console.log('Started:', new Date().toLocaleString());

  if (!process.env.SP_API_CLIENT_ID || !process.env.SP_API_REFRESH_TOKEN) {
    console.error('ERROR: SP-API credentials missing from .env');
    process.exit(1);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error('ERROR: Supabase credentials missing from .env');
    process.exit(1);
  }

  const data = await loadBrands();
  console.log(`Loaded ${data.brands.length} brands from Supabase`);

  const { presets, updatedBrands } = await syncBrandMetrics(data.brands);

  data.brands = updatedBrands;
  await saveBrands(data);

  const lastSync = new Date().toISOString();
  await savePresetMetrics({ lastSync, presets });

  console.log('=== Sync Complete ===');
  console.log('Finished:', new Date().toLocaleString());
  console.log('Presets saved:', Object.keys(presets).join(', '));

  const totalRevCad = Object.values(presets.thisMonth?.brands || {})
    .reduce((s, b) => s + (b.summary?.revenueCad || 0), 0);
  const totalRevUsd = Object.values(presets.thisMonth?.brands || {})
    .reduce((s, b) => s + (b.summary?.revenueUsd || 0), 0);
  const totalUnits = Object.values(presets.thisMonth?.brands || {})
    .reduce((s, b) => s + (b.summary?.units || 0), 0);

  console.log('\nThis Month summary:');
  console.log(`  Revenue CAD: $${totalRevCad.toFixed(2)}`);
  console.log(`  Revenue USD: $${totalRevUsd.toFixed(2)}`);
  console.log(`  Units: ${totalUnits}`);
}

main().catch(err => {
  console.error('SYNC FAILED:', err.message);
  process.exit(1);
});
