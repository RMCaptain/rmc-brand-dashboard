# CLAUDE.md — RMC Brand Dashboard

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

## What This Project Is

An internal Amazon brand performance dashboard built with Node.js + Express. Pulls data from Amazon SP-API and displays it in a clean web UI.

**Stack:**
- Backend: Node.js + Express (`server.js`)
- Amazon integration: `sync/amazon.js` (SP-API)
- Frontend: Vanilla HTML/JS with Tailwind CSS (`public/`)
- Data storage: JSON files in `data/`
- No database — file-based

**To run:**
```
npm install
node server.js
```
Then open `http://localhost:3000`

---

## Architecture

### Data Files (`data/`)
- `brands.json` — brand definitions + ASIN assignments (source of truth)
- `preset-metrics.json` — synced S&T metrics for all date range presets
- `fx.json` — FX rate cache (auto-generated, not committed)
- `listings-cache.json` — listings report cache (auto-generated, not committed)

### Key Files
- `server.js` — Express API server, all routes
- `sync/amazon.js` — SP-API sync logic (S&T reports, listings, inventory, catalog)
- `public/index.html` — main dashboard
- `public/brand.html` — brand detail page
- `public/admin.html` — ASIN remapping / bulk editor

### API Routes
- `GET /api/brands` — brands with merged preset metrics (`?preset=last7d`)
- `GET /api/brands/:id` — single brand
- `GET /api/preset-metrics` — all preset data for client-side date switching
- `POST /api/sync` — triggers full SP-API sync (takes 5-10 min)
- `GET /api/fx` — FX rate (USD↔CAD, cached 24h)
- `POST /api/import/all` — import brands/ASINs from Amazon
- `POST /api/brands/:id/asins/bulk-move` — bulk ASIN reassignment

---

## How the Sync Works

1. `POST /api/sync` triggers `syncBrandMetrics(brands)` in `sync/amazon.js`
2. Fetches listings + inventory (cached 4h to avoid quota errors)
3. Requests S&T reports for 6 date presets × 2 marketplaces simultaneously
4. Waits for all 12 reports, downloads + parses them
5. Any S&T ASINs not in any brand → auto-added to "Unknown Brand"
6. Results saved to `data/preset-metrics.json`
7. Updated brands saved to `data/brands.json`

**Date presets:** Yesterday, Last 7 Days, Last 14 Days, Last 30 Days, This Month, Last Month

---

## Currency Handling

- CA marketplace (A2EUQ1WTGCTBG2) = CAD
- US marketplace (ATVPDKIKX0DER) = USD
- Revenue stored separately as `revenueCad` and `revenueUsd` everywhere
- Frontend `fmt(cad, usd)` function converts to selected currency using live FX rate
- CA$/US$ toggle in nav, persisted in localStorage

---

## Known Issues / Pending Work

- **Unknown Brand ASINs**: Many ASINs auto-land in Unknown Brand after sync. They need manual remapping via `admin.html`.
- **Duplicate brands**: Some brands appear twice (e.g. "Jarrow" and "Jarrow Formulas") due to Amazon Catalog API inconsistency. Needs manual merge via admin.
- **Brand rename**: Admin UI doesn't support renaming brands yet.
- **Revenue accuracy**: S&T report revenue is "ordered product sales" — matches Sellerboard within ~$2 once all ASINs are assigned.

---

## Authentication

The dashboard is gated by **HTTP Basic Auth** (single shared credential). Credentials are set via
`AUTH_USERNAME` / `AUTH_PASSWORD` env vars on the VPS only — NOT committed to git.

If these env vars are unset (local dev), auth is bypassed.

**Important:** values with special chars (e.g. `#`) MUST be quoted in `.env`:
```
AUTH_USERNAME="Admin"
AUTH_PASSWORD="my#pass"
```
Unquoted `#` is parsed as a comment delimiter by dotenv.

### Auth roadmap

This basic auth is a temporary plug. Two upgrades planned:

1. **Cloudflare Access (internal team SSO)** — proper auth for the team via Google SSO.
   Requires pointing `dashboard.rockymountainco.ca` (or similar subdomain) at the VPS through
   Cloudflare, then configuring an Access Application. Replaces Basic Auth for internal users.
   Free for up to 50 users. Setup is ~15 min in the Cloudflare console after DNS propagates.

2. **Supabase Auth (external brand portal)** — per-brand logins for client portal (#4 on roadmap).
   Supabase is already in the stack; use its built-in email/password + magic link auth.
   Role-based filtering so each brand only sees their own data.

Both auth systems can coexist: Cloudflare Access for `/admin` or root paths (internal),
Supabase Auth for `/portal/*` (external brand users). Mirrors how Stripe / GitHub split
internal vs customer access.

---

## Build Roadmap

Features to build next, in priority order. Pick up from the top.

### 1. Listing Health Monitor
Daily scan across all ASINs. Flags:
- Suppressed listings
- Buybox losses
- Price drops below threshold
- Review score/count changes
One consolidated alert instead of manually checking Seller Central per brand.

### 2. Bundle / Multipack Opportunity Finder
Surfaces ASIN candidates for bundles or multipacks using 4 signals:
- High unit velocity (30+ units/month = multipack candidate)
- ASINs frequently appearing together in order data
- PPC search terms containing "pack", "set", "bundle", "2 pack", "value"
- Competitor catalog gaps (they have a multipack, we don't)
Recommendation output explains which signals triggered each recommendation.

### 3. Monthly Client Brand Report
Auto-generated monthly report for brand partners (one report per brand):
- Revenue, units, ad performance, inventory status, highlights
- Polished, client-facing format
- Brand manager reviews and approves before it goes out

### 4. Client-Facing Brand Portal
Read-only dashboard view for brand partners — their numbers, POs, inventory.
Requires client logins and filters on what they can see.
Long-term replaces the manual monthly report entirely.

### 5. Review Velocity Tracker
Daily scrape of review count + rating per ASIN. Stores snapshots over time.
Alerts on: sudden count drops, rating decline, or plateaus where a review push would help.
Note: scraping-based since SP-API doesn't expose review history.

### 6. Event/Promo Calendar Agent
Tracks upcoming Amazon events (Prime Day, BFCM, etc.) and auto-generates a per-brand prep checklist:
- Which ASINs to coupon
- Inventory targets
- Creative deadlines
Connects awareness of events to concrete action items per brand.

### 7. PPC + SEO Keyword Gap Tool
Pull converting PPC keywords per ASIN, cross-reference against backend search terms.
Flag keywords converting in ads but not indexed organically — highest-leverage SEO fixes.
Currently done manually and gets missed.

### 8. A+ Content / Listing Asset Tracker
Yes/no matrix per ASIN tracking which assets exist:
- Main images, lifestyle images, A+ content, video, brand story
Flags ASINs missing assets so the team has a prioritized list vs. guessing.

### 9. Internal Weekly Brand Manager Report
Auto-generated weekly report per brand manager covering all their brands:
- Metrics, flags, wins, action items
- Built after Asset Tracker so all data points are available
- Brand manager reviews before acting, not sent automatically

### 10. Brand Onboarding Checklist
When a new brand is signed — auto-generate the full onboarding task list in Notion:
catalog audit, listing rewrites, backend SEO, PPC setup, inventory order.
Same checklist every time, nothing missed.

---

## Environment Variables (`.env`)

```
SP_API_CLIENT_ID=
SP_API_CLIENT_SECRET=
SP_API_REFRESH_TOKEN=
SP_API_MARKETPLACE_IDS=A2EUQ1WTGCTBG2,ATVPDKIKX0DER
PORT=3000

# Auth (VPS only — unset locally to bypass). Quote any value containing # or other special chars.
AUTH_USERNAME="Admin"
AUTH_PASSWORD="your-password-here"

# Daily sync gate — true on VPS, false locally to avoid burning Amazon API quota
SYNC_ENABLED=true
```

The `.env` file is NOT committed to GitHub. Copy it manually to each machine.

---

## Git Workflow

**End of session:**
```
git add .
git commit -m "description"
git push
```

**Start of session on new machine:**
```
git pull
```

**Repo:** https://github.com/RMCaptain/rmc-brand-dashboard
