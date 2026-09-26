-- Enable Row Level Security on every public table (Supabase advisory
-- rls_disabled_in_public, 2026-09-26: "anyone with your project URL can
-- read, edit, and delete all data"). The dashboard, crons, MCP bridge and
-- scripts all talk to Supabase with the SERVICE key, which bypasses RLS —
-- so this changes nothing for the app. With RLS on and NO policies, the
-- anon/authenticated API roles are deny-all, which closes the hole.
--
-- Dynamic so new tables created before this ran are covered too; runs at
-- every boot via BOOT_MIGRATIONS and is idempotent (only touches tables
-- with RLS still off). Any future table gets RLS from the next boot.

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE schemaname = 'public' AND NOT rowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', t.schemaname, t.tablename);
    RAISE NOTICE 'RLS enabled on %.%', t.schemaname, t.tablename;
  END LOOP;
END $$;

-- Verification: zero public tables left without RLS.
SELECT count(*) AS public_tables_without_rls
FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity;
