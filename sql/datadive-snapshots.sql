-- Data Dive read-only sync: raw JSONB snapshots of rank radars and niche
-- keyword lists, mapped to brands via the radar's ASIN. Run before deploying
-- sync/datadive.js.

create table if not exists datadive_snapshots (
  kind       text not null check (kind in ('radar','niche_keywords','niche_list')),
  key        text not null,
  brand_id   text,
  asin       text,
  meta       jsonb not null default '{}',
  payload    jsonb not null,
  pulled_at  timestamptz not null default now(),
  primary key (kind, key)
);

create index if not exists datadive_snapshots_brand_idx on datadive_snapshots (brand_id);
