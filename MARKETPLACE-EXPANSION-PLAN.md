# Marketplace Expansion Plan — Amazon UK + Walmart.ca

*Researched 2026-08-07. Blueprint for the build sessions. Companion code:
[sync/marketplaces.js](sync/marketplaces.js) (registry, not yet wired in).*

## The one architecture decision that matters

Stop adding currency-suffixed columns. Ride `daily_metrics_mp`.

The app today is two-currency to its bones: ~1,050 lines across ~45 files
assume exactly CAD+USD / CA+US (~346 of them in server.js). The
column-per-currency approach (`revenue_cad`/`revenue_usd`) **cannot represent
Walmart.ca at all** — it's a second CAD marketplace, indistinguishable from
Amazon.ca in currency-suffixed columns. UK could technically be bolted on with
`_gbp` columns, but that digs the hole deeper right before Walmart makes it
impossible.

`daily_metrics_mp` (sql/daily-metrics-mp.sql) was built for exactly this and
needs **zero DDL changes**: PK `(date, asin, mp_id)`, currency stored as an
attribute, no CHECK constraints, header comment already anticipates
`walmart_ca`. It's at step 1 of its documented expand→migrate→contract plan:
double-writes flow in, but **no reader uses it yet**. The expansion IS the
migration:

1. **New marketplaces write only to `daily_metrics_mp`** (never touch the wide
   table — no new columns, ever).
2. **Readers move to `daily_metrics_mp`**, starting with the central
   aggregator `buildBrandMetricsForRange` (server.js:3139), then
   yesterday/today endpoints and report datasets. Wide table keeps CA/US
   history until cutover, then becomes legacy.
3. `daily_fees` is the worst-shaped table (12 of 14 columns currency-suffixed,
   PK is `date` alone) → new table `daily_fees_mp(date, mp_id, currency,
   fees, service_fees, refund_amount, refund_fees, refund_count, ad_spend,
   breakdown jsonb)`, backfill CA/US from existing columns, point the
   financials block (server.js:3389) at it.

Amazon mp_ids are raw SP-API ids (matches `sns_daily`/`sku_prices`);
Walmart is `walmart_ca`. UK = `A1F83G8C2ARO7P`.

## What Mike must obtain (blocking, do first)

**Amazon UK** — same SP-API app, but authorizations are REGION-SCOPED:
- EU refresh token: Seller Central UK → Apps and Services → Develop Apps →
  Authorize app. Merged global accounts show a separate Authorize button per
  region; each click issues a distinct refresh token. Store as
  `SP_API_REFRESH_TOKEN_EU`.
- Ads: same LWA client creds work across regions, but the UK profile id must
  be fetched from `advertising-api-eu.amazon.com` `/v2/profiles`
  (`ADS_PROFILE_UK`). Existing ads refresh token *should* work if the UK ads
  account is under the same Amazon login — verify; separate login = new grant.

**Walmart.ca** — must use the **Global (Unified) Marketplace APIs** (legacy CA
XML APIs' migration deadline was 2026-07-31 — already passed):
- Client ID/Secret from developer.walmart.com → API Keys (sign in with the
  Walmart Canada Seller Center account). `WALMART_CLIENT_ID/_SECRET`.
- Token: `POST marketplace.walmartapis.com/v3/token`, `client_credentials`
  grant, `WM_MARKET: ca` header, **15-minute TTL** (re-mint, no refresh token).
- Sandbox exists (`sandbox.walmartapis.com`, separate creds) — useful first.

## Key external facts

**Amazon UK (SP-API region `eu`, host `sellingpartnerapi-eu.amazon.com`):**
- Full API parity: Orders, S&T report (3 req/5 min), FBA Inventory, Finances
  (GBP amounts), Listings, Replenishment/S&S (UK supported), Brand Analytics
  repeat-purchase (UK supported, needs Brand Registry UK).
- Rate-limit pools are per app×seller-account pair → EU gets its own bucket.
- **VAT is the data trap:** UK `ItemPrice`/`OrderTotal` are VAT-INCLUSIVE
  (NA excludes tax). Net = ItemPrice − ItemTax, but ItemTax population varies
  with VCS enrollment / deemed-reseller status (Canadian-established seller =
  Amazon collects VAT on most consumer orders since 2021). **Sample real UK
  order payloads before hardcoding revenue normalization** — else UK revenue
  reads ~20% high vs everything else, and vs Sellerboard.

**Walmart.ca (Global APIs, JSON, base `marketplace.walmartapis.com` +
`WM_MARKET: ca`):**
- Available: Items, Inventory, Orders, Prices, Promotions, Feeds, On-Request
  Reports (async, 15–45 min bake). WFS exists in Canada (API coverage for CA:
  verify).
- **No Sales & Traffic equivalent** — no sessions/page-views. Dashboard tiles
  that assume sessions must degrade to "—" for Walmart.
- **No seller-direct ads API for CA** — Walmart Connect CA is partner-gated
  (Ad Center + approved API partners only). Plan: no Walmart ad spend in the
  app; leave the hook for a manual/CSV import later.
- Orders pagination: cursor expires ~2 min; offset caps at 1000. Feeds/reports
  async. Walmart itemId ↔ SKU ↔ GTIN mapping table needed (no ASINs).
- Rate limits: token-bucket per seller, honor `x-next-replenish-time` on 429.

## Build phases

**Phase 1 — plumbing (no new data yet):**
- Wire `sync/marketplaces.js` as the single source of truth; delete the 7
  duplicate `MARKETPLACE_CURRENCY`/`MP_CODE` maps (amazon.js, backfill.js,
  reconcile.js, repeatPurchase.js, listingContent.js, priceCache.js,
  metricsMp.js).
- `spRequest()` (sync/amazon.js:80) becomes region-aware: host + refresh
  token chosen per marketplace's region; per-region access-token cache.
  Same for ads host selection (sync/ads.js:10).
- Kill silent-drop traps: `getFinancialSummary` drops unknown currencies
  (amazon.js:568 etc.), `|| 'USD'` mis-buckets (amazon.js:722,
  backfill.js:127), `brandMarketplaces()` whitelist silently returns [] for
  unknown codes (repeatPurchase.js:101). Make them log/throw instead.
- `daily_fees_mp` migration + backfill from existing columns.
- Drop the two `CHECK (profile in ('CA','US'))` constraints
  (ads_search_terms, ads_campaign_snapshot) → plain text.

**Phase 2 — Amazon UK live:**
- Add UK to registry (active: true), EU creds to .env/Render.
- Orders/S&T/inventory/finances/S&S/ads sync loops pick up UK via the
  registry; all UK rows → `daily_metrics_mp` + `daily_fees_mp` only.
- VAT normalization decided from sampled orders (Phase 2 gate).
- Readers migrate: buildBrandMetricsForRange → mp tables (CA/US read from mp
  double-writes going forward; historical wide data merged or backfilled).
- Reconcile + integrity checks extended to UK (S&T comparison works there).

**Phase 3 — frontend:**
- Separate the two concepts the UI currently conflates: a **marketplace
  filter** (which marketplaces am I looking at: All / CA / US / UK / WMT) and
  a **display currency** (CAD default, FX-converted). Today's CAD/USD toggle
  is really a display-currency switch; keep it, add the filter beside it.
- `fmtC` gains GBP (£); FX table gains GBP (fetchFxRate reads only CAD today,
  server.js:281; audit/checks.js:47 hardcodes 1.38 — fix).
- ASIN performance tables: per-marketplace revenue columns driven by the
  registry + presence detection (generalize showCad/showUsd booleans,
  report-render.js:482).
- Marketplace badges: products.html:488 pattern (has grey fallback) is the
  model; storefront-URL ternaries (11 spots) move to registry `storefront`.
- Brand cards, reporting page, master sheets Ads tab (fixed 12-column CA/US
  layout, masterSheets.js:170) get UK columns.

**Phase 4 — Walmart.ca:**
- New module `sync/walmart.js`: token mint (15-min TTL), orders pull →
  `daily_metrics_mp` rows (`mp_id='walmart_ca'`, currency CAD), inventory,
  item mapping table `walmart_items(sku, item_id, gtin, asin_hint)`.
- Brands get `walmart_ca` in `brand.marketplace`; ASINs don't exist — decide
  keying: reuse `asin` column with SKU/GTIN for Walmart rows (mp table's
  `asin` is just text) vs a mapping to existing ASINs where the product is
  the same physical item (recommended: map to ASIN where possible so brand
  cards aggregate; fall back to SKU).
- No sessions, no ads: tiles degrade to "—" (the no-data pattern from AOV).
- Health/digest: Walmart has no buybox-loss feed equivalent in v1 — out of
  scope initially.

## New env vars

```
SP_API_REFRESH_TOKEN_EU=      # from Seller Central UK authorize
ADS_PROFILE_UK=               # from EU /v2/profiles
WALMART_CLIENT_ID=
WALMART_CLIENT_SECRET=
```
(Hosts live in the registry, not env. Render: add via dashboard, sync:false.)

## Open questions for Mike

1. UK account: is it merged with the NA account (single global login)? Decides
   the auth path (per-region Authorize button vs full OAuth flow).
2. UK brands: which brands launch there, and do any have Brand Registry UK
   (gates repeat-purchase data)?
3. Walmart fulfillment: WFS or seller-fulfilled? (Changes inventory sync scope.)
4. Reporting currency: keep CAD as the blended default with GBP converted in?
   (Recommended — Sellerboard-style single home currency.)
5. Sellerboard: does it cover the UK account/Walmart? Decides what we reconcile
   against for accuracy parity.
