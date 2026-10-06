-- 0005_handle_new_user.sql — create a profiles row on signup (BE-304)
-- Depends on: 0001_init.sql
-- Forward-only. Never edit an applied migration — 0001..0004 are already on the
-- hosted project.
--
-- Why a trigger and not application code:
--
--   Signup can arrive by three routes — magic link, Google OAuth, and OTP — and
--   three code paths that each remember to create the row is three chances to
--   forget. A user with no `profiles` row is not a partial signup, it is a user
--   the scorer, the feed and every RLS policy treats as nonexistent. One trigger
--   on `auth.users` makes that state unreachable.
--
-- Security:
--
--   SECURITY DEFINER because the trigger fires inside the auth service's insert,
--   where the caller is not yet an authenticated principal and RLS on `profiles`
--   would reject the row. `profiles` also has FORCE ROW LEVEL SECURITY, so the
--   function owner needs the bypass role to insert at all — on Supabase that is
--   `postgres`, which is why this must be definer and not invoker.
--
--   `set search_path = ''` with every name fully qualified. A mutable search_path
--   on a SECURITY DEFINER function is the standard privilege-escalation hole: any
--   caller able to create a schema could shadow `auth` or `public` and run code as
--   the definer. There is one dynamic lookup here, `raw_user_meta_data`, and it
--   belongs to the auth-owned record, not to the caller's namespace.
--
--   Role is never read from user metadata. `raw_user_meta_data` is user-writable
--   through the client SDK, so `role` there would be self-assignment — exactly what
--   docs/03 §3.2 forbids. Admin comes only from the one-time bootstrap (BE-302 /
--   AUT-004) or a direct update by an operator.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- `profiles.email` is NOT NULL and UNIQUE. Every auth method this app offers
  -- (magic link, Google, OTP) supplies an email, so this fallback exists only for a
  -- phone-only signup — and it is derived from the user id so two such users can
  -- never collide on the unique index. Coalescing every null to '' would.
  v_email text := coalesce(new.email, new.id::text || '@no-email.invalid');
begin
  -- Guarded against BOTH unique indexes on `profiles`: `id` and `email`.
  --
  -- `on conflict (id)` alone handles only the primary key. `email` is also unique, so a
  -- signup whose address already has a profile row would raise `unique_violation` *inside*
  -- this AFTER INSERT trigger — which aborts the `auth.users` insert, and the user gets no
  -- session at all. A profile-creation failure must never be able to break sign-in.
  --
  -- Reachable in practice? `auth.users.email` is itself unique, so a live duplicate signup
  -- is normally rejected upstream by GoTrue before this trigger runs. "Normally" is not
  -- "provably never" — an operator-inserted auth row, or a future provider that does not
  -- deduplicate, would hit it. The guard costs one clause and removes the question.
  --
  -- No arbiter: bare `on conflict do nothing` covers every unique constraint at once. Naming
  -- two targets as `on conflict (id) do nothing on conflict (email) do nothing` is a **syntax
  -- error** — Postgres allows one arbiter clause per INSERT — which `pnpm db:reset` caught.
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    v_email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    nullif(new.raw_user_meta_data ->> 'avatar_url', '')
  )
  on conflict do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Creates the profiles row for a new auth user. Role is deliberately not taken from user metadata — see docs/03 §3.2.';

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();