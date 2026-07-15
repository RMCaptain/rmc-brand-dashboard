/**
 * Amazon Advertising API — Sponsored Products search term sync
 * Pulls a rolling 30-day spSearchTerm SUMMARY report per profile and stores
 * rows in ads_search_terms (wipe-and-replace per profile). Feeds the team's
 * ppc-search-terms skill via GET /api/ads/search-terms.
 *
 * Only rows with >=1 click are kept — impression-only rows balloon the table
 * and negation/harvest analysis needs click data anyway.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAdsToken, adsReq, waitForAdReport, downloadAdReport, PROFILES } = require('./ads');

async function createSearchTermReport(profileId, token, startDate, endDate) {
  const res = await adsReq('POST', '/reporting/reports', profileId, token, {
    name:      `SP-SEARCHTERM-${startDate}-${endDate}-${Date.now()}`,
    startDate,
    endDate,
    configuration: {
      adProduct:    'SPONSORED_PRODUCTS',
      groupBy:      ['searchTerm'],
      columns: [
        'searchTerm', 'campaignId', 'campaignName', 'adGroupId', 'adGroupName',
        'keywordId', 'keyword', 'matchType', 'targeting',
        'impressions', 'clicks', 'cost', 'purchases14d', 'sales14d',
      ],
      reportTypeId: 'spSearchTerm',
      timeUnit:     'SUMMARY',
      format:       'GZIP_JSON',
    },
  }, { 'Content-Type': 'application/vnd.createasyncreportrequest.v3+json' });

  if (res.status === 200 && res.body.reportId) return res.body.reportId;
  if (res.status === 425) {
    const match = String(res.body?.detail || '').match(/([0-9a-f-]{36})/i);
    if (match) { console.log(`[AdsTerms] Reusing existing report ${match[1]}`); return match[1]; }
  }
  throw new Error(`Search term report create failed (${res.status}): ${JSON.stringify(res.body)}`);
}

function toRows(rows, profile, startDate, endDate) {
  return (rows || [])
    .filter(r => Number(r.clicks || 0) > 0)
    .map(r => ({
      profile,
      report_start:  startDate,
      report_end:    endDate,
      campaign_id:   r.campaignId   != null ? String(r.campaignId) : null,
      campaign_name: r.campaignName || null,
      ad_group_id:   r.adGroupId    != null ? String(r.adGroupId) : null,
      ad_group_name: r.adGroupName  || null,
      keyword_id:    r.keywordId    != null ? String(r.keywordId) : null,
      keyword:       r.keyword      || null,
      match_type:    r.matchType    || null,
      targeting:     r.targeting    || null,
      search_term:   r.searchTerm,
      impressions:   Number(r.impressions  || 0),
      clicks:        Number(r.clicks       || 0),
      cost:          Math.round(Number(r.cost || 0) * 100) / 100,
      orders:        Number(r.purchases14d || 0),
      sales:         Math.round(Number(r.sales14d || 0) * 100) / 100,
    }))
    .filter(r => r.search_term);
}

/**
 * Pull both profiles for [startDate, endDate] (<=31 days) and replace the
 * stored rows per profile. A profile whose pull comes back EMPTY keeps its
 * old rows (destructive writes must validate source non-empty first).
 */
async function syncSearchTerms(supabase, startDate, endDate) {
  const token = await getAdsToken();
  console.log(`[AdsTerms] Search term reports ${startDate} → ${endDate} (CA + US)...`);
  const [caId, usId] = await Promise.all([
    createSearchTermReport(PROFILES.CA, token, startDate, endDate),
    createSearchTermReport(PROFILES.US, token, startDate, endDate),
  ]);
  const [caUrl, usUrl] = await Promise.all([
    waitForAdReport(caId, PROFILES.CA, token),
    waitForAdReport(usId, PROFILES.US, token),
  ]);
  const [caRaw, usRaw] = await Promise.all([downloadAdReport(caUrl), downloadAdReport(usUrl)]);

  const result = {};
  for (const [profile, raw] of [['CA', caRaw], ['US', usRaw]]) {
    const rows = toRows(raw, profile, startDate, endDate);
    if (rows.length === 0) {
      console.warn(`[AdsTerms] ${profile}: pull returned 0 clicked terms — keeping existing rows`);
      result[profile] = { rows: 0, replaced: false };
      continue;
    }
    const { error: delErr } = await supabase.from('ads_search_terms').delete().eq('profile', profile);
    if (delErr) throw new Error(`[AdsTerms] ${profile} delete failed: ${delErr.message}`);
    // Supabase caps payloads; insert in chunks of 500.
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await supabase.from('ads_search_terms').insert(rows.slice(i, i + 500));
      if (error) throw new Error(`[AdsTerms] ${profile} insert failed at ${i}: ${error.message}`);
    }
    console.log(`[AdsTerms] ${profile}: stored ${rows.length} clicked search terms`);
    result[profile] = { rows: rows.length, replaced: true };
  }
  return result;
}

module.exports = { syncSearchTerms };
