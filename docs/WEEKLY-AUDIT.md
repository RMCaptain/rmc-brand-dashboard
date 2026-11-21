# Weekly App Audit — Runbook

Runs every Sunday evening (scheduled task, fires into Mike's Claude Code
session) and posts a report Mike reads Monday morning. Scope: speed,
data accuracy, new/changed data (brands, ASINs, marketplaces), and
anything that needs Mike's judgement. Fix what is safe under the standing
authorization in CLAUDE.md; flag the rest.

Rules that apply to every audit:
- Soft-test every fix through the real flow before reporting it fixed.
- Prod probes use a short-lived admin session that is ALWAYS deleted at the
  end (the established `Claude diagnostic` pattern). Never leave one behind.
- Compare money against Sellerboard in NATIVE currency per marketplace.
  CAD-vs-CAD against SB's website carries blended-FX noise (CLAUDE.md).
- Never show "Sellerboard" in user-facing UI; reconciliation stays internal.
- No commits of secrets, no model identifiers in pushed artifacts.

## 1. Baseline & health
- `git pull`, `npm install` if node_modules missing, `npm run test:marketplace` must pass.
- `/api/sync/status`: `lastSync` within 24h, `presetRebuild.ok` true,
  `ordersToday.updatedAt` fresh (stale = poller frozen), `spApiRegions`
  (eu=false means UK traffic is still blocked on credentials).
- Boot migrations: every file in `BOOT_MIGRATIONS` applied (spot-check
  new columns exist via a select).
- Cron coverage: Sellerboard feed ingest ran (10:45/12:45 UTC) — latest
  `sellerboard_daily` date per feed/account (RMC, WMCA, INTL) is yesterday
  or day-before. Weekly digest and margin guard posted (or legitimately
  had nothing to post).

## 2. Speed (compare to last week's numbers in the report history)
Time cold and warm, like a browser (gzip): `/api/brands?preset=last30d`,
`/api/preset-metrics`, `/api/metrics` for last month and for a 1-year
custom range, brand page load, PPC page, one PDF export via the real UI
button (playwright click, real download). Baselines on Render Standard
(2026-11-16): brands ~2.5s, last month ~8s, 1-year ~80s cold / <1s warm,
PDF ~22s cold. Flag anything >30% slower; fix if the cause is in code.

## 3. Data accuracy
- Reconciliation ledger (`/api/reconciliation?scope=account_7d` and
  per-brand): any status outside tolerance? Explain or fix.
- Integrity check output (sync/integrityCheck) and margin-guard anomalies
  for the week.
- Spot-check 3 brands last-7d and MTD vs Sellerboard in native currency
  (Sellerboard MCP tools if authorized, else the recon ledger).
- Freshness per table: latest date in `daily_metrics`, `daily_metrics_mp`
  (per marketplace — CA, US, UK once EU creds exist, walmart_ca once fed),
  `sellerboard_daily`, `daily_fees_asin`, `sns_daily`, `fx_rates`.
- Inventory: reserved breakdown populated for yesterday; inventory on-hand
  non-null for active ASINs.
- Traffic: sessions/buy box present per marketplace for yesterday.

## 4. New or changed data — mapping & team usability
- `unknown-brand` bucket: any ASINs with activity this week? Propose the
  brand for each (title/brand-name heuristics, existing brand ASIN lists);
  map confidently obvious ones, flag ambiguous ones for Mike.
- New brands/ASINs added this week: title, image, SKU map, marketplace map,
  UPC, COGS (Sellerboard) present? `/api/cogs-gaps` worklist — anything
  new at the top is a Mike/Sellerboard action item.
- Brands with activity in a marketplace they are not mapped to (e.g. UK
  sales for a CA-only brand) → update `asinMarketplaces` or flag.
- Listing health (`/api/health`): new suppressed/stranded/buy-box-lost
  items; recurring non-FBA sellers across brands.
- Portal: any brand portal user issues (expired invites, failed reports).

## 5. Code & dependencies
- `npm audit --omit=dev` high/critical only; note, don't upgrade blindly.
- BACKLOG.md: anything that became urgent given the week's findings.
- Render: any 5xx in the week's probes; export memory headroom.

## 6. Report format (post in chat, readable Monday morning)
1. One-paragraph verdict: healthy / degraded / broken, and the single most
   important thing.
2. Speed table: this week vs last week.
3. Data accuracy: what matched, what didn't, what was fixed.
4. New & changed: mappings made, items needing Mike.
5. Fixes shipped this audit (commit hashes) — each soft-tested.
6. **Needs Mike** — judgement calls, credentials, Sellerboard entries,
   business decisions. Numbered so he can answer "1 yes, 2 no, 3 later".
7. Watchlist for next week.

Keep it tight. Lead with what changed and what needs a decision; detail
below for whoever wants it.
