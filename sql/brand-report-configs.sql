-- Per-brand settings for the brand report.
-- One row per brand. Anything not in the row falls back to defaults.
-- Kept intentionally minimal: only "hidden_sections" for v1. Mike's spec
-- 2026-06-30: no alerts, no custom ordering, no cover page.
--
-- Section keys this table can reference (the renderer ignores unknown keys):
--   executive_summary    AI-generated narrative (always on by default)
--   headline_tiles       Revenue/Units/Sessions/CVR/Buy Box %
--   sales_trend          30-day daily chart vs comparison period
--   ytd_chart            Current year vs prior year (Merchant Spring style)
--   sales_by_group       Product-group breakouts (deferred to v2 — needs grouping)
--   top_sellers          Per-product table with inventory color chips
--   ad_trend             Ad sales vs organic + ROAS line
--   ad_summary           TACOS / TROAS / NTB / ACOS / CTR / CPC block
--   inventory_status     Days of cover, stockouts, inbound
--   per_asin_sheet_link  Auto-generated Google Sheet link
--
-- Idempotent: IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS brand_report_configs (
  brand_id         TEXT PRIMARY KEY,
  hidden_sections  JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_report_configs_updated_at_idx
  ON brand_report_configs (updated_at DESC);

-- Sanity check.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'brand_report_configs'
ORDER BY ordinal_position;
