// One-time script: clear scientific-notation UPCs from Supabase so the next scrape re-pulls clean values.
// Run: node scripts/clear-bad-upcs.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const { data: row, error } = await supabase.from('brands').select('data').single();
  if (error) { console.error('Load failed:', error.message); process.exit(1); }

  const payload = row.data;
  const brands = payload.brands || [];

  let cleared = 0;
  for (const brand of brands) {
    if (!brand.upcs) continue;
    for (const [asin, upc] of Object.entries(brand.upcs)) {
      if (/e\+/i.test(String(upc))) {
        console.log(`  ${brand.name} / ${asin}: "${upc}" → cleared`);
        delete brand.upcs[asin];
        cleared++;
      }
    }
  }

  if (cleared === 0) {
    console.log('No corrupted UPCs found. Nothing to do.');
    return;
  }

  console.log(`\nClearing ${cleared} corrupted UPC(s)…`);
  const { error: saveErr } = await supabase
    .from('brands')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .not('id', 'is', null);

  if (saveErr) { console.error('Save failed:', saveErr.message); process.exit(1); }
  console.log(`Done. Run a UPC scrape from the Products page to repopulate.`);
}

run();
