-- daily_fees_asin: per-ASIN Amazon fees + refund money per PST posted-day.
--
-- Same Finances-API walk as daily_fees (zero extra API calls) — the walk now
-- keeps the SKU dimension instead of discarding it, maps SKU → ASIN via
-- sku_prices, and aggregates per (date, asin, mp_id). Powers true per-product
-- net margin on the dashboard: Sales − COGS − fees − ad spend − refunds.
--
-- Unmappable SKUs are stored with asin = 'sku:<SellerSKU>' — loud, queryable,
-- never silently dropped. Service fees (storage, subscriptions, coupons) are
-- account-level by nature and deliberately stay ONLY in daily_fees.

CREATE TABLE IF NOT EXISTS daily_fees_asin (
  date          date    NOT NULL,
  asin          text    NOT NULL,            -- ASIN, or 'sku:<SellerSKU>' when unmapped
  mp_id         text    NOT NULL,            -- Amazon marketplace id (A2EUQ1WTGCTBG2 = CA)
  currency      text    NOT NULL,
  fees          numeric NOT NULL DEFAULT 0,  -- referral + FBA fulfillment + other per-item fees
  refund_amount numeric NOT NULL DEFAULT 0,  -- returned principal
  refund_fees   numeric NOT NULL DEFAULT 0,  -- non-returned commission etc.
  refund_count  integer NOT NULL DEFAULT 0,
  breakdown     jsonb   NOT NULL DEFAULT '{}'::jsonb,  -- fee-group totals (same groups as daily_fees)
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, asin, mp_id)
);

CREATE INDEX IF NOT EXISTS daily_fees_asin_asin_idx ON daily_fees_asin (asin);
CREATE INDEX IF NOT EXISTS daily_fees_asin_date_idx ON daily_fees_asin (date);

-- Verification
SELECT COUNT(*) AS daily_fees_asin_rows FROM daily_fees_asin;
