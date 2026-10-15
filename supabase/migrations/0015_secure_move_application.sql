-- 0015_secure_move_application.sql — close an unauthenticated, cross-user write.
--
-- ## The defect, proven rather than reasoned about
--
-- `move_application` (0001) is `SECURITY DEFINER`, so it runs with the owner's privileges and
-- **bypasses RLS**. Its only filter is `where id = app_id` — there is no ownership check. Two
-- consequences, both measured on the linked project:
--
-- 1. `has_function_privilege('anon', 'move_application', 'EXECUTE')` was **true**. Supabase's
--    `ALTER DEFAULT PRIVILEGES` grants EXECUTE on new functions to `anon`, `authenticated` and
--    `service_role` — the same trap `0008` had to close for `enqueue_rescore_profile`.
--
-- 2. The body was reachable by an **unauthenticated** client. Called with the anon key and a
--    uuid that does not exist, the RPC returned:
--
--        P0001  Application not found
--
--    That is the function's *own* `raise exception`, not a permission error (which PostgREST
--    reports as `42501`). So `anon` reached the body. With a real `app_id` it would move that
--    application and append an `application_events` row. An authenticated caller had the same
--    reach, and because there is no ownership filter, could move **any other user's**
--    application.
--
-- The deployed site points at this same database, so the RPC is reachable there today.
--
-- ## The fix
--
-- `create or replace function` with two changes:
--
--   * the row lock and the update are both filtered by `user_id = auth.uid()`, and
--   * a row that is not the caller's is reported as **"Application not found"** rather than
--     "not yours", so the function cannot be used to probe which application ids exist.
--
-- `auth.uid()` is null for `anon`, and `user_id = null` matches nothing, so the ownership filter
-- denies the unauthenticated case with the same code path as the wrong-user case. There is no
-- separate branch to get wrong.
--
-- The signature `(app_id uuid, to_stage app_stage, note text default null)` is reproduced
-- **exactly**, including order and the default. This is not pedantry: `CREATE OR REPLACE FUNCTION`
-- replaces by signature, so any difference in parameter order creates a *second, overloaded*
-- function and leaves the vulnerable original installed and callable. An earlier draft of this
-- file ordered them `(app_id, note, to_stage)` — which fails outright with SQLSTATE 42P13
-- ("input parameters after one with a default value must also have defaults") because `note`
-- carries the default. Same hazard, caught by the database rather than by review.
--
-- The transition rules are copied verbatim. They are correct, and the bug here is about
-- *ownership*, not about which moves are legal.

create or replace function public.move_application(
  app_id uuid,
  to_stage public.app_stage,
  note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_app public.applications%rowtype;
  v_from public.app_stage;
begin
  -- Lock the application row, scoped to the caller.
  --
  -- `for update` with the ownership predicate means the lock is only taken on a row this caller
  -- owns, so one user's move can neither block nor leak another's.
  select * into v_app
    from public.applications
   where id = app_id
     and user_id = auth.uid()
   for update;

  -- One message for "does not exist", "is not yours", and "you are not signed in". Anything more
  -- specific turns the function into an existence oracle for application ids.
  if not found then
    raise exception 'Application not found';
  end if;

  v_from := v_app.stage;

  if v_from = to_stage then
    raise exception 'Already in target stage';
  end if;

  -- Valid transitions, unchanged from 0001.
  if v_from = 'discovered' and to_stage not in ('saved') then
    raise exception 'Invalid transition from discovered';
  end if;
  if v_from = 'saved' and to_stage not in ('applied','discovered') then
    raise exception 'Invalid transition from saved';
  end if;
  if v_from = 'applied' and to_stage not in ('screening','rejected','withdrawn') then
    raise exception 'Invalid transition from applied';
  end if;
  if v_from = 'screening' and to_stage not in ('interview','rejected','withdrawn') then
    raise exception 'Invalid transition from screening';
  end if;
  if v_from = 'interview' and to_stage not in ('offer','rejected','withdrawn') then
    raise exception 'Invalid transition from interview';
  end if;
  if v_from = 'offer' and to_stage not in ('rejected','withdrawn') then
    raise exception 'Invalid transition from offer';
  end if;
  if v_from in ('rejected','withdrawn') then
    raise exception 'Cannot transition from terminal stage';
  end if;

  update public.applications
     set stage = to_stage,
         updated_at = now(),
         next_action_at = case when to_stage = 'applied' then null else next_action_at end
   where id = app_id
     and user_id = auth.uid();

  -- Append-only history, in the same transaction as the stage write. `to_stage` is not null and
  -- the `from_stage` of the first event is null, which is how TRK-001's initial row is shaped.
  insert into public.application_events (application_id, from_stage, to_stage, note)
  values (app_id, v_from, to_stage, note);
end;
$$;

comment on function public.move_application(uuid, public.app_stage, text) is
  'Move an application between stages and append an application_events row, transactionally. SECURITY DEFINER, so it bypasses RLS and therefore filters on user_id = auth.uid() itself: a caller can only move their own application, and a missing, unowned, or unauthenticated row is reported identically as "Application not found" so the function is not an existence oracle. Invalid transitions raise. Granted to authenticated and service_role only.';

-- Revoked per role rather than from PUBLIC alone, for the reason 0008 documents: Supabase grants
-- EXECUTE via ALTER DEFAULT PRIVILEGES to anon/authenticated/service_role individually, so
-- `revoke ... from public` would remove a grant that was never there and change nothing.
revoke execute on function public.move_application(uuid, public.app_stage, text) from anon;
revoke execute on function public.move_application(uuid, public.app_stage, text) from public;

grant execute on function public.move_application(uuid, public.app_stage, text) to authenticated;
grant execute on function public.move_application(uuid, public.app_stage, text) to service_role;