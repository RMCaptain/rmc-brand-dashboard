-- Subscribe & Save daily history.
--
-- The Replenishment API only reports CURRENT subscription counts — the brands
-- blob overwrites them every sync, so there was no trend data at all. This
-- table snapshots per-ASIN per-marketplace counts once per day (last sync of
-- the day wins via upsert). History accrues from the day this ships; the API
-- offers nothing to backfill from.
--
-- sns_sync_days records which marketplaces ACTUALLY reported each day, so a
-- missing ASIN row on a covered day is a true zero, while a missing day is
-- "no data" — the 0-vs-NULL rule (see project_data_coverage) applied here
-- from day one instead of retrofitted later.

CREATE TABLE IF NOT EXISTS sns_daily (
  date        date NOT NULL,             -- PST snapshot date
  asin        text NOT NULL,
  mp_id       text NOT NULL,             -- A2EUQ1WTGCTBG2 = CA, ATVPDKIKX0DER = US
  brand_id    text,
  subs        integer NOT NULL,
  mtd_revenue numeric,                   -- month-to-date S&S revenue (marketplace currency)
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, asin, mp_id)
);

CREATE TABLE IF NOT EXISTS sns_sync_days (
  date       date NOT NULL,
  mp_id      text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, mp_id)
);

SELECT
  (SELECT COUNT(*) FROM sns_daily)     AS sns_daily_rows,
  (SELECT COUNT(*) FROM sns_sync_days) AS sns_sync_day_rows;
