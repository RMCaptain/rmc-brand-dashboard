require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  const { data: row, error } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (error || !row?.data?.brands) { console.error('Load failed:', error); process.exit(1); }

  const brands = row.data.brands;

  if (brands.find(b => b.id === 'general-wholesale')) {
    console.log('General Wholesale already exists.');
    return;
  }

  brands.push({
    id: 'general-wholesale',
    name: 'General Wholesale',
    marketplace: 'CA',
    color: '#6b7280',
    asins: [],
    cogs: {}, leadTimes: {}, upcs: {}, casePacks: {}, asinConfig: {}, asinTitles: {},
    createdAt: new Date().toISOString().split('T')[0]
  });

  const { error: saveError } = await supabase
    .from('brands')
    .update({ data: { brands }, updated_at: new Date().toISOString() })
    .eq('id', 'main');

  if (saveError) { console.error('Save failed:', saveError); process.exit(1); }
  console.log('General Wholesale brand created.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
