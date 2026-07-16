# ARCHITECTURE.md — RMC Brand Dashboard

> Deep technical reference. Load this when making code changes, not for routine queries.
> For essentials (routes, env vars, Slack format) → [CLAUDE.md](CLAUDE.md)

## Stack

- **Backend:** Node.js + Express (`server.js`) — all API routes in one file
- **Data store:** Supabase (Postgres). All reads/writes via `loadBrands()` / `saveBrands()` / `loadPresetMetrics()` in `server.js`. `data/` files are legacy/cache only — not source of truth.
- **SP-API sync:** `sync/amazon.js` — S&T reports, listings, inventory, catalog, buybox scraping, stranded inventory
- **Ads sync:** `sync/ads.js` — Amazon Advertising API (Sponsored Products). Separate OAuth from SP-API.
- **Slack:** `slack/digest.js` — daily health digest via Incoming Webhook
- **Frontend:** Vanilla HTML/JS + Tailwind CSS (`public/`). No build step.

## Pages (`public/`)

| File | Purpose |
|------|---------|
| `index.html` | Revenue summary across all brands |
| `brands.html` | Brand grid — Performance / Mapping / Health views |
| `brand.html` | Single brand detail |
| `products.html` | ASIN-level data, COGS + buy cost entry |
| `po.html` | PO builder — generates Excel purchase orders |
| `admin.html` | ASIN remapping / bulk editor |

## Data Flow

### Sync pipeline (`POST /api/sync`)
1. `syncBrandMetrics(brands)` in `sync/amazon.js`
2. Fetches listings + inventory (cached 4h to avoid quota errors)
3. Requests S&T reports for 6 presets × 2 marketplaces (12 reports total)
4. Waits for all reports, downloads + parses TSV
5. Unknown ASINs → auto-added to "Unknown Brand"
6. Results → Supabase `preset_metrics` table
7. `enrichListingHealth()` runs after: buybox owners, listing snapshots, stranded inventory
8. `backgroundUpdateFinancials()` merges ad spend into preset metrics — merge logic, NOT full replace (full replace was zeroing adSpend — fixed)

**Date presets:** Yesterday · Last 7 Days · Last 14 Days · Last 30 Days · This Month · Last Month

### Ads sync (`sync/ads.js`)
- Separate OAuth from SP-API — uses `ADS_*` env vars
- Pulls ASIN-level: spend, attributed sales, ACOS, clicks, impressions
- Results stored in `brand.adSummary` per preset

### Listing health (`GET /api/health`)
- `computeHealthReport()` in `server.js`
- Reads: `brand.buyBoxOwnerHistory`, `brand.listingSnapshots`, `brand.recentAlerts`, `brand.strandedInventory`
- **Critical:** suppressed / restricted / stranded
- **Warning:** buybox_lost / unfulfillable / inactive+stock
- **Ignored:** incomplete listings, inactive+OOS (expected state)
- Stranded inventory pulled via `GET_STRANDED_INVENTORY_UI_DATA` SP-API report

## Currency Handling

- CA marketplace (`A2EUQ1WTGCTBG2`) = CAD
- US marketplace (`ATVPDKIKX0DER`) = USD
- Revenue stored as `revenueCad` / `revenueUsd` everywhere — never mixed
- Frontend `fmt(cad, usd)` converts using live FX rate
- CA$/US$ toggle in nav, persisted in `localStorage`

## Buy Cost vs COGS

Two separate price fields per ASIN:
- `brand.buyCost[asin]` — supplier invoice price; used in PO builder
- `brand.cogsPerMarketplace[asin].CA/US` — all-in landed cost (buy cost + shipping + prep); used in performance metrics
- Multipacks: base ASIN buy cost · Bundles: sum of components (or manual override)

## Authentication

HTTP Basic Auth gates the entire app. Bypassed locally when env vars are unset.
Values with `#` must be quoted in `.env` — unquoted `#` is a comment delimiter in dotenv.

**Roadmap:**
1. **Cloudflare Access** — Google SSO for internal team. Free ≤50 users, ~15 min setup after DNS is live.
2. **Supabase Auth** — per-brand logins for client portal (Phase 3). Coexists with Cloudflare Access.

## Known Issues

| Issue | Detail |
|-------|--------|
| Unknown Brand ASINs | Auto-land after sync — remap via `admin.html` |
| Duplicate brands | e.g. "Jarrow" / "Jarrow Formulas" from Catalog API inconsistency — merge via admin |
| Brand rename | Not supported in Admin UI yet |
| Seller name scraping | `scrapeSellerNames()` uses Puppeteer; names cache in Supabase `po_settings` under key `seller_names` — raw IDs show until scraped |
| Stranded inventory | Only populates after a full sync that calls `fetchStrandedInventory()` |
