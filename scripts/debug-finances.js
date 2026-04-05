require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');

async function getAccessToken() {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: process.env.SP_API_REFRESH_TOKEN,
      client_id: process.env.SP_API_CLIENT_ID,
      client_secret: process.env.SP_API_CLIENT_SECRET
    }).toString();
    const req = https.request({
      hostname: 'api.amazon.com', path: '/auth/o2/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { const j = JSON.parse(d); j.access_token ? resolve(j.access_token) : reject(new Error(j.error_description)); });
    });
    req.on('error', reject); req.write(body); req.end();
  });
}

async function spGet(path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'sellingpartnerapi-na.amazon.com', path, method: 'GET',
      headers: { 'x-amz-access-token': token, 'Accept': 'application/json' }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d) }));
    });
    req.on('error', reject); req.end();
  });
}

async function main() {
  const token = await getAccessToken();
  console.log('Token OK\n');

  // Test 1: last 30 days with no MaxResultsPerPage
  const start = '2026-03-05T00:00:00Z';
  const end   = '2026-04-03T23:59:59Z';

  const path = `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(start)}&PostedBefore=${encodeURIComponent(end)}`;
  console.log('Calling:', path);

  const res = await spGet(path, token);
  console.log('HTTP status:', res.status);

  const payload = res.body.payload;
  const events  = payload?.FinancialEvents || {};

  console.log('Top-level keys:', Object.keys(res.body));
  console.log('Payload keys:', payload ? Object.keys(payload) : 'no payload');
  console.log('FinancialEvents keys:', Object.keys(events));

  const shipments = events.ShipmentEventList || [];
  const refunds   = events.RefundEventList || [];
  const services  = events.ServiceFeeEventList || [];

  console.log(`\nShipmentEventList: ${shipments.length} events`);
  console.log(`RefundEventList:   ${refunds.length} events`);
  console.log(`ServiceFeeEventList: ${services.length} events`);

  if (shipments.length > 0) {
    console.log('\nSample shipment event:');
    const s = shipments[0];
    console.log('  OrderId:', s.AmazonOrderId);
    console.log('  PostedDate:', s.PostedDate);
    const item = s.ShipmentItemList?.[0];
    if (item) {
      console.log('  First item ASIN:', item.ASIN);
      console.log('  ItemFeeList:', JSON.stringify(item.ItemFeeList?.slice(0, 3)));
    }
  }

  // Tally fees using correct field name (CurrencyAmount, not Amount)
  let totalFeesCad = 0, totalFeesUsd = 0;
  for (const shipment of shipments) {
    for (const item of (shipment.ShipmentItemList || [])) {
      for (const fee of (item.ItemFeeList || [])) {
        const amount = Math.abs(fee.FeeAmount?.CurrencyAmount || 0);
        const cur = fee.FeeAmount?.CurrencyCode;
        if (cur === 'CAD') totalFeesCad += amount;
        if (cur === 'USD') totalFeesUsd += amount;
      }
    }
  }
  console.log(`\nCalculated Amazon fees — CAD: ${totalFeesCad.toFixed(2)}, USD: ${totalFeesUsd.toFixed(2)}`);

  const adsEvents = events.ProductAdsPaymentEventList || [];
  console.log(`ProductAdsPaymentEventList: ${adsEvents.length} events`);
  let adsCad = 0, adsUsd = 0;
  for (const e of adsEvents) {
    if ((e.TransactionType || '').toLowerCase() === 'charge') {
      const amount = Math.abs(e.TransactionValue?.CurrencyAmount || 0);
      const cur = e.TransactionValue?.CurrencyCode;
      if (cur === 'CAD') adsCad += amount;
      if (cur === 'USD') adsUsd += amount;
    }
  }
  console.log(`Calculated Ad spend — CAD: ${adsCad.toFixed(2)}, USD: ${adsUsd.toFixed(2)}`);
  if (adsEvents.length > 0) console.log('Sample ads event:', JSON.stringify(adsEvents[0], null, 2));

  console.log('\nnextToken:', res.body.nextToken ? 'present' : 'none');
}

main().catch(err => console.error('ERROR:', err.message));
