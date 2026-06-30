-- Phase 1 — Brand report data layer (NTB)
-- Add New-To-Brand (NTB) ad metrics to daily_metrics. NTB measures the
-- portion of advertising-driven sales coming from customers who hadn't
-- purchased the brand in the prior 12 months — the signal that ads are
-- actually growing the brand vs preaching to existing buyers.
--
-- Pulled from the Sponsored Products advertised-product report via the
-- newToBrandSales14d / newToBrandPurchases14d / newToBrandUnitsSold14d
-- columns. Stored per (asin, date), split by marketplace currency since
-- NTB sales come per profile (CA or US).
--
-- Idempotent: IF NOT EXISTS so re-running is safe.

ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS ntb_sales_cad NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS ntb_sales_usd NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS ntb_orders    INTEGER,
  ADD COLUMN IF NOT EXISTS ntb_units     INTEGER;

-- Sanity check.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'daily_metrics'
  AND column_name LIKE 'ntb_%'
ORDER BY column_name;
