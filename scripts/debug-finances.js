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
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const token = await getAccessToken();
  console.log('Token OK\n');

  // Narrow window around Mar 15-16 to get full MiscAdjustment detail
  const start = '2026-03-15T00:00:00Z';
  const end   = '2026-03-17T23:59:59Z';

  const allAdjustments = [];
  let nextToken = null;
  let page = 0;

  do {
    const path = nextToken
      ? `/finances/v0/financialEvents?NextToken=${encodeURIComponent(nextToken)}&MaxResultsPerPage=100`
      : `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(start)}&PostedBefore=${encodeURIComponent(end)}&MaxResultsPerPage=100`;

    const res = await spGet(path, token);
    if (res.status !== 200) { console.error('API error:', res.status, JSON.stringify(res.body)); break; }
    const events = res.body.payload?.FinancialEvents || {};
    allAdjustments.push(...(events.AdjustmentEventList || []));

    nextToken = res.body.payload?.NextToken || null;
    page++;
    if (nextToken) await sleep(2100);
  } while (nextToken && page < 20);

  console.log(`Pages: ${page}, Total adjustments in window: ${allAdjustments.length}\n`);

  // Full dump of every adjustment in this window
  console.log('═══ All AdjustmentEventList entries Mar 15–17 (FULL JSON) ═══\n');
  console.log(JSON.stringify(allAdjustments, null, 2));

  // Also check if there are MiscAdjustments in ALL of March and total them
  await sleep(2100);
  console.log('\n\n═══ Scanning all of March for MiscAdjustment type ═══');
  const startMar = '2026-03-01T00:00:00Z';
  const endMar   = '2026-03-31T23:59:59Z';
  const miscAdj = [];
  let nt2 = null, pg2 = 0;

  do {
    const path = nt2
      ? `/finances/v0/financialEvents?NextToken=${encodeURIComponent(nt2)}&MaxResultsPerPage=100`
      : `/finances/v0/financialEvents?PostedAfter=${encodeURIComponent(startMar)}&PostedBefore=${encodeURIComponent(endMar)}&MaxResultsPerPage=100`;

    const res = await spGet(path, token);
    if (res.status !== 200) break;
    const events = res.body.payload?.FinancialEvents || {};
    for (const adj of (events.AdjustmentEventList || [])) {
      if (adj.AdjustmentType === 'MiscAdjustment') miscAdj.push(adj);
    }
    nt2 = res.body.payload?.NextToken || null;
    pg2++;
    process.stdout.write(`  Page ${pg2}\r`);
    if (nt2) await sleep(2100);
  } while (nt2 && pg2 < 100);

  console.log(`\n\nAll MiscAdjustment entries in March:`);
  console.log(JSON.stringify(miscAdj, null, 2));
  const totalUSD = miscAdj.filter(a => a.AdjustmentAmount?.CurrencyCode === 'USD').reduce((s, a) => s + (a.AdjustmentAmount?.CurrencyAmount || 0), 0);
  const totalCAD = miscAdj.filter(a => a.AdjustmentAmount?.CurrencyCode === 'CAD').reduce((s, a) => s + (a.AdjustmentAmount?.CurrencyAmount || 0), 0);
  console.log(`\nMiscAdjustment totals:  USD ${totalUSD.toFixed(2)}  |  CAD ${totalCAD.toFixed(2)}`);
  console.log(`At 1.38 rate:  ~CA$${(totalCAD + totalUSD * 1.38).toFixed(2)}`);
}

main().catch(err => console.error('ERROR:', err.message));
