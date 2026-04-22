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
  console.log('Token OK');

  for (const mpId of ['A2EUQ1WTGCTBG2', 'ATVPDKIKX0DER']) {
    const label = mpId === 'A2EUQ1WTGCTBG2' ? 'CA' : 'US';
    const path = `/fba/inventory/v1/summaries?details=true&granularityType=Marketplace&granularityId=${mpId}&marketplaceIds=${mpId}`;
    const res = await spGet(path, token);
    const summaries = res.body.payload?.inventorySummaries || [];
    console.log(`\n${label}: ${summaries.length} items returned (status ${res.status})`);
    if (summaries.length > 0) {
      const sample = summaries[0];
      console.log('Sample item keys:', Object.keys(sample));
      console.log('fulfillableQuantity (top):', sample.fulfillableQuantity);
      console.log('inventoryDetails:', JSON.stringify(sample.inventoryDetails));
    } else {
      console.log('Raw response:', JSON.stringify(res.body).slice(0, 300));
    }
  }
}

main().catch(err => console.error('ERROR:', err.message));
