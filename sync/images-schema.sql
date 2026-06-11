-- Persistent ASIN→image-URL store. Replaces the ephemeral
-- data/image-cache.json file that gets wiped on every Render deploy.
--
-- Source-of-truth lookup table. Sync code reads + writes here; the dashboard
-- reads via /api/asins/images. Multiple sources can populate it; manual
-- overrides win and never get overwritten by automated sync.

CREATE TABLE IF NOT EXISTS public.asin_images (
  asin              text PRIMARY KEY,
  image_url         text NOT NULL,
  source            text NOT NULL,         -- 'listings_report' | 'catalog_api' | 'manual'
  marketplace       text,                   -- 'CA' or 'US' (origin marketplace)
  last_verified_at  timestamptz NOT NULL DEFAULT now(),
  manual_override   boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asin_images_last_verified_idx ON public.asin_images (last_verified_at);
CREATE INDEX IF NOT EXISTS asin_images_source_idx        ON public.asin_images (source);
