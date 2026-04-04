require('dotenv').config();
const https = require('https');

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'x-amz-access-token': token,
        'Content-Type': 'application/json'
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function test() {
  console.log('--- SP-API Connection Test ---\n');

  // Step 1: Get access token
  console.log('1. Requesting LWA access token...');
  const tokenRes = await post('https://api.amazon.com/auth/o2/token', {
    grant_type: 'refresh_token',
    refresh_token: process.env.SP_API_REFRESH_TOKEN,
    client_id: process.env.SP_API_CLIENT_ID,
    client_secret: process.env.SP_API_CLIENT_SECRET
  });

  if (tokenRes.status !== 200) {
    console.error('FAILED — Could not get access token');
    console.error('Status:', tokenRes.status);
    console.error('Response:', JSON.stringify(tokenRes.body, null, 2));
    return;
  }

  const accessToken = tokenRes.body.access_token;
  console.log('   Access token obtained.\n');

  // Step 2: Test Sellers API (simplest endpoint to verify identity)
  console.log('2. Verifying seller identity...');
  const sellerRes = await get(
    `https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations`,
    accessToken
  );

  if (sellerRes.status !== 200) {
    console.error('FAILED — Could not reach SP-API');
    console.error('Status:', sellerRes.status);
    console.error('Response:', JSON.stringify(sellerRes.body, null, 2));
    return;
  }

  const participations = sellerRes.body.payload || [];
  console.log('   Connected successfully!\n');
  console.log('3. Marketplaces on this account:');
  participations.forEach(p => {
    const mp = p.marketplace;
    console.log(`   - ${mp.name} (${mp.countryCode}) | ID: ${mp.id}`);
  });

  console.log('\n--- All good. SP-API is connected. ---');
}

test().catch(err => {
  console.error('Unexpected error:', err.message);
});
