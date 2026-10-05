-- 0004_fix_is_admin.sql — repair is_admin() (D15, 2026-10-05)
--
-- is_admin() read `(select auth.jwt()) ->> 'role' = 'admin'`. The top-level
-- `role` claim of a Supabase JWT is the *Postgres* role of the caller
-- ('authenticated' | 'anon' | 'service_role') — it is never 'admin'.
-- sync_profile_role_to_jwt() (0001_init.sql) writes the user's role via
-- auth.update_user(), which merges into raw_app_meta_data and therefore
-- surfaces in the JWT as `app_metadata.role`.
--
-- Result: is_admin() could never return true, so every admin RLS policy
-- (profiles_admin_select, sources_admin_write, scrape_runs_admin_read,
-- audit_logs_admin_read) silently granted nothing. This replaces the
-- function; policies keep using it unchanged.

create or replace function is_admin() returns boolean
  language sql stable as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'role', 'user') = 'admin'
$$;
