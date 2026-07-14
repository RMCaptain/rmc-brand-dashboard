-- Saved reports become immutable deliverables.
--
-- Until now brand_report_archives only logged that a PDF was rendered, and
-- stored the summary text. The numbers were always re-queried live, so an old
-- report would silently change if the underlying data changed.
--
-- That's right for a LIVE VIEW and wrong for a SENT REPORT. Adding a full
-- dataset snapshot lets a saved report be frozen: whatever the brand was sent
-- is exactly what we can show back, forever.
--
-- Live views stay live — they never read the snapshot. Only explicitly saved
-- reports do.
--
-- Idempotent: IF NOT EXISTS so re-running is safe.

ALTER TABLE brand_report_archives
  ADD COLUMN IF NOT EXISTS dataset_snapshot JSONB;

-- Rows written before this migration have no snapshot; they're PDF-render
-- logs from the old behaviour rather than saved reports. Flag them so the UI
-- can tell the difference instead of guessing.
ALTER TABLE brand_report_archives
  ADD COLUMN IF NOT EXISTS is_saved_report BOOLEAN NOT NULL DEFAULT FALSE;

-- Sanity check.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'brand_report_archives'
ORDER BY ordinal_position;
