'use strict';
/**
 * Ads-accuracy cross-check — the "is our data actually right" loop.
 *
 * Pulls fresh SUMMARY reports straight from the Amazon Ads API and compares
 * them against what daily_metrics says for the same windows. Runs Monday
 * (after the master-sheet write) and on demand via POST /api/ads/verify.
 * Any breach posts a Slack alert; silence means the DB provably matches
 * Amazon's own numbers.
 *
 * Two windows, because attribution keeps moving after the fact:
 *  - SETTLED  [today-40 → today-17]: every attribution window (7d and 14d)
 *    has closed — spend, clicks, sales7d and sales14d all compared tight.
 *  - FRESH    [today-16 → today-3]: sales still restate, so only spend and
 *    clicks are compared (Amazon never materially restates those).
 *
 * Report ranges stay ≤31 days (Amazon's hard cap) and inside ~95d retention.
 */

const { getAdsToken, adsReq, waitForAdReport, downloadAdReport, PROFILES } = require('./ads');

const TOL = {
  spend:  (v) => Math.max(2, v * 0.005),   // $2 or 0.5%
  clicks: (v) => Math.max(5, v * 0.005),
  sales:  (v) => Math.max(10, v * 0.01),   // $10 or 1% (settled windows only)
};

async function summaryReport(profileId, token, startDate, endDate) {
  const res = await adsReq('POST', '/reporting/reports', profileId, token, {
    name: `ACCURACY-${startDate}-${endDate}-${Date.now()}`,
    startDate, endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['advertiser'],
      columns:      ['advertisedAsin', 'cost', 'sales7d', 'sales14d', 'clicks'],
      reportTypeId: 'spAdvertisedProduct',
      timeUnit:     'SUMMARY',
      format:       'GZIP_JSON',
    },
  }, { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' });
  if (res.status === 200 && res.body.reportId) return res.body.reportId;
  if (res.status === 425) {
    const m = String(res.body?.detail || '').match(/([0-9a-f-]{36})/i);
    if (m) return m[1];
  }
  throw new Error(`accuracy report create failed (${res.status}): ${JSON.stringify(res.body)}`);
}

// daily_metrics sums for a window, split per marketplace + per brand.
// Stable (date,asin) ordering — same shred-proof pagination as masterSheets.
async function dbSums(supabase, from, to) {
  const acct = { CA: { spend: 0, sales7: 0, sales14: 0 }, US: { spend: 0, sales7: 0, sales14: 0 }, clicks: 0, sales7Rows: 0 };
  const brandSpend = {}; // brand -> { CA, US }
  const PAGE = 1000;
  for (let f = 0; ; f += PAGE) {
    const { data, error } = await supabase.from('daily_metrics')
      .select('date,asin,brand_id,spend_cad,spend_usd,attributed_sales_cad,attributed_sales_usd,attributed_sales_7d_cad,attributed_sales_7d_usd,ad_clicks')
      .gte('date', from).lte('date', to)
      .order('date').order('asin')
      .range(f, f + PAGE - 1);
    if (error) throw new Error(`accuracy db read: ${error.message}`);
    for (const r of (data || [])) {
      acct.CA.spend   += Number(r.spend_cad || 0);
      acct.US.spend   += Number(r.spend_usd || 0);
      acct.CA.sales14 += Number(r.attributed_sales_cad || 0);
      acct.US.sales14 += Number(r.attributed_sales_usd || 0);
      acct.CA.sales7  += Number(r.attributed_sales_7d_cad || 0);
      acct.US.sales7  += Number(r.attributed_sales_7d_usd || 0);
      if (r.attributed_sales_7d_cad != null || r.attributed_sales_7d_usd != null) acct.sales7Rows++;
      acct.clicks     += Number(r.ad_clicks || 0);
      const b = brandSpend[r.brand_id] || (brandSpend[r.brand_id] = { CA: 0, US: 0 });
      b.CA += Number(r.spend_cad || 0);
      b.US += Number(r.spend_usd || 0);
    }
    if (!data || data.length < PAGE) break;
  }
  return { acct, brandSpend };
}

async function verifyAdsAccuracy(supabase) {
  const { pstDateStr, pstSubtractDays } = require('./dateUtils');
  const today = pstDateStr();
  const windows = [
    { tag: 'settled', from: pstSubtractDays(today, 40), to: pstSubtractDays(today, 17), checkSales: true },
    { tag: 'fresh',   from: pstSubtractDays(today, 16), to: pstSubtractDays(today, 3),  checkSales: false },
  ];
  const token = await getAdsToken();
  const result = { checkedAt: new Date().toISOString(), windows: [], breaches: [] };

  for (const w of windows) {
    // Bake both marketplaces in parallel, then read the DB for the same range.
    const [caId, usId] = await Promise.all([
      summaryReport(PROFILES.CA, token, w.from, w.to),
      summaryReport(PROFILES.US, token, w.from, w.to),
    ]);
    const [caUrl, usUrl] = await Promise.all([
      waitForAdReport(caId, PROFILES.CA, token),
      waitForAdReport(usId, PROFILES.US, token),
    ]);
    const [caRows, usRows] = await Promise.all([downloadAdReport(caUrl), downloadAdReport(usUrl)]);
    const db = await dbSums(supabase, w.from, w.to);

    const api = { CA: { spend: 0, sales7: 0, sales14: 0 }, US: { spend: 0, sales7: 0, sales14: 0 }, clicks: 0 };
    const apiBrandSpend = {}; // via asin->brand from the DB itself; unmapped ASINs land on their DB brand or 'NOT-IN-DB'
    const asinBrand = {};
    {
      const PAGE = 1000;
      for (let f = 0; ; f += PAGE) {
        const { data, error } = await supabase.from('daily_metrics')
          .select('asin,brand_id').gte('date', w.from).lte('date', w.to)
          .order('asin').order('date').range(f, f + PAGE - 1);
        if (error) throw new Error(`accuracy brand map: ${error.message}`);
        for (const r of (data || [])) asinBrand[r.asin] = r.brand_id;
        if (!data || data.length < PAGE) break;
      }
    }
    for (const [mp, rows] of [['CA', caRows], ['US', usRows]]) {
      for (const r of (rows || [])) {
        api[mp].spend   += Number(r.cost || 0);
        api[mp].sales7  += Number(r.sales7d || 0);
        api[mp].sales14 += Number(r.sales14d || 0);
        api.clicks      += Number(r.clicks || 0);
        const b = asinBrand[r.advertisedAsin] || 'NOT-IN-DB';
        const e = apiBrandSpend[b] || (apiBrandSpend[b] = { CA: 0, US: 0 });
        e[mp] += Number(r.cost || 0);
      }
    }

    const wr = { tag: w.tag, from: w.from, to: w.to, api, db: db.acct, checks: [] };
    const check = (name, apiV, dbV, tol) => {
      const diff = Math.abs(apiV - dbV);
      const ok = diff <= tol(Math.max(apiV, dbV));
      wr.checks.push({ name, api: Math.round(apiV * 100) / 100, db: Math.round(dbV * 100) / 100, ok });
      if (!ok) result.breaches.push(`${w.tag} ${w.from}→${w.to} · ${name}: Amazon ${Math.round(apiV * 100) / 100} vs DB ${Math.round(dbV * 100) / 100}`);
    };

    check('spend CA (CAD)', api.CA.spend, db.acct.CA.spend, TOL.spend);
    check('spend US (USD)', api.US.spend, db.acct.US.spend, TOL.spend);
    check('clicks', api.clicks, db.acct.clicks, TOL.clicks);
    if (w.checkSales) {
      check('sales14d CA', api.CA.sales14, db.acct.CA.sales14, TOL.sales);
      check('sales14d US', api.US.sales14, db.acct.US.sales14, TOL.sales);
      // 7d columns only exist since the 2026-08 backfill; skip until populated
      // so a delayed backfill reads as "not yet checked", not a false alarm.
      if (db.acct.sales7Rows > 0) {
        check('sales7d CA', api.CA.sales7, db.acct.CA.sales7, TOL.sales);
        check('sales7d US', api.US.sales7, db.acct.US.sales7, TOL.sales);
      } else {
        wr.checks.push({ name: 'sales7d', skipped: 'no 7d columns in window yet' });
      }
    }
    // Per-brand spend: catches attribution leaks (ASIN remaps, unknown-brand growth)
    for (const [b, apiB] of Object.entries(apiBrandSpend)) {
      const dbB = db.brandSpend[b] || { CA: 0, US: 0 };
      for (const mp of ['CA', 'US']) {
        if (apiB[mp] === 0 && dbB[mp] === 0) continue;
        check(`spend ${mp} · ${b}`, apiB[mp], dbB[mp], TOL.spend);
      }
    }
    result.windows.push(wr);
  }

  result.ok = result.breaches.length === 0;
  if (!result.ok) {
    try {
      const { postSlackAlert } = require('../slack/alert');
      await postSlackAlert(
        `:rotating_light: *Ads data drifted from Amazon* — ${result.breaches.length} check(s) failed. Master-sheet tabs and dashboard ad numbers may be off until re-synced.`,
        result.breaches.join('\n')
      );
    } catch (e) { console.warn('[AdsAccuracy] Slack alert failed:', e.message); }
  }
  console.log(`[AdsAccuracy] ${result.ok ? 'OK — DB matches Amazon' : `${result.breaches.length} BREACH(ES)`} (${result.windows.map(w => w.tag).join(', ')})`);
  return result;
}

module.exports = { verifyAdsAccuracy };
