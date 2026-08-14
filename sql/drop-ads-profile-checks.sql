-- Drop the CHECK (profile in ('CA','US')) constraints so UK ads rows can land
-- (MARKETPLACE-EXPANSION-PLAN.md Phase 1). Data untouched — this only widens
-- what future INSERTs may carry.
--
-- ⚠ NOT YET RUN (2026-08-13): ALTERs on existing tables are flagged to Mike
-- before running, per workspace rules. Run before the first UK ads sync:
--   node scripts/run-migration.js sql/drop-ads-profile-checks.sql

alter table ads_search_terms      drop constraint if exists ads_search_terms_profile_check;
alter table ads_campaign_snapshot drop constraint if exists ads_campaign_snapshot_profile_check;

-- Verification: no profile CHECKs left on either table.
select conrelid::regclass as table_name, conname
from pg_constraint
where conrelid in ('ads_search_terms'::regclass, 'ads_campaign_snapshot'::regclass)
  and contype = 'c';
