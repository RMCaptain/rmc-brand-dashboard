# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Who I Am

**Name:** Mike Sieben
**Role:** CEO, Rocky Mountain Co. (RMC)
**Context:** Amazon growth partner for brands using the **Accelerator model** — RMC buys inventory from brands wholesale and resells on Amazon CA and US. This dashboard is an internal tool for tracking brand performance across both marketplaces.

---

## Operating Mode

1. **Be direct and concise.** Lead with the answer. No preamble, no filler.
2. **Draft first, never send.** Never finalize anything without explicit approval.
3. **Give options, not just answers.** 2–3 options with tradeoffs when there's a decision.
4. **Ask before guessing.** One clear question if intent is unclear.
5. **Check your own work.** Don't hand over something half-done.
6. **No emojis, no hype language, no summaries of what you just did.**

---

## Running the App

```bash
npm install
node server.js        # production
npm run dev           # nodemon (auto-restart on file changes)
```

Open `http://localhost:3000`. Auth is bypassed locally when `AUTH_USERNAME`/`AUTH_PASSWORD` env vars are unset.

---

## Architecture

### Stack
- **Backend:** Node.js + Express (`server.js`) — all API routes in one file
- **Data store:** Supabase (Postgres). All reads/writes go through `loadBrands()` / `saveBrands()` / `loadPresetMetrics()` etc. in `server.js`. No local JSON is the source of truth anymore — `data/` files are legacy/cache only.
- **SP-API sync:** `sync/amazon.js` — S&T reports, listings, inventory, catalog, buybox scraping, stranded inventory
- **Ads sync:** `sync/ads.js` — Amazon Advertising API (Sponsored Products). Separate auth from SP-API.
- **Slack:** `slack/digest.js` — daily health digest posted via Incoming Webhook
- **Frontend:** Vanilla HTML/JS + Tailwind CSS (`public/`). No build step.

### Pages (`public/`)
- `index.html` — main dashboard (revenue summary across all brands)
- `brands.html` — brand grid (Performance / Mapping / Health views)
- `brand.html` — single brand detail
- `products.html` — ASIN-level product data with COGS + buy cost entry
- `po.html` — PO builder (generates Excel purchase orders)
- `admin.html` — ASIN remapping / bulk editor
- `cogs.html` — COGS management

### Key API Routes
- `GET /api/brands?preset=last30d` — brands with merged preset metrics
- `GET /api/preset-metrics` — all preset data (client-side date switching)
- `POST /api/sync` — full SP-API sync (~10 min); non-blocking, returns immediately
- `GET /api/sync/status` — poll sync progress
- `GET /api/health` — listing health report (buybox, suppressed, stranded, unfulfillable)
- `POST /api/health/digest` — fire Slack digest on-demand
- `POST /api/health/scrape-seller-names` — scrape seller display names via Puppeteer
- `GET /api/fx` — FX rate USD↔CAD (cached 24h)
- `PUT /api/brands/:id/asins/:asin/buy-cost` — set supplier buy cost per ASIN
- `POST /api/brands/:id/asins/bulk-move` — bulk ASIN reassignment
- `POST /api/patch-ad-spend` — re-derive adSpend from brand adSummary into preset-metrics

---

## Data Flow

### Sync pipeline (`POST /api/sync`)
1. `syncBrandMetrics(brands)` in `sync/amazon.js`
2. Fetches listings + inventory (cached 4h to avoid quota errors)
3. Requests S&T reports for 6 presets × 2 marketplaces (12 reports total)
4. Waits for all reports, downloads + parses TSV
5. Unknown ASINs → auto-added to "Unknown Brand"
6. Results → Supabase `preset_metrics` table
7. `enrichListingHealth()` runs after: buybox owners, listing snapshots, stranded inventory
8. `backgroundUpdateFinancials()` merges ad spend into preset metrics — uses merge logic, not full replace (bug was fixed: full replace was zeroing adSpend)

**Date presets:** Yesterday, Last 7 Days, Last 14 Days, Last 30 Days, This Month, Last Month

### Ads sync (`sync/ads.js`)
- Separate OAuth from SP-API (uses `ADS_*` env vars, not `SP_API_*`)
- Pulls ASIN-level spend, attributed sales, ACOS, clicks, impressions
- Results stored in `brand.adSummary` per preset

### Listing health (`GET /api/health`)
- `computeHealthReport()` in `server.js`
- Reads `brand.buyBoxOwnerHistory`, `brand.listingSnapshots`, `brand.recentAlerts`, `brand.strandedInventory`
- Alert severity: critical = suppressed/restricted/stranded; warning = buybox_lost/unfulfillable/inactive+stock
- Ignores: incomplete listings, inactive+OOS (expected state)
- Stranded inventory pulled via `GET_STRANDED_INVENTORY_UI_DATA` SP-API report

---

## Currency Handling

- CA marketplace (`A2EUQ1WTGCTBG2`) = CAD
- US marketplace (`ATVPDKIKX0DER`) = USD
- Revenue stored as `revenueCad` / `revenueUsd` everywhere — never mixed
- Frontend `fmt(cad, usd)` converts to selected currency using live FX rate
- CA$/US$ toggle in nav, persisted in `localStorage`

---

## Buy Cost vs COGS

Two separate price fields per ASIN:
- `brand.buyCost[asin]` — supplier invoice price, used in PO builder
- `brand.cogsPerMarketplace[asin].CA/US` — all-in landed cost (buy cost + shipping + prep), used in performance metrics
- Multipacks: use base ASIN buy cost; bundles: sum of component buy costs (or manual override)

---

## Slack Health Digest Format

**Locked format. Use for live webhooks AND in-chat examples. Do not deviate.**

```
RMC LISTING HEALTH REPORT
0 Critical  |  62 Warnings  |  8 Brands Affected

Brand Name — N warnings

• Buybox lost on [Short Product Name] → Seller Name (FBA) @ $price
• Recurring buybox winners: Seller A (N ASINs), Seller B (N ASINs)
• Non-FBA outliers: Seller X, Seller Y — likely grey market / dropship
• N unfulfillable units across N SKUs (qty range each)

Key patterns:
• [Recurring cross-brand seller] is systematically winning the buybox on N ASINs across N brands — worth flagging to the brand
• Unfulfillable units are noise — all small quantities, typical FBA returns cycle
```

**Rules:**
- Group unfulfillables into one line per brand (total qty, SKU count, qty range) — never list individually
- Condense recurring sellers (3+ ASINs) → "Recurring buybox winners: X (N ASINs)"; list isolated losses individually
- Always include price on buybox losses when available
- Non-FBA sellers always flagged as likely grey market / dropship
- Key patterns always at bottom — cross-brand recurring sellers + unfulfillable noise note
- Brands: criticals first, then alphabetical

**Implementation:** `slack/digest.js` → `buildHealthDigestBlocks()`. Per-brand condensed logic in `buildBrandLines()`.

---

## Environment Variables (`.env`)

```
# SP-API
SP_API_CLIENT_ID=
SP_API_CLIENT_SECRET=
SP_API_REFRESH_TOKEN=
SP_API_SELLER_ID=
SP_API_MARKETPLACE_IDS=A2EUQ1WTGCTBG2,ATVPDKIKX0DER

# Advertising API (separate credentials)
ADS_CLIENT_ID=
ADS_CLIENT_SECRET=
ADS_REFRESH_TOKEN=
ADS_PROFILE_CA=
ADS_PROFILE_US=

# Supabase
SUPABASE_URL=
SUPABASE_SERVICE_KEY=

# Auth (VPS only — unset locally to bypass). Quote values containing # or special chars.
AUTH_USERNAME="Admin"
AUTH_PASSWORD="your-password-here"

# Slack
SLACK_WEBHOOK_URL=

# Dashboard URL (used in Slack digest links)
DASHBOARD_URL=https://dashboard.rockymountainco.ca/brands.html

# Sync gate — true on VPS, false locally to avoid burning Amazon API quota
SYNC_ENABLED=true

PORT=3000
```

---

## Authentication

HTTP Basic Auth gates the entire dashboard. Bypassed locally when env vars are unset.
Values with special chars (e.g. `#`) **must** be quoted in `.env` — unquoted `#` is a comment delimiter in dotenv.

**Auth roadmap:**
1. **Cloudflare Access** — Google SSO for internal team via `dashboard.rockymountainco.ca`. Free ≤50 users, ~15 min setup after DNS.
2. **Supabase Auth** — per-brand logins for client portal (roadmap item #4). Coexists with Cloudflare Access.

---

## Cron Schedule (VPS)

- **6am UTC** — full SP-API sync
- **9am UTC** — full SP-API sync
- **12pm UTC** — full SP-API sync
- **7am UTC** — Slack health digest (runs independently of sync)

---

## Known Issues

- **Unknown Brand ASINs** — auto-land after sync; remap via `admin.html`
- **Duplicate brands** — e.g. "Jarrow" / "Jarrow Formulas" from Catalog API inconsistency; merge manually via admin
- **Brand rename** — not supported in Admin UI yet
- **Seller name scraping** — `scrapeSellerNames()` uses Puppeteer; names cache in Supabase `po_settings` table under key `seller_names`. Raw seller IDs show until scraped.
- **Stranded inventory** — only populates after a full sync that calls `fetchStrandedInventory()`

---

## Build Roadmap

In priority order:

1. **Listing Health Monitor** ✅ Built — `GET /api/health`, daily Slack digest
2. **Bundle / Multipack Opportunity Finder** — velocity + co-purchase + PPC signals
3. **Monthly Client Brand Report** — auto-generated, brand manager approves before send
4. **Client-Facing Brand Portal** — read-only per-brand view, Supabase Auth
5. **Review Velocity Tracker** — daily scrape of review count/rating per ASIN
6. **Event/Promo Calendar Agent** — Prime Day / BFCM prep checklist per brand
7. **PPC + SEO Keyword Gap Tool** — converting PPC keywords not indexed organically
8. **A+ Content / Listing Asset Tracker** — yes/no matrix per ASIN
9. **Internal Weekly Brand Manager Report** — per-brand-manager digest
10. **Brand Onboarding Checklist** — auto-generate Notion task list on new brand sign

---

## Git Workflow

```bash
# End of session
git add .
git commit -m "description"
git push

# Start of session on new machine
git pull
```

**Repo:** https://github.com/RMCaptain/rmc-brand-dashboard
