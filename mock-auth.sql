-- Mock auth functions for local development (not for production)
create schema if not exists auth;

create or replace function auth.uid() returns uuid language sql stable as $$
  select '00000000-0000-0000-0000-000000000000'::uuid;
$$;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select '{}'::jsonb;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select 'authenticated';
$$;

-- Re-create is_admin
create or replace function is_admin() returns boolean
language sql stable as $$
  select coalesce((select auth.jwt()) ->> 'role', 'user') = 'admin';
$$;