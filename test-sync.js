const { syncBrandMetrics, _debugListings } = require('./sync/amazon');
const brands = require('./data/brands.json').brands;

console.log(`Testing sync with ${brands.length} brand(s): ${brands.map(b => b.name).join(', ')}`);
console.log('Note: Reports take 1-3 minutes to process on Amazon\'s end.\n');

syncBrandMetrics(brands)
  .then(metrics => {
    console.log('\n=== SYNC RESULTS ===');
    for (const [brandId, data] of Object.entries(metrics)) {
      const s = data.summary;
      console.log(`\n${brandId.toUpperCase()}`);
      console.log(`  Revenue (7d):  $${s.revenue7d}`);
      console.log(`  Units (7d):    ${s.units7d}`);
      console.log(`  Sessions (7d): ${s.sessions7d}`);
      console.log(`  Buy Box:       ${s.buyBox != null ? s.buyBox + '%' : 'N/A'}`);
      console.log(`  Alerts:        ${s.alerts.suppressedListings} suppressed, ${s.alerts.lostBuyBox} lost BB`);
      console.log(`  SKUs:`);
      data.skus.forEach(sku => {
        console.log(`    ${sku.asin} | ${sku.status} | $${sku.revenue7d} | ${sku.units7d} units | inv: ${sku.inventory}`);
      });
    }
  })
  .catch(err => {
    console.error('\nSync failed:', err.message);
  });
