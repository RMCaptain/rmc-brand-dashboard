-- Refund tracking columns for daily_metrics.
-- Run once in Supabase SQL editor (Database → SQL).
--
-- All three are nullable / default 0 so existing rows aren't disturbed.
-- Refund attribution is to the ORIGINAL order date (per Mike), so the same
-- (asin, date) row holds both the day's units/revenue AND the eventual refunds
-- against orders placed that day.

ALTER TABLE public.daily_metrics
  ADD COLUMN IF NOT EXISTS refunded_units    integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_amount_cad numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_amount_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refund_count      integer NOT NULL DEFAULT 0;

-- Optional: lightweight log of refund events we've already attributed,
-- so the daily pull can be incremental + idempotent without re-deriving
-- everything from a 60-day window each run.
CREATE TABLE IF NOT EXISTS public.refund_events (
  event_id          text PRIMARY KEY,        -- AmazonOrderId + adjustment id
  amazon_order_id   text NOT NULL,
  posted_at         timestamptz NOT NULL,
  original_order_date date NOT NULL,         -- PST calendar day of original purchase
  asin              text,                    -- null if SKU couldn't be mapped
  marketplace_currency text NOT NULL,        -- 'CAD' | 'USD'
  refunded_units    integer NOT NULL,
  refund_amount     numeric NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_events_original_date_idx ON public.refund_events (original_order_date);
CREATE INDEX IF NOT EXISTS refund_events_asin_idx          ON public.refund_events (asin);
