'use strict';
/**
 * Marketplace registry — the single source of truth for every marketplace
 * the dashboard knows about. See MARKETPLACE-EXPANSION-PLAN.md.
 *
 * NOT YET WIRED IN (2026-08-07): seven modules still carry their own private
 * CA/US maps (amazon.js, backfill.js, reconcile.js, repeatPurchase.js,
 * listingContent.js, priceCache.js, metricsMp.js). Phase 1 of the expansion
 * replaces those with imports from here. Until then this file is inert —
 * safe to ship, nothing depends on it.
 *
 * Keys are mp_ids as stored in daily_metrics_mp / sns_daily / sku_prices:
 * raw SP-API marketplace ids for Amazon, 'walmart_ca' style for others.
 * Currency is an attribute, never derived from the id — Amazon.ca and
 * Walmart.ca are both CAD, which is exactly why currency-suffixed columns
 * can't represent a third marketplace and rows can.
 */

const MARKETPLACES = {
  A2EUQ1WTGCTBG2: {
    code: 'CA', platform: 'amazon', currency: 'CAD', region: 'na',
    storefront: 'https://www.amazon.ca', sellerCentral: 'https://sellercentral.amazon.ca',
    adsProfileEnv: 'ADS_PROFILE_CA', active: true,
  },
  ATVPDKIKX0DER: {
    code: 'US', platform: 'amazon', currency: 'USD', region: 'na',
    storefront: 'https://www.amazon.com', sellerCentral: 'https://sellercentral.amazon.com',
    adsProfileEnv: 'ADS_PROFILE_US', active: true,
  },
  A1F83G8C2ARO7P: {
    code: 'UK', platform: 'amazon', currency: 'GBP', region: 'eu',
    storefront: 'https://www.amazon.co.uk', sellerCentral: 'https://sellercentral.amazon.co.uk',
    adsProfileEnv: 'ADS_PROFILE_UK', active: false,   // flip when EU creds land
  },
  walmart_ca: {
    code: 'WMCA', platform: 'walmart', currency: 'CAD', region: null,
    storefront: 'https://www.walmart.ca', sellerCentral: 'https://seller.walmart.ca',
    adsProfileEnv: null,                              // Walmart Connect CA is partner-gated
    active: false,
  },
};

// SP-API + Ads API hosts by region. Refresh tokens are region-scoped too:
// region 'na' uses SP_API_REFRESH_TOKEN, 'eu' uses SP_API_REFRESH_TOKEN_EU.
// The LWA token endpoint (api.amazon.com) is global.
const SP_API_HOSTS = {
  na: 'sellingpartnerapi-na.amazon.com',
  eu: 'sellingpartnerapi-eu.amazon.com',
};
const ADS_HOSTS = {
  na: 'advertising-api.amazon.com',
  eu: 'advertising-api-eu.amazon.com',
};
const SP_REFRESH_TOKEN_ENV = { na: 'SP_API_REFRESH_TOKEN', eu: 'SP_API_REFRESH_TOKEN_EU' };

const active   = () => Object.entries(MARKETPLACES).filter(([, m]) => m.active).map(([id, m]) => ({ id, ...m }));
const all      = () => Object.entries(MARKETPLACES).map(([id, m]) => ({ id, ...m }));
// Plain lookup maps for modules that want the old literal-object shape.
const currencyMap = () => Object.fromEntries(Object.entries(MARKETPLACES).map(([id, m]) => [id, m.currency]));
const codeMap     = () => Object.fromEntries(Object.entries(MARKETPLACES).map(([id, m]) => [id, m.code]));
const idByCode    = code => { const m = byCode(code); return m ? m.id : null; };
const byId     = id => MARKETPLACES[id] || null;
const byCode   = code => {
  const hit = Object.entries(MARKETPLACES).find(([, m]) => m.code === (code || '').toUpperCase());
  return hit ? { id: hit[0], ...hit[1] } : null;
};
const currencyOf = id => MARKETPLACES[id]?.currency || null;
const codeOf     = id => MARKETPLACES[id]?.code || null;

module.exports = {
  MARKETPLACES, SP_API_HOSTS, ADS_HOSTS, SP_REFRESH_TOKEN_ENV,
  active, all, byId, byCode, currencyOf, codeOf, currencyMap, codeMap, idByCode,
};
