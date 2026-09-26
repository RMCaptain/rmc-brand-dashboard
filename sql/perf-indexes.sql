-- Hot-path indexes (2026-09-26). daily_metrics predates the repo's
-- migration files and only carries its (asin,date) upsert key, which a
-- date-range scan can't use (asin leads) — so every dashboard range view
-- and preset rebuild walked the whole table. Both filters below are the
-- exact shapes the server issues:
--   .gte('date', from).lte('date', to)                     → (date)
--   .eq('brand_id', b).gte('date', from).lte('date', to)   → (brand_id, date)
-- Runs at boot via BOOT_MIGRATIONS; IF NOT EXISTS keeps it idempotent.

CREATE INDEX IF NOT EXISTS daily_metrics_date_idx       ON daily_metrics (date);
CREATE INDEX IF NOT EXISTS daily_metrics_brand_date_idx ON daily_metrics (brand_id, date);

-- Verification: both indexes present.
SELECT count(*) AS daily_metrics_perf_indexes
FROM pg_indexes
WHERE tablename = 'daily_metrics'
  AND indexname IN ('daily_metrics_date_idx', 'daily_metrics_brand_date_idx');
