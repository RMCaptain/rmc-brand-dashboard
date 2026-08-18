// Read-only migration verifier: probes Supabase for every table/column the
// sql/ migrations create (and confirms dropped columns are gone). Run:
//   node scripts/verify-migrations.js
// Touches nothing — every probe is a SELECT ... LIMIT 1.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Each probe: table + columns to select. `wantMissing: true` means the probe
// SHOULD fail (drop-column migrations).
const PROBES = [
  // PO builder (June)
  { sql: 'po-production-upgrades', table: 'purchase_orders', cols: 'deleted_at,deleted_by,audit_log' },
  { sql: 'po-production-upgrades', table: 'po_drafts', cols: 'key' },
  { sql: 'po-lines-projection', table: 'purchase_order_lines', cols: 'po_id,extended_cost' },
  // Brand report stack
  { sql: 'brand-report-configs', table: 'brand_report_configs', cols: 'brand_id,hidden_sections' },
  { sql: 'brand-report-section-order', table: 'brand_report_configs', cols: 'section_order' },
  { sql: 'brand-report-summaries', table: 'brand_report_summaries', cols: 'brand_id,summary_text,edited' },
  { sql: 'brand-report-archives', table: 'brand_report_archives', cols: 'brand_id,summary_text_snapshot' },
  { sql: 'brand-report-snapshots', table: 'brand_report_archives', cols: 'dataset_snapshot,is_saved_report' },
  // Portal + team auth
  { sql: 'portal-auth', table: 'portal_users', cols: 'brand_id,email' },
  { sql: 'portal-auth', table: 'portal_login_tokens', cols: 'token_hash' },
  { sql: 'portal-auth', table: 'portal_sessions', cols: 'token_hash' },
  { sql: 'portal-passwords', table: 'portal_users', cols: 'username,password_hash,password_set_at' },
  { sql: 'team-auth', table: 'team_sessions', cols: 'token_hash' },
  // Data pipeline
  { sql: 'ad-metrics-clicks-impressions-orders', table: 'daily_metrics', cols: 'ad_clicks,ad_impressions,ad_orders' },
  { sql: 'ads-7d-attribution-and-brand-ads', table: 'daily_metrics', cols: 'attributed_sales_7d_cad,attributed_sales_7d_usd,ad_orders_7d' },
  { sql: 'ads-7d-attribution-and-brand-ads', table: 'daily_brand_ads', cols: 'date' },
  { sql: 'ads-search-terms-campaigns', table: 'ads_search_terms', cols: 'profile' },
  { sql: 'ads-search-terms-campaigns', table: 'ads_campaign_snapshot', cols: 'profile' },
  { sql: 'inventory-reserved-unfulfillable', table: 'daily_metrics', cols: 'inventory_reserved,inventory_unfulfillable' },
  { sql: 'sns-daily', table: 'sns_daily', cols: 'asin' },
  { sql: 'sns-daily', table: 'sns_sync_days', cols: 'date' },
  { sql: 'daily-fees', table: 'daily_fees', cols: 'date' },
  { sql: 'daily-fees-mp', table: 'daily_fees_mp', cols: 'date,mp_id' },
  { sql: 'daily-metrics-mp', table: 'daily_metrics_mp', cols: 'date,asin,mp_id' },
  { sql: 'daily-brand-orders', table: 'daily_brand_orders', cols: 'date,brand_id' },
  { sql: 'datadive-snapshots', table: 'datadive_snapshots', cols: 'asin' },
  { sql: 'listing-content', table: 'listing_content', cols: 'asin' },
  { sql: 'sku-prices', table: 'sku_prices', cols: 'sku' },
  // Drop migrations — these columns should be GONE
  { sql: 'drop-ntb-columns', table: 'daily_metrics', cols: 'ntb_sales_cad', wantMissing: true },
  { sql: 'drop-ntb-columns', table: 'daily_metrics', cols: 'ntb_units', wantMissing: true },
];

(async () => {
  const results = [];
  for (const p of PROBES) {
    const { error } = await supabase.from(p.table).select(p.cols).limit(1);
    const exists = !error;
    const ok = p.wantMissing ? !exists : exists;
    results.push({
      migration: p.sql,
      probe: `${p.table}(${p.cols})`,
      status: ok ? 'OK' : (p.wantMissing ? 'STILL PRESENT' : 'MISSING'),
      detail: ok ? '' : (error?.message || '').slice(0, 80),
    });
  }
  const bad = results.filter(r => r.status !== 'OK');
  console.log(`\n${results.length} probes — ${results.length - bad.length} OK, ${bad.length} failing\n`);
  if (bad.length) { console.log('FAILING:'); console.table(bad); }
  console.log('ALL PROBES:');
  console.table(results.map(r => ({ migration: r.migration, probe: r.probe, status: r.status })));
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
