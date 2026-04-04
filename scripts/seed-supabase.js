/**
 * One-time script: seeds Supabase with data from local JSON files.
 * Run once: node scripts/seed-supabase.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function seed() {
  const DATA_DIR = path.join(__dirname, '../data');

  // Brands
  const brands = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'brands.json'), 'utf8'));
  const { error: e1 } = await supabase
    .from('brands')
    .update({ data: brands, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (e1) { console.error('brands seed failed:', e1.message); process.exit(1); }
  console.log(`brands seeded — ${brands.brands.length} brands`);

  // Preset metrics
  let presetMetrics = { lastSync: null, presets: {} };
  try {
    presetMetrics = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'preset-metrics.json'), 'utf8'));
  } catch { console.log('No preset-metrics.json found — seeding empty'); }

  const { error: e2 } = await supabase
    .from('preset_metrics')
    .update({ data: presetMetrics, updated_at: new Date().toISOString() })
    .eq('id', 'main');
  if (e2) { console.error('preset_metrics seed failed:', e2.message); process.exit(1); }
  console.log('preset_metrics seeded');

  console.log('Done.');
}

seed();
