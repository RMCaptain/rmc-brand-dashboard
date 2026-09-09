-- fx_rates: one row per PST calendar day of CAD multipliers, the same shape
-- /api/fx serves ({ "CAD": 1, "USD": 1.38, "GBP": 1.75 } = 1 unit → CAD).
-- Written by the dashboard's daily FX fetch (server.js fetchFxRate) and read
-- by the Sellerboard ingest (sync/fxRates.js) to convert a feed's account
-- currency into each marketplace's native currency with THAT day's rate.
-- Applied at boot (server.js BOOT_MIGRATIONS) — idempotent.

CREATE TABLE IF NOT EXISTS fx_rates (
  date        date        PRIMARY KEY,
  to_cad      jsonb       NOT NULL,
  source      text,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);

SELECT COUNT(*) AS fx_rate_days, MAX(date) AS latest FROM fx_rates;
