'use strict';
/**
 * Marketplace registry — the single source of truth for every marketplace
 * the dashboard knows about. See MARKETPLACE-EXPANSION-PLAN.md.
 *
 * WIRED IN (Phase 1 shipped): ~10 modules import this registry — amazon.js,
 * ads.js, backfill.js, dailyFees.js, listingContent.js, metricsMp.js,
 * priceCache.js, reconcile.js, repeatPurchase.js, plus /api/marketplaces in
 * server.js. This is live, depended-on code: changing ids, codes, or the
 * export shape breaks the sync pipeline. mp_ids are also persisted in
 * daily_metrics_mp / daily_fees_mp / sns_daily / sku_prices rows — never
 * rename an id.
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
    label: 'Amazon.ca', flag: '🇨🇦',
    storefront: 'https://www.amazon.ca', sellerCentral: 'https://sellercentral.amazon.ca',
    adsProfileEnv: 'ADS_PROFILE_CA', active: true,
  },
  ATVPDKIKX0DER: {
    code: 'US', platform: 'amazon', currency: 'USD', region: 'na',
    label: 'Amazon.com', flag: '🇺🇸',
    storefront: 'https://www.amazon.com', sellerCentral: 'https://sellercentral.amazon.com',
    adsProfileEnv: 'ADS_PROFILE_US', active: true,
  },
  A1F83G8C2ARO7P: {
    code: 'UK', platform: 'amazon', currency: 'GBP', region: 'eu',
    label: 'Amazon.co.uk', flag: '🇬🇧',
    storefront: 'https://www.amazon.co.uk', sellerCentral: 'https://sellercentral.amazon.co.uk',
    adsProfileEnv: 'ADS_PROFILE_UK', active: false,   // flip when EU creds land
  },
  walmart_ca: {
    code: 'WMCA', platform: 'walmart', currency: 'CAD', region: null,
    label: 'Walmart.ca', flag: '🇨🇦',
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

// ── Wide-table (currency-suffixed) writers ──────────────────────────────────
// daily_metrics / daily_fees / refund_events / the brands blob still carry
// `_cad` / `_usd` columns that mean Amazon.ca / Amazon.com specifically. Only
// these two marketplaces can be represented there. Every wide writer must go
// through these helpers so a third marketplace is skipped LOUDLY, never
// silently booked as USD (the old `!== CA ⇒ US` pattern).
const WIDE_TABLE_IDS = ['A2EUQ1WTGCTBG2', 'ATVPDKIKX0DER'];
const isWideTableMp = id => WIDE_TABLE_IDS.includes(id);

// Filter a marketplace-id list down to the wide-table pair, logging each
// exclusion. `tag` names the caller in the log line.
function wideTableOnly(ids, tag = 'Marketplaces') {
  return (ids || []).filter(id => {
    if (isWideTableMp(id)) return true;
    const m = byId(id);
    console.error(`[${tag}] marketplace ${id} (${m ? `${m.label}, ${m.currency}` : 'unknown'}) skipped — wide-table path is Amazon.ca/Amazon.com only; it must ride daily_metrics_mp`);
    return false;
  });
}

// CA-or-US for a wide-table writer. Returns true for Amazon.ca, false for
// Amazon.com, and THROWS for anything else — a wide writer that reaches this
// point with a third marketplace has already bypassed wideTableOnly().
function isCaMp(id, tag = 'Marketplaces') {
  if (id === WIDE_TABLE_IDS[0]) return true;
  if (id === WIDE_TABLE_IDS[1]) return false;
  const m = byId(id);
  throw new Error(`[${tag}] marketplace ${id} (${m ? m.label : 'unknown'}) cannot be written to a CAD/USD wide table`);
}

// Which marketplace CODES does a brand sell in with us? Source of truth is the
// brand's `marketplace` field ('CA', 'US', or 'CA,US'). Defaults to CA when
// unset. Unknown codes are dropped loudly, never silently.
function codesForBrand(brand, tag = 'Marketplaces') {
  const raw = (brand?.marketplace || 'CA').toUpperCase();
  return raw.split(',').map(s => s.trim()).filter(code => {
    if (byCode(code)) return true;
    if (code) console.error(`[${tag}] brand ${brand?.id || brand?.name || '?'}: unknown marketplace code '${code}' in brand.marketplace — ignored`);
    return false;
  });
}

// The marketplace code a single ASIN should be checked on. The brand's
// declared marketplace list is the source of truth: a single-marketplace
// brand always resolves to that marketplace (the listings report may show
// the ASIN active elsewhere too, but that is not where we sell it). A
// multi-marketplace brand ('CA,US') routes each ASIN by the listings
// report's per-ASIN marketplace when it is one of the declared codes, else
// the first declared code.
function codeForAsin(brand, asin, tag = 'Marketplaces') {
  const codes = codesForBrand(brand, tag);
  if (codes.length <= 1) return codes[0] || 'CA';
  const listed = (brand?.asinMarketplaces?.[asin] || '').toUpperCase();
  return codes.includes(listed) ? listed : codes[0];
}

// Public storefront hostname for a marketplace code ('CA' → www.amazon.ca).
function storefrontHost(code) {
  const m = byCode(code);
  if (!m) return null;
  try { return new URL(m.storefront).hostname; } catch { return null; }
}

module.exports = {
  MARKETPLACES, SP_API_HOSTS, ADS_HOSTS, SP_REFRESH_TOKEN_ENV, WIDE_TABLE_IDS,
  active, all, byId, byCode, currencyOf, codeOf, currencyMap, codeMap, idByCode,
  isWideTableMp, wideTableOnly, isCaMp, codesForBrand, codeForAsin, storefrontHost,
};
