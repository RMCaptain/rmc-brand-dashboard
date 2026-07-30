-- Listing content per managed ASIN, pulled read-only from SP-API:
-- Catalog Items (variant relationships, images, structured attributes) +
-- Listings Items (our own bullets, description, backend generic_keyword, issues).
-- Feeds /api/listing-content/:brandId and the get_listing_content MCP tool
-- (seo-asin-audit + listing-copy catalog audit mode).
-- Wipe-and-replace per brand on sync; one row per ASIN.

CREATE TABLE IF NOT EXISTS listing_content (
  asin TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  marketplace TEXT NOT NULL DEFAULT 'CA',
  seller_sku TEXT,
  parent_asin TEXT,
  variation_theme TEXT,
  title TEXT,
  brand_name TEXT,
  bullets JSONB,            -- array of bullet strings (our listing, falls back to catalog)
  description TEXT,
  backend_keywords TEXT,    -- generic_keyword from Listings Items (never public)
  attributes JSONB,         -- subset: flavor, size, color, unit_count, package_qty, style
  image_count INTEGER,
  status JSONB,             -- Listings Items status array (BUYABLE / DISCOVERABLE / ...)
  issues JSONB,             -- Listings Items issues (suppression reasons etc.)
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_content_brand ON listing_content(brand_id);

SELECT 'listing_content ready' AS check_name, count(*) AS rows FROM listing_content;
