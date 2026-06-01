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
node server.js    # production
npm run dev       # nodemon
```
`http://localhost:3000` — auth bypassed locally when `AUTH_USERNAME`/`AUTH_PASSWORD` unset.

## Key API Routes
```
GET  /api/brands?preset=last30d     brands + merged metrics
GET  /api/preset-metrics            all preset data
POST /api/sync                      full SP-API sync (~10 min, non-blocking)
GET  /api/sync/status               poll sync progress
GET  /api/health                    listing health (buybox, stranded, unfulfillable)
POST /api/health/digest             fire Slack digest on-demand
GET  /api/fx                        FX rate USD↔CAD (cached 24h)
PUT  /api/brands/:id/asins/:asin/buy-cost
POST /api/brands/:id/asins/bulk-move
POST /api/patch-ad-spend
```

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
Hosted on **Render** — https://rmc-brand-dashboard-1.onrender.com
Plan: Starter ($7/month). Auto-deploys on push to `main`.

```bash
# Deploy = just push to GitHub:
git push origin main
# Render picks it up automatically — live in ~60 seconds.
```

VPS (legacy, 144.172.97.243) — no longer primary. Keep for reference only.
