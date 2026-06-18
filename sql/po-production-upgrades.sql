-- Production upgrades to the PO Builder data layer.
-- Run once in Supabase SQL Editor (https://supabase.com/dashboard/project/tbzfrvyickrwgyujhrmi/sql/new).
-- All migrations are idempotent / safe to re-run.

-- ── purchase_orders: audit log + soft delete ────────────────────────────────
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS deleted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by  text,
  ADD COLUMN IF NOT EXISTS audit_log   jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS purchase_orders_deleted_at_idx ON public.purchase_orders (deleted_at);
CREATE INDEX IF NOT EXISTS purchase_orders_updated_at_idx ON public.purchase_orders (updated_at DESC);

-- ── po_drafts: cloud-stored work-in-progress (replaces localStorage) ───────
CREATE TABLE IF NOT EXISTS public.po_drafts (
  -- Key = 'new:<brand_id>' for a fresh draft on a brand, or 'po:<purchase_order_uuid>' for editing an existing PO
  key            text PRIMARY KEY,
  brand_id       text,
  current_po_id  uuid,
  data           jsonb NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS po_drafts_updated_at_idx ON public.po_drafts (updated_at DESC);
CREATE INDEX IF NOT EXISTS po_drafts_brand_idx      ON public.po_drafts (brand_id);
