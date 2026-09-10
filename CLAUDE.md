# CLAUDE.md — RMC Brand Dashboard

## Context
Internal tool for Rocky Mountain Co. — tracks Amazon brand performance across CA + US marketplaces.
RMC accelerator model: buys inventory wholesale, resells on Amazon.
Deep technical detail → [ARCHITECTURE.md](ARCHITECTURE.md) | Backlog → [BACKLOG.md](BACKLOG.md)

## Operating Mode
Direct, concise, no filler. Draft first, never send. 2–3 options on decisions. Ask before guessing.
No emojis, no hype, no summaries of what you just did.

## Run
```bash
npm install
node server.js          # production
npm run dev             # nodemon
npm run test:marketplace  # no-DB regression suite: resolver, Sellerboard parser, /api/metrics, every page under All/CA/US/UK
```
`http://localhost:3000` — auth bypassed locally when `AUTH_USERNAME`/`AUTH_PASSWORD` unset.

## Marketplaces (registry-driven, Sellerboard first)
`sync/marketplaces.js` is the only place a marketplace is defined. Every range
payload (`buildBrandMetricsForRange`) carries `byMp` per sku / brand summary /
financials: native-currency slice per marketplace with `source`
(sellerboard | amazon | mixed) and `flags`. `sync/metricsResolver.js` picks
Sellerboard per marketplace-day where it has rows, Amazon otherwise. Legacy
`revenueCad/Usd` fields are the CA/US slices of the same resolution. The
global picker (`public/mp-scope.js`, localStorage `mpFilter`) scopes every
page; every view is FX-converted into the CAD/USD toggle's currency via
`fx.toCad`. Reconciliation flags are internal only (ledger + integrity
check), never shown in the UI. Traffic (sessions, buy box) and inventory stay Amazon-only;
Today/Yesterday endpoints are still Amazon-only.

## Key API Routes
```
GET  /api/brands?preset=last30d     brands + merged metrics
GET  /api/preset-metrics            all preset data
POST /api/sync                      full SP-API sync (~10 min, non-blocking)
GET  /api/sync/status               poll sync progress
GET  /api/brand-ads/:brandId        SP+SB+SD rollup + TACOS (?from&to, default 30d)
GET  /api/health                    listing health (buybox, stranded, unfulfillable)
POST /api/health/digest             fire Slack digest on-demand
GET  /api/fx                        FX rate USD↔CAD (cached 24h)
PUT  /api/brands/:id/asins/:asin/buy-cost
POST /api/brands/:id/asins/bulk-move
POST /api/patch-ad-spend
POST /api/sellerboard/sync          fetch Sellerboard feed CSVs + reconcile (cron 10:45/12:45 UTC)
GET  /api/reconciliation            Amazon vs Sellerboard ledger (?from&to&scope&mp&status)
```

## Sellerboard (external reference)
Sellerboard is the source of truth for money metrics; Amazon APIs feed the
dashboard and get reconciled against it nightly (`sync/sellerboard.js` →
`sellerboard_daily`, `sync/reconcileSellerboard.js` → `metric_reconciliation`).
Feeds are Sellerboard **Settings → Automation** Product Dashboard CSV links,
one per Sellerboard account, env-only (`SELLERBOARD_FEED_RMC|WMCA|INTL`).
Tolerance: money max($25, 1%), counts max(2, 1%); fees and refunds 10%
(Sellerboard books them to the order day, Amazon posts a day or two later).
The `account_7d` scope is the alert signal. Feeds arrive in the Sellerboard
**account** currency (RMC = USD, even for Amazon.ca) and are converted to
each marketplace's native currency at ingest (`sync/fxRates.js`, `fx_rates`
table). Feed days are the marketplace's local (PST) day, not UTC. Traffic
(sessions/buy box) stays Amazon-first and is not reconciled.

## Cron Schedule (VPS)
- 6am, 9am, 12pm UTC — full SP-API sync
- 7am UTC — Slack health digest (independent of sync)

## Environment Variables
```
SP_API_CLIENT_ID, SP_API_CLIENT_SECRET, SP_API_REFRESH_TOKEN
SP_API_SELLER_ID, SP_API_MARKETPLACE_IDS=A2EUQ1WTGCTBG2,ATVPDKIKX0DER
ADS_CLIENT_ID, ADS_CLIENT_SECRET, ADS_REFRESH_TOKEN, ADS_PROFILE_CA, ADS_PROFILE_US
SUPABASE_URL, SUPABASE_SERVICE_KEY
AUTH_USERNAME, AUTH_PASSWORD   # VPS only — unset locally to bypass; quote values with #
SLACK_WEBHOOK_URL
SELLERBOARD_FEED_RMC, SELLERBOARD_FEED_WMCA, SELLERBOARD_FEED_INTL   # Automation CSV links — the URL is the secret
DASHBOARD_URL=https://dashboard.rockymountainco.ca/brands.html
SYNC_ENABLED=true              # false locally to avoid burning API quota
PORT=3000
```

## Slack Health Digest Format — LOCKED
**Never deviate. Use for live webhooks AND in-chat examples.**

```
RMC LISTING HEALTH REPORT
0 Critical  |  62 Warnings  |  8 Brands Affected

Brand Name — N warnings

• Buybox lost on [Short Product Name] → Seller Name (FBA) @ $price
• Recurring buybox winners: Seller A (N ASINs), Seller B (N ASINs)
• Non-FBA outliers: Seller X, Seller Y — likely grey market / dropship
• N unfulfillable units across N SKUs (qty range each)

Key patterns:
• [Recurring cross-brand seller] winning buybox on N ASINs across N brands — flag to brand
• Unfulfillable units are noise — all small quantities, typical FBA returns cycle
```

Rules: group unfulfillables per brand (never list individually) · condense recurring sellers (3+ ASINs) ·
always show price on buybox losses · non-FBA = grey market · key patterns at bottom · criticals first then alpha.
Implementation: `slack/digest.js` → `buildHealthDigestBlocks()` / `buildBrandLines()`

## Git Workflow
```bash
git add . && git commit -m "description" && git push   # end of session
git pull                                                # start on new machine
```
Repo: https://github.com/RMCaptain/rmc-brand-dashboard

## Deploy
Hosted on **Render**. Primary URL: **https://app.rockymountainco.ca** (custom domain).
Render origin still active: https://rmc-brand-dashboard-1.onrender.com (old bookmarks keep working).
Plan: Starter ($7/month). Auto-deploys on push to `main`.
`DASHBOARD_URL` env var (Render, sync:false) → `https://app.rockymountainco.ca/brands.html` — used for the Slack digest link.

```bash
# Deploy = just push to GitHub:
git push origin main
# Render picks it up automatically — live in ~60 seconds.
```

VPS (legacy, 144.172.97.243) — no longer primary. Keep for reference only.
