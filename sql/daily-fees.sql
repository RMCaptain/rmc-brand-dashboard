-- daily_fees: Amazon fees + refunds per PST posted-day, from the Finances API.
-- Feeds /api/metrics financials for arbitrary date ranges (posted-date
-- semantics, matching Sellerboard). One row per day; re-collected on a
-- trailing window because fees/refunds keep posting after the order date.

create table if not exists daily_fees (
  date               date primary key,
  fees_cad           numeric not null default 0,
  fees_usd           numeric not null default 0,
  service_fees_cad   numeric not null default 0,
  service_fees_usd   numeric not null default 0,
  refund_amount_cad  numeric not null default 0,
  refund_amount_usd  numeric not null default 0,
  refund_fees_cad    numeric not null default 0,
  refund_fees_usd    numeric not null default 0,
  refund_count       integer not null default 0,
  ad_spend_cad       numeric not null default 0,
  ad_spend_usd       numeric not null default 0,
  breakdown_cad      jsonb   not null default '{}'::jsonb,
  breakdown_usd      jsonb   not null default '{}'::jsonb,
  updated_at         timestamptz not null default now()
);

-- Verification
select count(*) as daily_fees_rows from daily_fees;
