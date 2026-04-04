// Quickly checks real column names and a sample row from the listings report
require('dotenv').config();
const https = require('https');
const zlib = require('zlib');

async function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function sp(method, path, token, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { 'x-amz-access-token': token, 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = https.request({ hostname: 'sellingpartnerapi-na.amazon.com', path, method, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject); if (bodyStr) req.write(bodyStr); req.end();
  });
}

async function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // Get token
  const tokenRes = await post('https://api.amazon.com/auth/o2/token', {
    grant_type: 'refresh_token',
    refresh_token: process.env.SP_API_REFRESH_TOKEN,
    client_id: process.env.SP_API_CLIENT_ID,
    client_secret: process.env.SP_API_CLIENT_SECRET
  });
  const token = tokenRes.body.access_token;

  const marketplaceIds = process.env.SP_API_MARKETPLACE_IDS.split(',').map(s => s.trim());

  // Create listings report
  console.log('Creating listings report...');
  const res = await sp('POST', '/reports/2021-06-30/reports', token, {
    reportType: 'GET_MERCHANT_LISTINGS_ALL_DATA',
    marketplaceIds
  });
  const reportId = res.body.reportId;
  console.log('Report ID:', reportId);

  // Poll
  let docId;
  while (true) {
    await sleep(10000);
    const r = await sp('GET', `/reports/2021-06-30/reports/${reportId}`, token);
    console.log('Status:', r.body.processingStatus);
    if (r.body.processingStatus === 'DONE') { docId = r.body.reportDocumentId; break; }
    if (['FATAL','CANCELLED'].includes(r.body.processingStatus)) { console.error('Report failed'); process.exit(1); }
  }

  // Download
  const docRes = await sp('GET', `/reports/2021-06-30/documents/${docId}`, token);
  const buffer = await downloadUrl(docRes.body.url);
  let text;
  if (docRes.body.compressionAlgorithm === 'GZIP') {
    text = await new Promise((res, rej) => zlib.gunzip(buffer, (e, r) => e ? rej(e) : res(r.toString('utf8'))));
  } else {
    text = buffer.toString('utf8');
  }

  const lines = text.split('\n').filter(Boolean);
  console.log('\n=== COLUMN HEADERS ===');
  console.log(lines[0].split('\t').map((h, i) => `${i}: ${h}`).join('\n'));
  console.log('\n=== FIRST 3 ROWS (raw) ===');
  lines.slice(1, 4).forEach((l, i) => {
    const cols = l.split('\t');
    console.log(`\nRow ${i + 1}:`);
    lines[0].split('\t').forEach((h, idx) => {
      if (cols[idx]?.trim()) console.log(`  ${h.trim()}: ${cols[idx].trim()}`);
    });
  });

  // Check our Acure ASINs specifically
  const acureAsins = ['B003Z4UKGM','B003Z4OD24','B003Z4QGRE'];
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase());
  const asinIdx = headers.indexOf('asin1');
  const statusIdx = headers.indexOf('status');
  const titleIdx = headers.indexOf('item-name');

  console.log('\n=== ACURE ASIN STATUS ===');
  console.log(`asin1 col: ${asinIdx}, status col: ${statusIdx}, item-name col: ${titleIdx}`);
  lines.slice(1).forEach(line => {
    const cols = line.split('\t');
    const asin = cols[asinIdx]?.trim();
    if (acureAsins.includes(asin)) {
      console.log(`  ${asin} | status: ${cols[statusIdx]?.trim()} | ${cols[titleIdx]?.trim().substring(0, 50)}`);
    }
  });
}

main().catch(console.error);
