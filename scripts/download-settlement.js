require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function main() {
  const token = await getAccessToken();
  console.log('Token OK');

  // Download report index 3 = Mar 16–30 (largest March settlement)
  const listRes = await spGet(
    '/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE&pageSize=5',
    token
  );
  const reports = listRes.body.reports || [];
  const report = reports[3]; // Mar 16–30
  console.log(`Downloading: ${report.reportId} | ${report.dataStartTime} → ${report.dataEndTime}`);

  const docRes = await spGet(`/reports/2021-06-30/documents/${report.reportDocumentId}`, token);
  const url = docRes.body.url;
  let data = await downloadUrl(url);
  if (docRes.body.compressionAlgorithm === 'GZIP') data = zlib.gunzipSync(data);

  const outPath = path.join(__dirname, '../data/settlement-report.txt');
  fs.writeFileSync(outPath, data);
  console.log(`Saved: ${outPath} (${(data.length/1024).toFixed(1)} KB)`);
}

main().catch(err => console.error('ERROR:', err.message));
