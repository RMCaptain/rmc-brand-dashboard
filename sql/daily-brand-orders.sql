-- Average Order Value needs an ORDER COUNT, which we have never stored.
--
-- daily_metrics has ad_orders and ntb_orders, but no count of actual orders.
-- sync/orders.js computes one and throws it away. Without it, AOV is not
-- derivable: revenue / units gives average UNIT PRICE, a different number —
-- a brand averaging 2 units per order would see AOV understated by half.
--
-- Why a separate table rather than a column on daily_metrics:
-- daily_metrics is keyed (asin, date), and one order routinely contains several
-- ASINs. An order count stored per ASIN would be counted once per ASIN in the
-- order, so summing a brand's rows would overstate orders — badly, and in a way
-- that looks plausible. Orders are a BRAND/day fact, not an ASIN/day fact, so
-- they get their own grain.
--
-- Multi-brand orders: an order containing ASINs from two brands counts once for
-- each. That is correct for a per-brand report ("how many orders included this
-- brand"), and means SUM(order_count) across brands can exceed the account's
-- true order count. Never sum this column across brands to get a total.
--
-- Column ownership stays exclusive: this table is written only by the Orders
-- pipeline, and holds no revenue — revenue continues to live in daily_metrics.
-- AOV is computed at read time as
--   SUM(daily_metrics.revenue) / SUM(daily_brand_orders.order_count).

CREATE TABLE IF NOT EXISTS daily_brand_orders (
  brand_id        TEXT NOT NULL,
  date            DATE NOT NULL,
  -- Distinct orders containing at least one of this brand's ASINs.
  order_count     INTEGER NOT NULL DEFAULT 0,
  -- Split by marketplace so AOV can be reported per currency rather than
  -- blending CAD and USD into a meaningless average. An order belongs to
  -- exactly one marketplace, so ca + us = order_count.
  order_count_ca  INTEGER NOT NULL DEFAULT 0,
  order_count_us  INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, date)
);

CREATE INDEX IF NOT EXISTS daily_brand_orders_date_idx
  ON daily_brand_orders (date DESC);

-- Sanity check.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'daily_brand_orders'
ORDER BY ordinal_position;
