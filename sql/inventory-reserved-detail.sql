-- Reserved-inventory breakdown per ASIN per day (Mike, 2026-11-10).
-- Amazon's totalReservedQuantity hides three very different states:
--   pendingCustomerOrderQuantity  -> units already sold, awaiting shipment
--   pendingTransshipmentQuantity  -> units moving between FCs
--   fcProcessingQuantity          -> units being processed at an FC
-- getInventorySummaries already returns these (details=true); store them so
-- the brand report can expose inventory.reservedBreakdown. Idempotent.

ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS reserved_customer_orders integer;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS reserved_fc_transfer     integer;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS reserved_fc_processing   integer;
