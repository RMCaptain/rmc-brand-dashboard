// Backfill ad spend + engagement (clicks/impressions/orders, both attribution
// windows) for a date range, plus SB/SD campaign rollups into daily_brand_ads.
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
// report ranges at 31 days, so wider ranges are chunked automatically. SB/SD
// retention (~60d) is shorter than SP's (~95d); chunks before it are skipped
// for SB/SD automatically while SP still backfills.
const path=require('path');require('dotenv').config({path:path.join(__dirname,'..','.env')});
const {createClient}=require('@supabase/supabase-js');
const { pullAdSpendDaily, pullBrandAdsDaily } = require('../sync/ads');
const metricsMp = require('../sync/metricsMp');
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_KEY);
const { pstSubtractDays } = require('../sync/dateUtils');

const CHUNK=31;
function chunks(from,to){const out=[];let s=from;while(s<=to){let e=pstSubtractDays(s,-(CHUNK-1));if(e>to)e=to;out.push([s,e]);s=pstSubtractDays(e,-1);}return out;}

(async()=>{
  const FROM=process.argv[2], TO=process.argv[3];
  const {data:b}=await sb.from('brands').select('data').eq('id','main').single();
  const asinBrand={};
  for(const br of b.data.brands) for(const a of (br.asins||[])) asinBrand[a]=br.id;

  const failed=[];
  for(const [cf,ct] of chunks(FROM,TO)){
    const t0=Date.now();
    console.log(`\n[chunk] ${cf} → ${ct}  pulling...`);
    let merged;
    try { merged = await pullAdSpendDaily(cf,ct); }
    catch(e){ console.log('  FAILED:', e.message.slice(0,200)); failed.push([cf,ct,e.message.slice(0,120)]); continue; }
    const mins=((Date.now()-t0)/60000).toFixed(1);
    let wrote=0;
    for(const [date,asins] of Object.entries(merged)){
      const rows=Object.entries(asins).map(([asin,d])=>({
        asin,date,brand_id:asinBrand[asin]||'unknown-brand',
        spend_cad:Math.round((d.spendCad||0)*100)/100,
        spend_usd:Math.round((d.spendUsd||0)*100)/100,
        attributed_sales_cad:Math.round((d.salesCad||0)*100)/100,
        attributed_sales_usd:Math.round((d.salesUsd||0)*100)/100,
        attributed_sales_7d_cad:Math.round((d.sales7Cad||0)*100)/100,
        attributed_sales_7d_usd:Math.round((d.sales7Usd||0)*100)/100,
        ad_clicks:d.clicks||0, ad_impressions:d.impressions||0,
        ad_orders:d.orders||0, ad_orders_7d:d.orders7||0,
      })).filter(r=>r.spend_cad>0||r.spend_usd>0||r.ad_clicks>0||r.ad_impressions>0||r.ad_orders>0);
      if(!rows.length) continue;
      const {error}=await sb.from('daily_metrics').upsert(rows,{onConflict:'asin,date'});
      if(error) console.log('  upsert error',date,error.message);
      else {
        wrote+=rows.length;
        // Keep the narrow mirror in step — restated values otherwise trip the
        // nightly mirror-drift integrity check.
        await metricsMp.replaceDay(sb, date, 'ads', metricsMp.adsRows(date, asins, asinBrand), `ads backfill ${date}`);
      }
    }
    console.log(`  done in ${mins}m — ${Object.keys(merged).length} dates, wrote ${wrote} rows`);

    // SB/SD for the same chunk (auto-clamped to their shorter retention)
    try {
      const brandAds = await pullBrandAdsDaily(cf, ct);
      let baRows = 0;
      for (const [date, byBrand] of Object.entries(brandAds)) {
        const rows = [];
        for (const [brand_id, kinds] of Object.entries(byBrand)) {
          for (const [ad_product, e] of Object.entries(kinds)) {
            rows.push({
              date, brand_id, ad_product,
              spend_cad: Math.round(e.spendCad*100)/100, spend_usd: Math.round(e.spendUsd*100)/100,
              sales_cad: Math.round(e.salesCad*100)/100, sales_usd: Math.round(e.salesUsd*100)/100,
              clicks: e.clicks, impressions: e.impressions, orders: e.orders,
            });
          }
        }
        const {error:delErr}=await sb.from('daily_brand_ads').delete().eq('date',date);
        if(delErr){ console.log('  brand-ads clear error',date,delErr.message); continue; }
        if(rows.length){
          const {error:insErr}=await sb.from('daily_brand_ads').insert(rows);
          if(insErr) console.log('  brand-ads insert error',date,insErr.message); else baRows+=rows.length;
        }
      }
      if (baRows) console.log(`  SB/SD: wrote ${baRows} (date,brand,product) rows`);
    } catch(e){ console.log('  SB/SD pull failed (SP chunk still written):', e.message.slice(0,200)); }
  }
  // Never claim success when a chunk failed. The whole reason this script
  // exists is that the endpoint reported success while writing nothing —
  // printing "COMPLETE" over a failed chunk repeats exactly that mistake.
  if (failed.length) {
    console.log(`\nBACKFILL INCOMPLETE — ${failed.length} chunk(s) failed:`);
    for (const [cf,ct,msg] of failed) console.log(`  ${cf} → ${ct}: ${msg}`);
    console.log('Re-run the same command to retry; completed chunks are already written and Amazon reuses baked reports.');
    process.exit(1);
  }
  console.log('\nBACKFILL COMPLETE — all chunks written');
})().catch(e=>{ console.error('Fatal:', e.message); process.exit(1); });
