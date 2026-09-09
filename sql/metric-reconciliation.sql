-- metric_reconciliation: Amazon-API numbers vs Sellerboard, per day, per
-- marketplace, per scope. Written by sync/reconcileSellerboard.js after each
-- Sellerboard feed ingest. This is the "which number do we trust" ledger:
-- the UI shows the Sellerboard value where one exists and raises a flag off
-- these rows when the two sources disagree beyond tolerance.
--
-- scope / scope_id:
--   account     '*'        whole marketplace for the day
--   account_7d  '*'        trailing 7 days ending `date` (absorbs the
--                          UTC-vs-PST day-boundary noise; this is the row
--                          the Slack alert keys off)
--   brand       <brand_id>
--   asin        <asin>     stored ONLY when status != 'match' (volume)
-- mp_id '*' = all marketplaces combined (used for sessions, which the wide
-- table only holds blended).
--
-- status:
--   match     both sides present, |delta| within tolerance
--   flag      both sides present, outside tolerance
--   sb_only   Sellerboard has a value, Amazon side is zero/absent
--   amz_only  Amazon has a value, Sellerboard side is zero/absent
-- Tolerance (Mike, 2026-09-09): money = max($25, 1%); counts = max(2, 1%).
-- delta = amazon_value - sellerboard_value.

CREATE TABLE IF NOT EXISTS metric_reconciliation (
  date               date        NOT NULL,
  mp_id              text        NOT NULL,
  scope              text        NOT NULL,
  scope_id           text        NOT NULL,
  metric             text        NOT NULL,
  amazon_value       numeric,
  sellerboard_value  numeric,
  delta              numeric,
  delta_pct          numeric,
  status             text        NOT NULL,
  checked_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, mp_id, scope, scope_id, metric)
);

CREATE INDEX IF NOT EXISTS metric_reconciliation_status_date_idx ON metric_reconciliation (status, date);
CREATE INDEX IF NOT EXISTS metric_reconciliation_scope_idx       ON metric_reconciliation (scope, scope_id, date);

-- Verification
SELECT status, COUNT(*) AS rows FROM metric_reconciliation GROUP BY status ORDER BY status;
