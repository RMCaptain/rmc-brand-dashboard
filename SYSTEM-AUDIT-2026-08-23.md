# Full-System Audit — 2026-08-23

Four parallel code reviews (frontend, API layer, sync pipeline, security) plus a
runtime verification pass (endpoint sweep, migration probes, integrity checks,
sales/traffic/ads validators, render harnesses). ~60 findings; the serious ones
fixed in four commits: `34a5e69` (server), `35665d7` (sync), `6ef5689`
(security), `f91292b` (frontend). This file records what was NOT fixed and why,
plus the multi-marketplace Phase-2 checklist. Triage into the Notion Build Log.

## Needs Mike (can't be closed from the repo)

1. ~~**MCP token rotation (HIGH).**~~ **DONE 2026-08-24**: token rotated via
   Render env + claude.ai connector, code fallback removed (`dc458a8`),
   verified old token 401s and new token 200s on both hosts.
2. **Promotions API — PARKED, unfixable for this app (2026-08-24).** The
   Promotions API v2021-06-01 returns 403 and Amazon's seller-application role
   list contains NO role that maps to it — the app's roles checklist has no
   Promotions checkbox and none of the 12 grantable roles covers the API. No
   portal navigation, role edit, or refresh-token re-auth can clear the 403;
   do not re-attempt. SP_API_REFRESH_TOKEN was left untouched (still valid).
   The code-side envelope bug is fixed and the keep-previous guard is in place,
   so the Promos column simply shows — with zero operational impact.
   **Viable alternative if wanted:** rebuild promo badges on
   GET_PROMOTION_PERFORMANCE_REPORT (Reports API), covered by the Selling
   Partner Insights role the app already has — a normal report-sync build.
3. **Team data mapping** (integrity checks, recurring): 8 unmapped ASINs carry
   ~$2.5k/30d revenue (top: B0GLZ1448F $1,335); ~6 bundle/set SKUs carry
   ~$930/7d of fees unattributed; COGS gaps: big-league-chew 57%, viva 75%,
   trimax 89%, zest + general-wholesale 0%.
4. **Optional:** run `sql/drop-ntb-columns.sql` (dead columns); configure
   `RESEND_API_KEY` before real portal onboarding (Mike deferred 2026-08-23).
   ~~PORTAL_BASE_URL~~ + ~~DATABASE_URL (Render)~~ **DONE 2026-08-24** — boot
   migrations verified live on deploy. This laptop's .env still lacks
   DATABASE_URL; the OTHER machine's .env now holds the OLD (reset) Supabase
   db password — both need the new value. Anything else holding the old db
   password (psql configs, n8n, teammates) is broken until updated.

## Known-open (deliberately deferred, roughly by priority)

- **TEAM_BASIC_AUTH=off would break three internal callers** that still send
  Basic: the MCP bridge, the AI-summary loopback fetch, and the PDF renderer.
  Refactor them to an internal token before ever flipping it.
- **Ads wide-vs-mp asymmetry:** the ads path zeros the mp mirror per day but
  never clears stale wide-table ad columns; `attributed_sales` isn't in the
  `mp_mirror` integrity comparison, so its drift is invisible. The wide/mp row
  filters also disagree (sales-only attribution days).
- **Preset rebuild carries dormant brands forward** from the previous cache
  with no staleness marker ("no data" renders as "last known data").
- **Report fee fallback emits $0 instead of null** for ranges with no
  daily_fees coverage (now only pre-2026 ranges, since the backfill reaches
  2025-12-31).
- **audit/checks.js** caps day-shape reads at 5000 unordered rows and
  hardcodes FX 1.38 — audit accuracy only, no data writes.
- **Cron overlaps remaining:** AdsDaily-30d (9:10) can still overrun the 2-h
  ads refresh (10:20); DailyFees + image backfill share 10:00. The worst
  (3 jobs at 9:00) was restaggered to 9:00/9:40/9:50.
- **brands-blob short-window writers** are still last-write-wins (~ms races);
  the minutes-long windows (UPC scrape, health enrichment) now merge-on-fresh.
- **Security posture (lower):** global CORS `*` (harmless for cookie routes,
  compounds the MCP token issue), no CSP/SRI on CDN scripts,
  `data/brands.json` + `data/preset-metrics.json` tracked in git,
  `render.yaml` missing the security-relevant env vars, `/api/team/*` handlers
  unguarded pre-gate async, auth gate 302s HTML to API callers.
- Minor: `daily_brand_ads` delete+insert not atomic across overlapping ads
  runs; adsSearchTerms partial-insert on mid-loop failure; seller-names scrape
  overlap; `appendAuditEntry` read-modify-write race; MCP `list_brands` asks
  for preset `30d` (invalid key, currently harmless).

## Multi-marketplace Phase 2 — hardcoded CA/US map (must fix before activating UK/Walmart)

Every site below assumes CAD→CA / USD→US or `!== CA ⇒ US`. Activating UK (GBP)
or Walmart.ca (CAD — collides with Amazon.ca!) mis-buckets silently:

| Site | Issue |
|---|---|
| `sync/orders.js` (isCA by mp id; ~71/183, 531-544) | GBP revenue would sum into USD columns; UK Pending never priced. **Authoritative revenue writer — highest priority.** |
| `sync/refunds.js` (~211/220) | UK refunds stamped USD. |
| `sync/dailyFees.js` (currency→mp; mpRow CA/US only) | **Walmart.ca fees would attribute to Amazon.ca rows** (same currency). Third marketplace never gets an mp row → fees_asin check fails. |
| `sync/priceCache.js` (~100) | UK prices keyed US|sku → wrong USD estimates. |
| `sync/metricsMp.js` constants | CA/US only. (`replaceDay` now scoped `.in('mp_id', [CA,US])` — fixed.) |
| `sync/amazon.js` health/S&S/stranded (~1684-1690, 1846, 1945) | `marketplace === 'US' ? US : CA` — **live bug today: a 'CA,US' brand only gets CA health checks.** UK S&S revenue into .usd. |
| `sync/repeatPurchase.js` (~81) | GBP repeat revenue into Usd. |
| `sync/listingContent.js` (MP_ID CA/US, fallback CA) | UK SKUs fetched against CA → 404 → null content. |
| `public/report-render.js` headline tiles | Currency-keyed revenue tiles collapse amazon_ca + walmart_ca. |
| Model to follow | `sync/reconcile.js` / `sync/backfill.js` — registry `currencyMap()` + explicit non-CAD/USD guard. |

Also required for Phase 2: readers migrate to `daily_metrics_mp` (plan doc),
EU credentials (`SP_API_*_EU`), UK ads profile env.

## Verified healthy (runtime, 2026-08-23)

Endpoints 20/20 · migrations 29/29 feature probes · PO-lines projection
zero-drift · integrity checks: no pipeline failures (only mapping-debt warns) ·
sales validator: all consistency checks pass, all 12 brands · traffic: both
aggregation paths agree exactly · ads: per-SKU sums = brand summaries to the
penny · render harnesses: 9/9 dashboard paths + 6/6 brand/products paths ·
fee backfill complete 2025-12-31 → present, per-ASIN sums reconcile to
account-level fees exactly.
