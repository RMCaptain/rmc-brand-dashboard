# Master Sheet Ads Sync — Approved Plan (2026-08-04)

> **SUPERSEDED — shipped differently. Source of truth: `sync/masterSheets.js`.**
> The delivered version diverges from this plan on three points:
> 1. **No frozen zone.** The plan assumed the sheet would be the only copy of
>    history older than Amazon's ~90-day ads window. In practice the DB keeps the
>    permanent history (`daily_metrics`, ASIN-level daily since 2026-04-11, with a
>    daily trailing-30d re-pull that self-corrects attribution restatements), so
>    the tabs are read-only projections, **fully rebuilt every run** — disposable.
> 2. **No `master_sheets` DB table.** Brand→spreadsheet mapping is the in-code
>    `BRAND_SHEETS` map in `masterSheets.js`; enablement = sharing the sheet with
>    the service account + adding a row there.
> 3. **Tabs are "Ads (auto)" + "Inventory (auto)"**, not the captured
>    "Ads Performance" workbook format described below.
> The rest (Monday cron, service-account auth, Slack failure alerts) shipped as
> planned. Kept for the format spec + decision history.

## Architecture (settled)

- **Dashboard cron job, not an AI agent.** Runs in this repo on Render.
- **Schedule:** Mondays ~13:00 UTC, after the 12:00 UTC data refresh.
- **Auth:** Google Cloud service account + Sheets API. Each master sheet is shared
  with the service-account email as Editor. Key lives in a Render env var
  (`GOOGLE_SERVICE_ACCOUNT_JSON`), never committed.
- **Mapping:** new `master_sheets` table — `brand_id`, `spreadsheet_id`, `enabled`,
  `last_synced_at`, `notes`. Migration via `scripts/run-migration.js` per workspace rules.
- **Alerting:** per-brand failure → Slack via the existing webhook. Never fail silently.

## The `Ads Performance` tab (per brand sheet)

Mirrors `rmc-skills/references/ppc-report-format.md` (May's captured workbook) exactly:

- Header rows: brand name, pull date, data-start date, "Sponsored Products only" caveat.
- **Table 1 — Monthly:** one row per calendar month from earliest available history.
  All 20 columns in the captured order (Total Sales … Total Revenue from Ads).
  YoY/MoM diffs on Total Sales, diff ÷ prior period. Year-total row after each December.
  Current month rides as MTD, labeled "Mon YYYY (through <date>)".
- **Table 2 — Weekly:** one Sun–Sat row per week, `WoW Ending` = Saturday `d-MMM-yyyy`.
  Column groups: PPC Performance → Overall Performance → Organic Performance, totals
  row above the header, same as the captured format.
- Money `$#,##0.00`, rates `0.00%`, counts `#,##0`. CA and USD never mixed.

## Write semantics — UPSERT WITH A FROZEN ZONE (critical, Mike-specified)

Amazon ads data reaches back only ~90 days, so the sheet becomes the ONLY copy of
older history. Therefore:

- Rows are keyed by period label (month label / WoW-ending date).
- Each run recomputes and overwrites ONLY rows whose period is **fully covered** by
  current source data (~trailing 90 days — also captures 14-day attribution restatements).
- Everything older is **frozen**: never recomputed, never deleted, never touched.
- A period straddling the coverage boundary counts as NOT fully covered → stays frozen
  (recomputing from partial data would understate it).
- The job never deletes rows. If an expected frozen row is missing (human deleted it),
  it cannot be regenerated — alert to Slack, do not paper over.
- The tab is machine-owned: manual edits inside it get overwritten (within the live
  window). Formulas in OTHER tabs referencing it are fine. Job never touches other tabs.

## Phase 1 also includes: persist ad history in the DB

Open Notion Submissions request "Persist ad clicks / impressions / orders to
daily_metrics" folds into this build. From go-live the dashboard DB keeps daily ad
metrics permanently, so the frozen zone only matters for data older than persistence
start. History in Supabase + history in the sheet — a sheet mishap can't erase it.

## Rollout

1. **Phase 1:** migration (`master_sheets` + ad-metrics persistence), sync module,
   cron entry. Backfill dry-run against a COPY of one master sheet (Zollipops).
   Mike approves the rendering before anything touches a real sheet.
2. **Phase 2:** load Mike's brand → spreadsheet URL list, enable all brands.
3. **Phase 3 (parked):** `POST /api/master-sheet/:brandId` so approved audit outputs
   can land in their own tabs later. Same plumbing; out of scope now.

## Open items (blockers before Phase 2)

- [ ] Mike: brand → master-sheet URL list ("I have URLs for all master sheets, no problem")
- [ ] Mike: dual-marketplace brands — option A (separate `Ads Performance CA` / `US`
      tabs, recommended) or option B (stacked tables in one tab, like May's workbook)
- [ ] Mike: ~10 min in Google Cloud console to create the service account
      (guide him with the exact click path during the build)

## Context

- Data pulled = same as the ppc-report skill: totals/sessions from
  `/api/report-data/:brandId`, ad metrics from `/api/report-ads/:brandId` (SP only,
  CA + US profiles).
- The claude.ai Google Drive connector CANNOT edit existing files (read/create/copy
  only) and isn't reliable in scheduled runs — that's why this is a dashboard cron
  with a service account, decided over a scheduled-agent or Apps Script approach.
- Master sheets are per brand, scattered ownership (e.g. Zollipops under vien@,
  EARTHWISE under niklas@) — the URL list from Mike is authoritative, don't guess.
