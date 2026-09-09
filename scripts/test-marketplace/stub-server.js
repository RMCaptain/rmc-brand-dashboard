'use strict';
// Boots server.js on a stubbed in-memory Supabase (same seed as e2e-metrics.test.js)
// and keeps it running for the render harness. Usage: PORT=3632 node stub-server.js
const ROOT = require('path').resolve(__dirname, '..', '..') + '';
const { pstDateStr, pstSubtractDays } = require(ROOT + '/sync/dateUtils.js');
const CA = 'A2EUQ1WTGCTBG2', US = 'ATVPDKIKX0DER', UK = 'A1F83G8C2ARO7P';
const y = pstSubtractDays(pstDateStr(), 1);
const d = n => pstSubtractDays(y, n);
const D1 = d(2), D2 = d(1), D3 = d(0);
const T = {
  brands: [{ id: 'main', data: { brands: [
    { id: 'acure',   name: 'Acure',   marketplace: 'CA', color: '#111', asins: ['A1', 'A2'], asinTitles: { A1: 'Acure One' }, cogs: { A1: 2 } },
    { id: 'zellies', name: 'Zellies', marketplace: 'CA,US', color: '#222', asins: ['Z1'], cogsPerMarketplace: { Z1: { CA: 3, US: 2.5, UK: 2 } } },
  ] } }],
  preset_metrics: [{ id: 'main', data: { presets: {}, lastSync: null } }],
  daily_metrics: [
    { date: D1, asin: 'A1', brand_id: 'acure', units: 10, units_ca: 10, units_us: 0, revenue_cad: 100, revenue_usd: 0, spend_cad: 5, spend_usd: 0, attributed_sales_cad: 20, attributed_sales_usd: 0, refunded_units: 1, refund_amount_cad: 10, refund_amount_usd: 0, refund_count: 1, sessions: 50, page_views: 60, buy_box_pct: 90, inventory_on_hand: 100 },
    { date: D2, asin: 'A1', brand_id: 'acure', units: 7,  units_ca: 7,  units_us: 0, revenue_cad: 70,  revenue_usd: 0, spend_cad: 3, spend_usd: 0, attributed_sales_cad: 14, attributed_sales_usd: 0, refunded_units: 0, refund_amount_cad: 0, refund_amount_usd: 0, refund_count: 0, sessions: 40, page_views: 45, buy_box_pct: 95, inventory_on_hand: 93 },
    { date: D3, asin: 'A1', brand_id: 'acure', units: 8,  units_ca: 8,  units_us: 0, revenue_cad: 90,  revenue_usd: 0, spend_cad: 4, spend_usd: 0, attributed_sales_cad: 0,  attributed_sales_usd: 0, refunded_units: 2, refund_amount_cad: 0, refund_amount_usd: 0, refund_count: 1, sessions: 45, page_views: 50, buy_box_pct: 92, inventory_on_hand: 85 },
    { date: D3, asin: 'Z1', brand_id: 'zellies', units: 9, units_ca: 3, units_us: 6, revenue_cad: 30, revenue_usd: 120, spend_cad: 0, spend_usd: 10, attributed_sales_cad: 0, attributed_sales_usd: 40, refunded_units: 0, refund_amount_cad: 0, refund_amount_usd: 0, refund_count: 0, sessions: 30, page_views: 33, buy_box_pct: 80, inventory_on_hand: 40 },
  ],
  sellerboard_daily: [
    { date: D2, mp_id: CA, asin: 'A1', sku: 'A1-SKU', units: 7,  sales: 70,  ad_spend: 3, refunds: 0, refund_amount: 0, amazon_fees: 20, net_profit: 30, promo_value: 1, product_costs: 20, sessions: 39 },
    { date: D3, mp_id: CA, asin: 'A1', sku: 'A1-SKU', units: 20, sales: 200, ad_spend: 4, refunds: 2, refund_amount: 0, amazon_fees: 50, net_profit: 90, promo_value: 0, product_costs: 60, sessions: null },
    { date: D3, mp_id: CA, asin: 'A1', sku: 'A1-SKU2', units: 1, sales: 10,  ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 3,  net_profit: 4,  promo_value: 0, product_costs: 3, sessions: null },
    { date: D3, mp_id: CA, asin: 'Z1', sku: 'Z1-SKU', units: 3,  sales: 30,  ad_spend: 0, refunds: 0, refund_amount: 0, amazon_fees: 9,  net_profit: 12, promo_value: 0, product_costs: 6, sessions: null },
    { date: D3, mp_id: UK, asin: 'Z1', sku: 'Z1-UK',  units: 4,  sales: 40,  ad_spend: 1, refunds: 0, refund_amount: 0, amazon_fees: 12, net_profit: 15, promo_value: 0, product_costs: 10, sessions: null },
  ],
  daily_fees_asin: [
    { date: D1, asin: 'A1', mp_id: CA, currency: 'CAD', fees: 25, refund_amount: 10, refund_fees: 1 },
    { date: D2, asin: 'A1', mp_id: CA, currency: 'CAD', fees: 21, refund_amount: 0,  refund_fees: 0 },
    { date: D3, asin: 'A1', mp_id: CA, currency: 'CAD', fees: 22, refund_amount: 0,  refund_fees: 0 },
    { date: D3, asin: 'Z1', mp_id: CA, currency: 'CAD', fees: 9,  refund_amount: 0,  refund_fees: 0 },
    { date: D3, asin: 'Z1', mp_id: US, currency: 'USD', fees: 30, refund_amount: 0,  refund_fees: 0 },
  ],
  daily_fees: [
    { date: D1, fees_cad: 25, fees_usd: 0,  service_fees_cad: 10, service_fees_usd: 0, refund_amount_cad: 10, refund_amount_usd: 0, refund_fees_cad: 1, refund_fees_usd: 0, refund_count: 1, breakdown_cad: { Storage: 4, Referral: 15 }, breakdown_usd: {} },
    { date: D2, fees_cad: 21, fees_usd: 0,  service_fees_cad: 9,  service_fees_usd: 0, refund_amount_cad: 0,  refund_amount_usd: 0, refund_fees_cad: 0, refund_fees_usd: 0, refund_count: 0, breakdown_cad: { Storage: 3 }, breakdown_usd: {} },
    { date: D3, fees_cad: 31, fees_usd: 30, service_fees_cad: 8,  service_fees_usd: 2, refund_amount_cad: 0,  refund_amount_usd: 0, refund_fees_cad: 0, refund_fees_usd: 0, refund_count: 0, breakdown_cad: { Storage: 2 }, breakdown_usd: { Storage: 1 } },
  ],
};
function makeBuilder(table) {
  const rows = T[table] || [];
  const filters = []; let single = false, maybe = false, rangeArg = null; const orders = [];
  const b = {
    select() { return b; }, order(col, o) { orders.push([col, o?.ascending !== false]); return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; }, neq(c, v) { filters.push(r => r[c] !== v); return b; },
    gte(c, v) { filters.push(r => r[c] >= v); return b; }, lte(c, v) { filters.push(r => r[c] <= v); return b; },
    gt(c, v) { filters.push(r => r[c] > v); return b; },  lt(c, v) { filters.push(r => r[c] < v); return b; },
    in(c, vs) { filters.push(r => vs.includes(r[c])); return b; }, is(c, v) { filters.push(r => r[c] == v); return b; },
    or() { return b; }, like() { return b; }, ilike() { return b; }, limit(n) { rangeArg = [0, n - 1]; return b; },
    range(a, z) { rangeArg = [a, z]; return b; }, single() { single = true; return b; }, maybeSingle() { maybe = true; return b; },
    upsert() { return { select: () => Promise.resolve({ data: [], error: null }), then: res => res({ data: [], error: null }) }; },
    insert() { return { select: () => Promise.resolve({ data: [], error: null }), then: res => res({ data: [], error: null }) }; },
    update() { return b; }, delete() { return b; },
    then(resolve) {
      let out = rows.filter(r => filters.every(f => f(r)));
      for (const [col, asc] of orders.reverse()) out = [...out].sort((p, q) => (p[col] < q[col] ? -1 : p[col] > q[col] ? 1 : 0) * (asc ? 1 : -1));
      if (rangeArg) out = out.slice(rangeArg[0], rangeArg[1] + 1);
      if (single) return resolve(out.length ? { data: out[0], error: null } : { data: null, error: { message: 'no rows' } });
      if (maybe) return resolve({ data: out[0] || null, error: null });
      return resolve({ data: out, error: null });
    },
  };
  return b;
}
const stubClient = { from: t => makeBuilder(t), rpc: () => Promise.resolve({ data: null, error: null }) };
const sbPath = require.resolve('@supabase/supabase-js', { paths: [ROOT] });
require.cache[sbPath] = { id: sbPath, filename: sbPath, loaded: true, exports: { createClient: () => stubClient } };
process.env.SUPABASE_URL = 'https://stub.supabase.co'; process.env.SUPABASE_SERVICE_KEY = 'stub';
process.env.SYNC_ENABLED = 'false'; process.env.PORT = process.env.PORT || '3632';
delete process.env.AUTH_USERNAME; delete process.env.AUTH_PASSWORD; delete process.env.GOOGLE_CLIENT_ID; delete process.env.NODE_ENV;
process.chdir(ROOT);
require(ROOT + '/server.js');
module.exports = { D1, D2, D3 };
