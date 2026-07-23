-- Daily listing-price snapshot for Pending-order revenue estimation.
--
-- The Pricing API returns nothing for a SKU with no active offer — which is
-- exactly the state a SKU is in right after its last unit sells. A daily
-- sweep captures prices WHILE items are in stock, so the estimation ladder
-- (sync/orders.js estimateDay, rung 1) can price a sold-out Pending item at
-- this morning's listing price instead of a trailing average.
--
-- Rows accumulate: seeded by the daily sweep over every brand SKU, and every
-- successful live lookup during polling upserts here too.

CREATE TABLE IF NOT EXISTS sku_prices (
  sku        text NOT NULL,
  mp_id      text NOT NULL,          -- Amazon marketplace id (A2EUQ1WTGCTBG2 = CA)
  asin       text,
  price      numeric NOT NULL,
  currency   text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sku, mp_id)
);

SELECT COUNT(*) AS sku_price_rows FROM sku_prices;
