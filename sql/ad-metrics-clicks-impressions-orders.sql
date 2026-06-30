-- Phase 1 — Brand report data layer
-- Add clicks, impressions, attributed orders columns to daily_metrics so
-- auto-generated reports (Phases 5/6) can read these instantly instead of
-- triggering a fresh 1-5 min Amazon Ads API report bake per brand.
--
-- Nullable on purpose: NULL means "no data persisted yet" (historical rows
-- and brands without ads); 0 would falsely imply "ran ads but got nothing."
-- The matching code change in syncDailyAdSpend will populate these forward
-- from the next sync onward.
--
-- Idempotent: IF NOT EXISTS so re-running is safe.

ALTER TABLE daily_metrics
  ADD COLUMN IF NOT EXISTS ad_clicks      INTEGER,
  ADD COLUMN IF NOT EXISTS ad_impressions INTEGER,
  ADD COLUMN IF NOT EXISTS ad_orders      INTEGER;

-- Sanity check — confirms the three columns are present.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'daily_metrics'
  AND column_name IN ('ad_clicks', 'ad_impressions', 'ad_orders')
ORDER BY column_name;
