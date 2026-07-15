-- Ads API expansion: search-term rows + campaign structure snapshots.
-- Run in Supabase SQL editor before deploying the sync code.

-- Search terms: rolling 30-day summary per profile, wipe-and-replace on each
-- pull (sync validates the new pull is non-empty before deleting old rows).
create table if not exists ads_search_terms (
  id             bigint generated always as identity primary key,
  profile        text not null check (profile in ('CA','US')),
  report_start   date not null,
  report_end     date not null,
  campaign_id    text,
  campaign_name  text,
  ad_group_id    text,
  ad_group_name  text,
  keyword_id     text,
  keyword        text,
  match_type     text,
  targeting      text,
  search_term    text not null,
  impressions    integer default 0,
  clicks         integer default 0,
  cost           numeric(12,2) default 0,
  orders         integer default 0,
  sales          numeric(12,2) default 0,
  pulled_at      timestamptz not null default now()
);

create index if not exists ads_search_terms_profile_idx  on ads_search_terms (profile);
create index if not exists ads_search_terms_campaign_idx on ads_search_terms (campaign_id);
create index if not exists ads_search_terms_term_idx     on ads_search_terms (search_term);

-- Campaign structure snapshot: one JSONB blob per profile (campaigns, ad
-- groups, keywords, targets, negative keywords, product ads). Single writer
-- (structure cron), replaced wholesale on each pull.
create table if not exists ads_campaign_snapshot (
  profile    text primary key check (profile in ('CA','US')),
  snapshot   jsonb not null,
  pulled_at  timestamptz not null default now()
);
