-- P4: relational projection of PO line items for reporting.
-- Run once in Supabase SQL Editor (https://supabase.com/dashboard/project/tbzfrvyickrwgyujhrmi/sql/new).
-- Idempotent / safe to re-run — the lines table is a pure projection of
-- purchase_orders.data->'lines', which remains the source of truth.

-- ── purchase_order_lines: one row per PO line, queryable for reporting ──────
CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  po_id         uuid NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  seq           int  NOT NULL,                 -- line order within the PO
  line_type     text NOT NULL DEFAULT 'single',-- single | multipack | bundle-header | bundle-component
  asin          text,
  description   text,
  upc           text,
  stock_number  text,
  unit_price    numeric(12,2) NOT NULL DEFAULT 0,  -- buy cost per supplier unit
  quantity      int           NOT NULL DEFAULT 0,  -- supplier units ordered
  case_pack     int,
  cases         int,
  -- Line spend, always derived so the math can never be inconsistent. Bundle
  -- header rows carry unit_price 0 (components hold the real cost), so summing
  -- extended_cost across a PO never double-counts.
  extended_cost numeric(14,2) GENERATED ALWAYS AS (unit_price * quantity) STORED,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS po_lines_po_id_idx ON public.purchase_order_lines (po_id);
CREATE INDEX IF NOT EXISTS po_lines_asin_idx  ON public.purchase_order_lines (asin);

-- ── Backfill from existing PO data blobs ────────────────────────────────────
-- Rebuild from scratch: the table is a projection, so a clean rebuild is the
-- idempotent operation. Includes soft-deleted POs (reports filter them out by
-- joining purchase_orders.deleted_at); purged POs cascade-delete their lines.
DELETE FROM public.purchase_order_lines;

INSERT INTO public.purchase_order_lines
  (po_id, seq, line_type, asin, description, upc, stock_number, unit_price, quantity, case_pack, cases)
SELECT
  po.id,
  (elem.ord - 1)::int,
  COALESCE(elem.line->>'_type', 'single'),
  elem.line->>'asin',
  elem.line->>'description',
  elem.line->>'upc',
  elem.line->>'stockNumber',
  COALESCE(NULLIF(elem.line->>'price', '')::numeric, 0),
  COALESCE(NULLIF(elem.line->>'quantity', '')::numeric, 0)::int,
  NULLIF(elem.line->>'casePack', '')::numeric::int,
  NULLIF(elem.line->>'cases', '')::numeric::int
FROM public.purchase_orders po
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(po.data->'lines') = 'array' THEN po.data->'lines' ELSE '[]'::jsonb END
) WITH ORDINALITY AS elem(line, ord);
