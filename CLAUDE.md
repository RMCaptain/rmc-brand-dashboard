# CLAUDE.md — RMC Brand Dashboard

## Who I Am

**Name:** Mike Sieben
**Role:** CEO, Rocky Mountain Co. (RMC)
**Context:** Amazon growth partner for brands. This dashboard is an internal tool for tracking brand performance across Amazon CA and US marketplaces.

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
- **No daily auto-sync**: Sync is manual only. A scheduled 6am sync hasn't been built yet.
- **Brand rename**: Admin UI doesn't support renaming brands yet.
- **Revenue accuracy**: S&T report revenue is "ordered product sales" — matches Sellerboard within ~$2 once all ASINs are assigned.

---

## Environment Variables (`.env`)

```
SP_API_CLIENT_ID=
SP_API_CLIENT_SECRET=
SP_API_REFRESH_TOKEN=
SP_API_MARKETPLACE_IDS=A2EUQ1WTGCTBG2,ATVPDKIKX0DER
PORT=3000
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
