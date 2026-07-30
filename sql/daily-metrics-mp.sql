-- daily_metrics_mp — per-marketplace daily metrics (long format).
--
-- WHY: daily_metrics encodes marketplace identity in column names
-- (revenue_cad/revenue_usd, units_ca/units_us). That conflates marketplace
-- with currency: Amazon.ca and a future Walmart.ca are both CAD and would
-- silently sum into the same column. This table carries marketplace as a
-- real dimension so a third marketplace is one more mp_id value, not a
-- schema change.
--
-- MIGRATION PLAN (expand → migrate → contract, approved 2026-07-30):
--   1. This table + double-writes from every sync (wide table untouched).
--   2. Backfill history from the wide table's currency columns.
--   3. Readers move over one at a time, verified against Sellerboard.
--   4. Wide currency columns retire only after the last reader migrates.
-- Until step 4 completes, daily_metrics remains the source of truth.
--
-- mp_id follows the existing pattern in sns_daily / sku_prices: the raw
-- SP-API marketplace id for Amazon (A2EUQ1WTGCTBG2 = amazon.ca,
-- ATVPDKIKX0DER = amazon.com); non-Amazon marketplaces get their own
-- stable strings later (e.g. 'walmart_ca'). currency is an attribute of
-- the marketplace (sku_prices precedent), never inferred from mp_id.
--
-- NULL discipline: NULL = never synced, 0 = a true zero. Writers each own
-- a column group (orders → units/revenue, ads → ad_*, refunds → refund_*)
-- and upserts only touch the columns they provide, so groups land
-- independently — same contract the wide table has today.
--
-- Ad engagement note: ad_clicks/ad_impressions/ad_orders stay NULL until
-- sync/ads.js keeps per-profile engagement (today it blends CA+US before
-- the write). Historical engagement was blended at sync time and can never
-- be split — those columns are forward-only.

CREATE TABLE IF NOT EXISTS daily_metrics_mp (
  date                date    NOT NULL,
  asin                text    NOT NULL,
  mp_id               text    NOT NULL,
  currency            text    NOT NULL,
  brand_id            text,
  units               integer,
  revenue             numeric,
  ad_spend            numeric,
  ad_attributed_sales numeric,
  ad_clicks           integer,
  ad_impressions      integer,
  ad_orders           integer,
  sessions            integer,
  page_views          integer,
  buy_box_pct         numeric,
  refunded_units      integer,
  refund_amount       numeric,
  refund_count        integer,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, asin, mp_id)
);

CREATE INDEX IF NOT EXISTS daily_metrics_mp_brand_date_idx
  ON daily_metrics_mp (brand_id, date);

SELECT COUNT(*) AS daily_metrics_mp_rows FROM daily_metrics_mp;
