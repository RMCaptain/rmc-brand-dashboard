-- Cache for AI-generated executive summaries on brand reports.
-- One row per (brand, period) so we don't burn Claude API tokens on every
-- report view. When the human edits, edited=TRUE locks the cached row from
-- being silently overwritten on re-render.
--
-- The brand-report-summary endpoint degrades gracefully if this table is
-- missing (just regenerates every call) — so this migration is non-blocking.

CREATE TABLE IF NOT EXISTS brand_report_summaries (
  brand_id     TEXT NOT NULL,
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  summary_text TEXT,
  edited       BOOLEAN NOT NULL DEFAULT FALSE,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, period_from, period_to)
);

CREATE INDEX IF NOT EXISTS brand_report_summaries_brand_idx
  ON brand_report_summaries (brand_id, updated_at DESC);

-- Sanity check.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'brand_report_summaries'
ORDER BY ordinal_position;
