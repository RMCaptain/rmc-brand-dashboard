-- Remove the New-To-Brand (NTB) columns from daily_metrics.
-- NTB was dropped from the reporting pipeline (2026-07-02) to reduce Amazon
-- Ads API pulls and keep the ad section focused on TACOS/TROAS/ACOS/ROAS.
-- The code no longer reads or writes these columns; this migration cleans
-- them up. Safe to run — nothing references them anymore.
--
-- Optional: the columns are harmless if left in place (nullable, unwritten),
-- so running this is a cleanup, not a requirement.

ALTER TABLE daily_metrics
  DROP COLUMN IF EXISTS ntb_sales_cad,
  DROP COLUMN IF EXISTS ntb_sales_usd,
  DROP COLUMN IF EXISTS ntb_orders,
  DROP COLUMN IF EXISTS ntb_units;

-- Confirm they're gone.
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'daily_metrics'
  AND column_name LIKE 'ntb_%';
