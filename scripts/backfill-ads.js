// Backfill ad spend + engagement (clicks/impressions/orders) for a date range.
//
//   node scripts/backfill-ads.js 2026-05-01 2026-07-14
//
// Prefer this over POST /api/ads/sync-daily for any backfill. That endpoint is
// fire-and-forget and cannot report success: Amazon takes 12-15 minutes to bake
// each report, so Render's proxy always closes the connection first. This script
// prints per-chunk progress and row counts, so a failure is visible instead of
// silent — which is how the original 90-day backfills went unnoticed for 2 weeks.
//
// Writes to whatever SUPABASE_URL points at — which is PRODUCTION. Amazon caps
// report ranges at 31 days, so wider ranges are chunked automatically.
const path=require('path');require('dotenv').config({path:path.join(__dirname,'..','.env')});
const {createClient}=require('@supabase/supabase-js');
const { pullAdSpendDaily } = require('../sync/ads');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
const { pstSubtractDays } = require('../sync/dateUtils');

const CHUNK=31;
function chunks(from,to){const out=[];let s=from;while(s<=to){let e=pstSubtractDays(s,-(CHUNK-1));if(e>to)e=to;out.push([s,e]);s=pstSubtractDays(e,-1);}return out;}

(async()=>{
  const FROM=process.argv[2], TO=process.argv[3];
  const {data:b}=await sb.from('brands').select('data').eq('id','main').single();
  const asinBrand={};
  for(const br of b.data.brands) for(const a of (br.asins||[])) asinBrand[a]=br.id;

  for(const [cf,ct] of chunks(FROM,TO)){
    const t0=Date.now();
    console.log(`\n[chunk] ${cf} → ${ct}  pulling...`);
    let merged;
    try { merged = await pullAdSpendDaily(cf,ct); }
    catch(e){ console.log('  FAILED:', e.message.slice(0,200)); continue; }
    const mins=((Date.now()-t0)/60000).toFixed(1);
    let wrote=0;
    for(const [date,asins] of Object.entries(merged)){
      const rows=Object.entries(asins).map(([asin,d])=>({
        asin,date,brand_id:asinBrand[asin]||'unknown-brand',
        spend_cad:Math.round((d.spendCad||0)*100)/100,
        spend_usd:Math.round((d.spendUsd||0)*100)/100,
        attributed_sales_cad:Math.round((d.salesCad||0)*100)/100,
        attributed_sales_usd:Math.round((d.salesUsd||0)*100)/100,
        ad_clicks:d.clicks||0, ad_impressions:d.impressions||0, ad_orders:d.orders||0,
      })).filter(r=>r.spend_cad>0||r.spend_usd>0||r.ad_clicks>0||r.ad_impressions>0||r.ad_orders>0);
      if(!rows.length) continue;
      const {error}=await sb.from('daily_metrics').upsert(rows,{onConflict:'asin,date'});
      if(error) console.log('  upsert error',date,error.message); else wrote+=rows.length;
    }
    console.log(`  done in ${mins}m — ${Object.keys(merged).length} dates, wrote ${wrote} rows`);
  }
  console.log('\nBACKFILL COMPLETE');
})();
