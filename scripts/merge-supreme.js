/**
 * One-time fix: merge duplicate Supreme Petfoods brands and
 * normalize Supremepetfoods / Supreme Experts In Small Pets
 * into a single canonical "Supreme Petfoods" entry.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const MERGE_INTO = 'supreme-petfoods'; // canonical id
const ABSORB_IDS = ['supremepetfoods', 'supreme-experts-in-small-pets'];

async function main() {
  const { data: row, error } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (error || !row?.data?.brands) { console.error('Load failed:', error); process.exit(1); }

  let brands = row.data.brands;

  // Find all Supreme Petfoods variants (by id or name match)
  const isSupreme = b =>
    b.id === MERGE_INTO ||
    ABSORB_IDS.includes(b.id) ||
    (b.name || '').toLowerCase().replace(/[^a-z]/g, '') === 'supremepetfoods';

  const supremes = brands.filter(isSupreme);
  const rest = brands.filter(b => !isSupreme(b));

  if (supremes.length === 0) { console.log('No Supreme Petfoods brands found.'); return; }

  console.log(`Merging ${supremes.length} Supreme Petfoods variants:`);
  supremes.forEach(b => console.log(`  "${b.name}" (${b.id}) — ${b.asins?.length || 0} ASINs`));

  // Use the canonical brand as base, fall back to first found
  const canonical = supremes.find(b => b.id === MERGE_INTO) || supremes[0];

  const merged = { ...canonical };
  merged.name = 'Supreme Petfoods';
  merged.id = MERGE_INTO;
  merged.asins = [];
  merged.cogs = { ...canonical.cogs };
  merged.leadTimes = { ...canonical.leadTimes };
  merged.upcs = { ...canonical.upcs };
  merged.casePacks = { ...canonical.casePacks };
  merged.asinConfig = { ...canonical.asinConfig };
  merged.asinTitles = { ...canonical.asinTitles };

  for (const b of supremes) {
    for (const asin of (b.asins || [])) {
      if (!merged.asins.includes(asin)) merged.asins.push(asin);
      if (b.cogs?.[asin] != null)      merged.cogs[asin]       = b.cogs[asin];
      if (b.leadTimes?.[asin] != null)  merged.leadTimes[asin]  = b.leadTimes[asin];
      if (b.upcs?.[asin])              merged.upcs[asin]        = b.upcs[asin];
      if (b.casePacks?.[asin] != null)  merged.casePacks[asin]  = b.casePacks[asin];
      if (b.asinConfig?.[asin])        merged.asinConfig[asin]  = b.asinConfig[asin];
      if (b.asinTitles?.[asin])        merged.asinTitles[asin]  = b.asinTitles[asin];
    }
  }

  console.log(`\nMerged result: "${merged.name}" — ${merged.asins.length} ASINs`);

  const newBrands = [...rest, merged];

  const { error: saveError } = await supabase
    .from('brands')
    .update({ data: { brands: newBrands }, updated_at: new Date().toISOString() })
    .eq('id', 'main');

  if (saveError) { console.error('Save failed:', saveError); process.exit(1); }
  console.log('Saved.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
