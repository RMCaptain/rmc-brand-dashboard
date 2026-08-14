-- daily_fees_mp: per-MARKETPLACE daily Amazon fees + refunds — the expand-phase
-- replacement for daily_fees' currency-suffixed columns (which structurally
-- cannot represent a second CAD marketplace like Walmart.ca; see
-- MARKETPLACE-EXPANSION-PLAN.md). One row per (date, mp_id); currency is an
-- attribute, never derived from the id.
--
-- Expand phase: daily_fees (wide) stays the reader's source of truth for CA/US;
-- this table receives double-writes from syncDailyFees plus this one-time
-- backfill. New marketplaces (UK, walmart_ca) will write ONLY here.
--
-- Backfill note: the wide table's refund_count was never split by currency, so
-- historical counts ride the CA row (US rows carry 0) — summed totals stay
-- correct. Rows written by the double-write path carry true per-marketplace
-- counts (getFinancialSummary now tracks refundCount per currency).

create table if not exists daily_fees_mp (
  date           date        not null,
  mp_id          text        not null,
  currency       text        not null,
  fees           numeric     not null default 0,
  service_fees   numeric     not null default 0,
  refund_amount  numeric     not null default 0,
  refund_fees    numeric     not null default 0,
  refund_count   integer     not null default 0,
  ad_spend       numeric     not null default 0,
  breakdown      jsonb       not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (date, mp_id)
);

create index if not exists daily_fees_mp_mp_date on daily_fees_mp (mp_id, date);

-- One-time backfill from the wide table. ON CONFLICT DO NOTHING so re-running
-- never clobbers rows the double-write path has since refreshed.
insert into daily_fees_mp (date, mp_id, currency, fees, service_fees,
                           refund_amount, refund_fees, refund_count, ad_spend,
                           breakdown, updated_at)
select date, 'A2EUQ1WTGCTBG2', 'CAD', fees_cad, service_fees_cad,
       refund_amount_cad, refund_fees_cad, refund_count, ad_spend_cad,
       breakdown_cad, updated_at
from daily_fees
on conflict (date, mp_id) do nothing;

insert into daily_fees_mp (date, mp_id, currency, fees, service_fees,
                           refund_amount, refund_fees, refund_count, ad_spend,
                           breakdown, updated_at)
select date, 'ATVPDKIKX0DER', 'USD', fees_usd, service_fees_usd,
       refund_amount_usd, refund_fees_usd, 0, ad_spend_usd,
       breakdown_usd, updated_at
from daily_fees
on conflict (date, mp_id) do nothing;

-- Verification: row counts per marketplace + money totals must match the wide
-- table exactly (counts: mp rows = 2x wide rows; CAD fee sum = wide CAD sum).
select mp_id, count(*) as rows, round(sum(fees)::numeric, 2) as fees_total,
       round(sum(refund_amount)::numeric, 2) as refunds_total
from daily_fees_mp group by mp_id order by mp_id;
select count(*) as wide_rows, round(sum(fees_cad)::numeric, 2) as wide_fees_cad,
       round(sum(fees_usd)::numeric, 2) as wide_fees_usd from daily_fees;
