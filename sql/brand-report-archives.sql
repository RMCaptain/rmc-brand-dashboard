-- Phase 2 slice 2.5 — Report history archive.
-- Records one row each time a brand report PDF is generated, capturing
-- the period and a snapshot of the AI summary at generation time.
--
-- We deliberately do NOT store the PDF blob: PDFs can be regenerated
-- on demand from the same period params, and Render's filesystem is
-- ephemeral. The summary_text_snapshot preserves the narrative used
-- at the time so re-renders show what was sent, even if the live
-- summary cache has since been edited.

CREATE TABLE IF NOT EXISTS brand_report_archives (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id              TEXT NOT NULL,
  period_from           DATE NOT NULL,
  period_to             DATE NOT NULL,
  period_label          TEXT,
  summary_text_snapshot TEXT,
  generated_by          TEXT,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brand_report_archives_brand_idx
  ON brand_report_archives (brand_id, generated_at DESC);

-- Sanity check.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'brand_report_archives'
ORDER BY ordinal_position;
