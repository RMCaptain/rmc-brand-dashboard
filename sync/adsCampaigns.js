/**
 * Amazon Advertising API — Sponsored Products campaign structure snapshot
 * Lists campaigns, ad groups, keywords, targeting clauses, negative keywords
 * and product ads per profile via the SP management endpoints (fast, no report
 * baking) and stores one JSONB snapshot per profile in ads_campaign_snapshot.
 * Product ads carry the ASIN, which is what lets /api/ads/* filter by brand.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getAdsToken, adsReq, PROFILES } = require('./ads');

// Each SP entity uses a vendored content type and returns its list under a
// different key. maxResults caps at 500; nextToken pages.
const ENTITIES = [
  { name: 'campaigns',        path: '/sp/campaigns/list',                type: 'application/vnd.spCampaign.v3+json',        key: 'campaigns' },
  { name: 'adGroups',         path: '/sp/adGroups/list',                 type: 'application/vnd.spAdGroup.v3+json',         key: 'adGroups' },
  { name: 'keywords',         path: '/sp/keywords/list',                 type: 'application/vnd.spKeyword.v3+json',         key: 'keywords' },
  { name: 'targets',          path: '/sp/targets/list',                  type: 'application/vnd.spTargetingClause.v3+json', key: 'targetingClauses' },
  { name: 'negativeKeywords', path: '/sp/negativeKeywords/list',         type: 'application/vnd.spNegativeKeyword.v3+json', key: 'negativeKeywords' },
  { name: 'productAds',       path: '/sp/productAds/list',               type: 'application/vnd.spProductAd.v3+json',       key: 'productAds' },
];

async function listAll(entity, profileId, token) {
  const items = [];
  let nextToken = undefined;
  do {
    const body = { maxResults: 500 };
    if (nextToken) body.nextToken = nextToken;
    const res = await adsReq('POST', entity.path, profileId, token, body, {
      'Content-Type': entity.type,
      'Accept':       entity.type,
    });
    if (res.status !== 200) {
      throw new Error(`[AdsStructure] ${entity.name} list failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    items.push(...(res.body[entity.key] || []));
    nextToken = res.body.nextToken || undefined;
  } while (nextToken);
  return items;
}

async function pullStructure(profileId, token) {
  const snapshot = { pulledAt: new Date().toISOString(), counts: {} };
  for (const entity of ENTITIES) {
    snapshot[entity.name] = await listAll(entity, profileId, token);
    snapshot.counts[entity.name] = snapshot[entity.name].length;
  }
  return snapshot;
}

/**
 * Snapshot both profiles into ads_campaign_snapshot (upsert per profile).
 * A profile returning zero campaigns keeps its previous snapshot.
 */
async function syncCampaignStructure(supabase) {
  const token = await getAdsToken();
  const result = {};
  for (const [profile, profileId] of Object.entries(PROFILES)) {
    console.log(`[AdsStructure] Pulling ${profile} structure...`);
    const snapshot = await pullStructure(profileId, token);
    if (!snapshot.campaigns.length) {
      console.warn(`[AdsStructure] ${profile}: 0 campaigns returned — keeping previous snapshot`);
      result[profile] = { ...snapshot.counts, replaced: false };
      continue;
    }
    const { error } = await supabase.from('ads_campaign_snapshot')
      .upsert({ profile, snapshot, pulled_at: new Date().toISOString() }, { onConflict: 'profile' });
    if (error) throw new Error(`[AdsStructure] ${profile} upsert failed: ${error.message}`);
    console.log(`[AdsStructure] ${profile}:`, JSON.stringify(snapshot.counts));
    result[profile] = { ...snapshot.counts, replaced: true };
  }
  return result;
}

module.exports = { syncCampaignStructure };
