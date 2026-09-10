-- sellerboard_daily: Sellerboard's Product Dashboard report, one row per
-- (Sellerboard day, marketplace, SKU). Fed by sync/sellerboard.js from the
-- Settings → Automation CSV links (one per Sellerboard account); the feed
-- re-delivers a trailing ~32-day window on every fetch, so restated days
-- (late refunds, fee postings) self-correct via upsert.
--
-- Purpose: the external reference the dashboard reconciles against
-- (sync/reconcileSellerboard.js → metric_reconciliation) and, where a
-- Sellerboard value exists, the number the UI prefers to show. Sessions
-- lag Amazon's S&T report by a day here, same as everywhere else.
--
-- SIGN CONVENTION (normalized columns): money OUT is stored POSITIVE
-- (amazon_fees, ad_spend, product_costs, refund_amount, promo_value), the
-- same as daily_fees / daily_metrics. Sellerboard's CSV carries costs as
-- negatives; the raw row is kept verbatim in `raw` for anything not
-- normalized. net_profit / gross_profit / est_payout keep their sign.
--
-- DAY BOUNDARY: `date` is the marketplace's local calendar day — Pacific for
-- Amazon NA, i.e. the dashboard's own day (verified 2026-09-09: US daily
-- sales match Amazon's S&T report to the cent). Fees and refunds still differ
-- by BASIS (Sellerboard books them to the order day, Amazon's Finances walk
-- to the posted day), so those daily rows carry lag noise by design.
--
-- CURRENCY: the feed reports in the Sellerboard ACCOUNT's currency (RMC =
-- USD), so the ingest converts money columns to the marketplace's native
-- currency (`currency`) with the day's rate. `feed_currency` / `fx_rate` /
-- `fx_source` record the conversion; `raw` keeps the account-currency values.

CREATE TABLE IF NOT EXISTS sellerboard_daily (
  date              date        NOT NULL,
  mp_id             text        NOT NULL,   -- registry id (A2EUQ1WTGCTBG2 = Amazon.ca …)
  sku               text        NOT NULL,
  asin              text        NOT NULL,
  currency          text        NOT NULL,   -- marketplace currency from the registry (money columns are in this)
  feed_currency     text,                   -- Sellerboard account currency the feed arrived in
  fx_rate           numeric     NOT NULL DEFAULT 1,   -- feed_currency → currency multiplier applied
  fx_source         text,                   -- same | implied | daily | carry | live | fallback
  account           text,                   -- feed key: RMC | WMCA | INTL
  brand_id          text,                   -- stamped from the brands blob at ingest (asin → brand)
  name              text,
  channel           text,                   -- FBA | FBM
  sales             numeric     NOT NULL DEFAULT 0,   -- organic + PPC product sales
  sales_ppc         numeric     NOT NULL DEFAULT 0,
  sales_sd          numeric     NOT NULL DEFAULT 0,
  units             integer     NOT NULL DEFAULT 0,
  units_ppc         integer     NOT NULL DEFAULT 0,
  refunds           integer     NOT NULL DEFAULT 0,   -- refunded units (count)
  refund_amount     numeric     NOT NULL DEFAULT 0,   -- refunded principal (positive)
  refund_costs      numeric     NOT NULL DEFAULT 0,   -- net cost of refunds after returned commission + returned stock value (positive = cost)
  promo_value       numeric     NOT NULL DEFAULT 0,   -- promotions/coupons given (positive)
  ad_spend          numeric     NOT NULL DEFAULT 0,   -- total Amazon ads (positive)
  ad_spend_sp       numeric     NOT NULL DEFAULT 0,
  ad_spend_sb       numeric     NOT NULL DEFAULT 0,
  ad_spend_sbv      numeric     NOT NULL DEFAULT 0,
  ad_spend_sd       numeric     NOT NULL DEFAULT 0,
  amazon_fees       numeric     NOT NULL DEFAULT 0,   -- all Amazon fee columns netted (positive = cost; reimbursements reduce it) — Sellerboard's "Amazon fees"
  fee_charges       numeric     NOT NULL DEFAULT 0,   -- charges only (positive) — comparable to daily_fees_*.fees
  reimbursements    numeric     NOT NULL DEFAULT 0,   -- Amazon reimbursements (positive = money in); amazon_fees = fee_charges - reimbursements
  storage_fees      numeric     NOT NULL DEFAULT 0,   -- FBA storage + long-term storage (subset of fee_charges; Sellerboard amortizes these)
  order_fees        numeric     NOT NULL DEFAULT 0,   -- commission + FBA per-unit + sales-tax collection: same basis as daily_fees_*.fees
  product_costs     numeric     NOT NULL DEFAULT 0,   -- COGS incl. non-Amazon / multichannel / missing-inbound (positive)
  est_payout        numeric     NOT NULL DEFAULT 0,
  gross_profit      numeric     NOT NULL DEFAULT 0,
  net_profit        numeric     NOT NULL DEFAULT 0,
  margin            numeric,
  sessions          integer,
  unit_session_pct  numeric,
  raw               jsonb       NOT NULL DEFAULT '{}'::jsonb,
  fetched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, mp_id, sku)
);

-- Columns added after the first cut (no-ops on a fresh table).
ALTER TABLE sellerboard_daily
  ADD COLUMN IF NOT EXISTS feed_currency  text,
  ADD COLUMN IF NOT EXISTS fx_rate        numeric NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS fx_source      text,
  ADD COLUMN IF NOT EXISTS fee_charges    numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reimbursements numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS storage_fees   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS order_fees     numeric NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS sellerboard_daily_asin_date_idx  ON sellerboard_daily (asin, date);
CREATE INDEX IF NOT EXISTS sellerboard_daily_brand_date_idx ON sellerboard_daily (brand_id, date);
CREATE INDEX IF NOT EXISTS sellerboard_daily_mp_date_idx    ON sellerboard_daily (mp_id, date);

-- Verification
SELECT COUNT(*) AS sellerboard_daily_rows, MIN(date) AS first_day, MAX(date) AS last_day FROM sellerboard_daily;
