-- Ads accuracy alignment (2026-08-11, Mike's master-sheet audit):
--
-- 1. daily_metrics gains 7-day attribution columns. The Ads console shows
--    Sponsored Products sales/orders on a 7-DAY window for sellers; we have
--    been storing sales14d/purchases14d only, so every sheet/report sales
--    figure ran 3-5% above what May sees in campaign manager. The daily ads
--    sync now pulls BOTH windows; 14d columns keep their meaning (dashboard
--    convention), 7d columns feed the Master-sheet tabs. Rows older than
--    Amazon's ~95-day retention can never be backfilled -> stay NULL, and
--    readers fall back to 14d.
--
-- 2. daily_brand_ads: Sponsored Brands + Sponsored Display, campaign-level,
--    rolled up per (date, brand, ad_product). These can't live in
--    daily_metrics (ASIN-keyed) because SB/SD campaigns aren't advertised-ASIN
--    scoped. Brand comes from the campaign-name prefix ("ACURE - ...",
--    "PW - ..."); unmapped prefixes land on 'unknown-brand' so account totals
--    always reconcile against the console.

ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS attributed_sales_7d_cad numeric(12,2);
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS attributed_sales_7d_usd numeric(12,2);
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS ad_orders_7d integer;

CREATE TABLE IF NOT EXISTS daily_brand_ads (
  date        date NOT NULL,
  brand_id    text NOT NULL,
  ad_product  text NOT NULL CHECK (ad_product IN ('SB', 'SD')),
  spend_cad   numeric(12,2) NOT NULL DEFAULT 0,
  spend_usd   numeric(12,2) NOT NULL DEFAULT 0,
  sales_cad   numeric(12,2) NOT NULL DEFAULT 0,
  sales_usd   numeric(12,2) NOT NULL DEFAULT 0,
  clicks      integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  orders      integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, brand_id, ad_product)
);

-- Verification
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name = 'daily_metrics'
      AND column_name IN ('attributed_sales_7d_cad', 'attributed_sales_7d_usd', 'ad_orders_7d')) AS new_dm_columns,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_name = 'daily_brand_ads') AS brand_ads_table;
