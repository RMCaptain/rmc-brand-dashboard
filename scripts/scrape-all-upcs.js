// Scrape UPCs for all ASINs missing a UPC entry across all brands.
// Run: node scripts/scrape-all-upcs.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { fetchUpcsForAsins } = require('../sync/amazon');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const { data: row, error } = await supabase.from('brands').select('data').single();
  if (error) { console.error('Load failed:', error.message); process.exit(1); }

  const payload = row.data;
  const brands = (payload.brands || []).filter(b => b.id !== 'unknown-brand');

  // Collect all ASINs missing a UPC entry
  const toScrape = [];
  for (const brand of brands) {
    brand.upcs = brand.upcs || {};
    const missing = (brand.asins || []).filter(a => !(a in brand.upcs));
    if (missing.length > 0) {
      toScrape.push({ brand, asins: missing });
      console.log(`${brand.name}: ${missing.length} ASINs to scrape`);
    }
  }

  const total = toScrape.reduce((s, b) => s + b.asins.length, 0);
  if (total === 0) { console.log('Nothing to scrape.'); return; }
  console.log(`\nTotal: ${total} ASINs across ${toScrape.length} brands\n`);

  let grandFound = 0;
  for (const { brand, asins } of toScrape) {
    process.stdout.write(`Scraping ${brand.name} (${asins.length} ASINs)… `);
    const upcMap = await fetchUpcsForAsins(asins);
    let found = 0;
    for (const asin of asins) {
      const upc = upcMap[asin];
      brand.upcs[asin] = upc || '';
      if (upc) found++;
    }
    grandFound += found;
    console.log(`${found}/${asins.length} found`);
  }

  console.log(`\nSaving… (${grandFound} UPCs found total)`);
  const { error: saveErr } = await supabase
    .from('brands')
    .update({ data: payload, updated_at: new Date().toISOString() })
    .not('id', 'is', null);

  if (saveErr) { console.error('Save failed:', saveErr.message); process.exit(1); }
  console.log('Done.');
}

run();
