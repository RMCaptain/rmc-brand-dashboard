-- Reserved (FC transfer + FC processing + pending customer orders) and
-- unfulfillable quantities were captured by the FBA inventory sync but never
-- persisted — the daily snapshot only kept on-hand/inbound, so preset rebuilds
-- and the Master-sheet Inventory tab lost them. Store both alongside the
-- existing inventory columns; the post-sync traffic writer fills them daily.

ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS inventory_reserved      integer;
ALTER TABLE daily_metrics ADD COLUMN IF NOT EXISTS inventory_unfulfillable integer;

-- Verify: columns exist, all NULL until the next sync writes them
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'daily_metrics' AND column_name LIKE 'inventory%'
ORDER BY column_name;
