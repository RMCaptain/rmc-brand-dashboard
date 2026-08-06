// One-time cleanup for the unknown-brand attribution leak (2026-08-06).
//
// Attribution is stamped at sync time, so ASINs that sold before being added
// to a brand's list left their history under brand_id 'unknown-brand' forever
// (Big League Chew ~$12.5k, Trimax ~$1.8k, Kidstar ~$1.6k, ...). Going forward
// the remap routes move history automatically (reattributeUnknownHistory in
// server.js); this script fixes what already leaked:
//
//   1. daily_metrics + daily_metrics_mp rows under 'unknown-brand' whose ASIN
//      is now claimed by a real brand -> reattributed to that brand.
//   2. Unclaimed ASINs with activity -> appended to the Unknown Brand list in
//      the brands doc so the Products page finally shows them ("needs
//      remapping"). Titles fill in on the next sync.
//
// Idempotent: re-running finds nothing left to move. Run:
//   node scripts/reattribute-unknown-brand.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function sweepUnknownRows() {
  const rows = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await supabase.from('daily_metrics')
      .select('date,asin,units,revenue_cad,revenue_usd')
      .eq('brand_id', 'unknown-brand')
      .order('date', { ascending: true }).order('asin', { ascending: true })
      .range(start, start + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

(async () => {
  const { data: doc, error: docErr } = await supabase.from('brands').select('data').eq('id', 'main').single();
  if (docErr) throw docErr;
  const brands = doc.data.brands || [];
  const owner = {};
  for (const b of brands) {
    if (b.id === 'unknown-brand') continue;
    for (const a of (b.asins || [])) owner[a] = b.id;
  }

  const rows = await sweepUnknownRows();
  const byAsin = {};
  for (const r of rows) {
    const a = byAsin[r.asin] || (byAsin[r.asin] = { rows: 0, units: 0, rev: 0 });
    a.rows++; a.units += r.units || 0; a.rev += (r.revenue_cad || 0) + (r.revenue_usd || 0);
  }

  // 1. Reattribute claimed ASINs' history
  let totalMoved = 0;
  for (const [asin, agg] of Object.entries(byAsin)) {
    const to = owner[asin];
    if (!to) continue;
    for (const table of ['daily_metrics', 'daily_metrics_mp']) {
      const { data, error } = await supabase.from(table)
        .update({ brand_id: to })
        .eq('asin', asin).eq('brand_id', 'unknown-brand')
        .select('date');
      if (error) { console.error(`FAILED ${table} ${asin}:`, error.message); continue; }
      totalMoved += (data || []).length;
    }
    console.log(`moved ${asin} -> ${to}  (${agg.rows} day-rows, ${agg.units}u, $${agg.rev.toFixed(2)})`);
  }

  // 2. Seed unclaimed-but-active ASINs into the Unknown Brand list
  let unknown = brands.find(b => b.id === 'unknown-brand');
  if (!unknown) {
    unknown = { id: 'unknown-brand', name: 'Unknown Brand', marketplace: 'CA', color: '#f59e0b',
                asins: [], asinTitles: {}, createdAt: new Date().toISOString().split('T')[0] };
    brands.push(unknown);
  }
  const seeded = [];
  for (const [asin, agg] of Object.entries(byAsin)) {
    if (owner[asin]) continue;
    if (!(agg.units || agg.rev)) continue;
    if (!unknown.asins.includes(asin)) { unknown.asins.push(asin); seeded.push(asin); }
  }
  if (seeded.length) {
    const { error } = await supabase.from('brands')
      .update({ data: doc.data, updated_at: new Date().toISOString() }).eq('id', 'main');
    if (error) throw error;
  }

  // Verify against the database, never assume success
  const left = await sweepUnknownRows();
  const claimedLeft = left.filter(r => owner[r.asin]);
  console.log(`\nmoved ${totalMoved} row(s) across both tables`);
  console.log(`seeded into Unknown Brand card: ${seeded.length ? seeded.join(', ') : 'none (already listed)'}`);
  console.log(`VERIFY: unknown-brand rows for claimed ASINs remaining: ${claimedLeft.length} (must be 0)`);
  const stillRev = {};
  for (const r of left) { if ((r.revenue_cad || 0) + (r.revenue_usd || 0) > 0) stillRev[r.asin] = true; }
  console.log(`VERIFY: unclaimed ASINs still holding revenue (await Mike's remap): ${Object.keys(stillRev).join(', ') || 'none'}`);
})().catch(e => { console.error(e); process.exit(1); });
