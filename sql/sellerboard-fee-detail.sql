-- fee_detail: per-fee-type granularity on sellerboard_daily (Mike, 2026-10-19:
-- "we need way more granularity" on fees + a Sellerboard-vs-Amazon fee recon).
--
-- A jsonb of { normalized_column_name: amount } per row, holding every
-- non-zero Amazon fee / refund-cost / product-cost column from the feed
-- (sync/sellerboard.js FEE_COLS + REFUND_COST_COLS + PRODUCT_COST_COLS;
-- condensed-layout accounts carry their aggregate columns instead).
--
-- SIGN + CURRENCY: values keep SELLERBOARD'S OWN SIGN (costs negative,
-- reimbursements positive — unlike the normalized money columns, which store
-- money-out positive) and are converted to the row's native `currency` with
-- the row's fx_rate, same as every other money column. The UI shows them
-- exactly as Sellerboard's expanded dashboard panel does.
--
-- Ingest populates it for new rows; the backfill below builds it for existing
-- rows out of `raw` (original headers, account currency) x fx_rate. Both are
-- idempotent: the backfill only touches rows where fee_detail IS NULL, and
-- finishes by stamping '{}' on rows with nothing itemized so reboots rescan
-- nothing.

ALTER TABLE sellerboard_daily ADD COLUMN IF NOT EXISTS fee_detail jsonb;

UPDATE sellerboard_daily sd
SET fee_detail = x.detail
FROM (
  SELECT t.date, t.mp_id, t.sku,
         jsonb_object_agg(t.k, round((replace(t.v, ',', '')::numeric * t.fx_rate)::numeric, 2)) AS detail
  FROM (
    SELECT s.date, s.mp_id, s.sku, s.fx_rate,
           lower(replace(e.key, 'В', 'B')) AS k,   -- fold the feed's Cyrillic В
           e.value AS v
    FROM sellerboard_daily s, LATERAL jsonb_each_text(s.raw) e
    WHERE s.fee_detail IS NULL
  ) t
  WHERE t.k IN (
    -- itemized layout (FEE_COLS)
    'commission', 'compensated_clawback', 'fbadisposalfee', 'fbainboundconveniencefee',
    'fbainboundtransportationfee', 'fbalongtermstoragefee', 'fbaperunitfulfillmentfee',
    'fbaremovalfee', 'fbastoragefee', 'free_replacement_refund_items', 'inbound_carrier_damage',
    'missing_from_inbound', 'missing_from_inbound_clawback', 're_evaluation',
    'reversal_reimbursement', 'salestaxcollectionfee', 'warehouse_damage',
    'warehouse_damage_exception', 'warehouse_lost', 'warehouse_lost_manual',
    -- refund costs (REFUND_COST_COLS)
    'refund commission', 'refund principal', 'refund promotion', 'refund refundcommission',
    'refundscostsdamaged', 'value of returned items', 'productcost unsellable refunds',
    -- product costs (PRODUCT_COST_COLS)
    'productcost sales', 'productcost non-amazon', 'productcost multichannelcosts',
    'productcost missingfrominbound', 'productcost costofmissingreturns',
    -- condensed layout aggregates (RMCo Intl)
    'amazonfees', 'refundcost', 'cost of goods'
  )
    AND t.v ~ '^-?[0-9][0-9,]*(\.[0-9]+)?$'
    AND replace(t.v, ',', '')::numeric <> 0
  GROUP BY t.date, t.mp_id, t.sku
) x
WHERE sd.date = x.date AND sd.mp_id = x.mp_id AND sd.sku = x.sku
  AND sd.fee_detail IS NULL;

-- Rows with nothing itemized (all-zero fee columns) get an empty object so
-- the backfill never rescans them.
UPDATE sellerboard_daily SET fee_detail = '{}'::jsonb WHERE fee_detail IS NULL;

-- Verification
SELECT COUNT(*) AS rows_total,
       COUNT(*) FILTER (WHERE fee_detail IS NOT NULL AND fee_detail <> '{}'::jsonb) AS rows_with_detail
FROM sellerboard_daily;
