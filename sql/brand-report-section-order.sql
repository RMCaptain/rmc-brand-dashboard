-- Per-brand report section ORDER.
--
-- brand_report_configs already stores which sections are hidden; it has no
-- notion of sequence, so the report has always rendered in REPORT_SECTION_KEYS
-- order. Dragging sections needs somewhere to remember the result.
--
-- Stores only the MOVABLE sections. executive_summary and per_asin_detail are
-- pinned first and last respectively and are never in this array — if they ever
-- appear (hand-edited row, older client), the server filters them out rather
-- than letting a stored order float them into the middle of the report.
--
-- Unknown/new sections are not an error: the resolver appends any section
-- missing from a saved order, so adding a section later doesn't require
-- touching every brand's row, and a stale order can't make a new section
-- silently invisible.
--
-- Default '[]' means "no custom order" -> fall back to REPORT_SECTION_KEYS
-- order, which is today's standard report.

ALTER TABLE brand_report_configs
  ADD COLUMN IF NOT EXISTS section_order JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Sanity check.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'brand_report_configs'
ORDER BY ordinal_position;
