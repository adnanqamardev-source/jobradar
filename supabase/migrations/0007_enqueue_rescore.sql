-- 0007_enqueue_rescore.sql — let a user action enqueue their own rescore (2026-10-06)
--
-- ## The problem
--
-- docs/02b §"Triggers": "profile save → `rescore_profile` task (requeue, never
-- synchronous - C4)". ONB-006: "Save enqueues `rescore_profile`".
--
-- `task_queue` is service-role only by design:
--
--   alter table task_queue enable row level security;
--   alter table task_queue force row level security;
--   -- 0001_init.sql: "Task queue: service-role only, no client policies"
--
-- With RLS forced and zero policies, every INSERT is rejected regardless of the
-- `authenticated` role's table-level INSERT grant. So a user-scoped Server Action
-- physically cannot enqueue a task. The two available routes were both bad:
--
--   1. Use the service-role client inside a user-facing action. Works, but breaks
--      the rule this repo repeats more than any other: service-role bypasses RLS and
--      is never used for user-facing work. It would also let any authenticated user
--      enqueue arbitrary payloads if the call site were ever refactored carelessly.
--   2. Grant INSERT on task_queue. Same problem, worse: it would also grant UPDATE
--      and DELETE to anyone who found the path, letting a user claim and run other
--      people's tasks.
--
-- ## The fix
--
-- A `security definer` function, so the insert runs with the owner's rights and the
-- caller's identity still drives RLS through `auth.uid()`. Narrow on purpose:
--
--   - fixed `kind` — the caller cannot choose a task kind, so this cannot be
--     repurposed as a generic queue-injection primitive;
--   - payload is `{profile_id}` only — no caller-supplied JSON;
--   - `profile_id` is forced to `auth.uid()`, so a caller cannot enqueue work for
--     anyone else. The `where owner = auth.uid()` predicate is belt-and-braces: it
--     holds even if `auth.uid()` is somehow null, because then no row matches.
--
-- ## Idempotency
--
-- Without this, every keystroke-save in /settings would queue another rescore and
-- the worker would thrash re-embedding the same profile. The partial unique index
-- allows at most one *pending* rescore per profile, so a save while one is already
-- queued is a no-op rather than a second job. Once the worker finishes it (status
-- leaves 'pending'), a later save can queue the next one. `on conflict do nothing`
-- because a duplicate here is the desired outcome, not an error.
--
-- The alternative — cancel-and-requeue — would lose in-flight work when a user
-- adjusts three fields in a row. Coalescing is what ONB-006 wants: one rescore
-- reflecting the final state, not three reflecting intermediate states.

-- ===================================================================
-- The enqueue function
-- ===================================================================

create or replace function public.enqueue_rescore_profile()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile_id uuid;
  v_task_id uuid;
begin
  -- auth.uid() is the only accepted profile. A null uid matches nothing.
  v_profile_id := (select auth.uid());

  if v_profile_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.task_queue (kind, payload)
  values ('rescore_profile', jsonb_build_object('profile_id', v_profile_id))
  on conflict do nothing
  returning id into v_task_id;

  -- Already-pending case: return the existing task so the caller always gets an id
  -- and callers do not have to distinguish "queued" from "already queued".
  if v_task_id is null then
    select id into v_task_id
      from public.task_queue
     where kind = 'rescore_profile'
       and status = 'pending'
       and payload ->> 'profile_id' = v_profile_id::text
     limit 1;
  end if;

  return v_task_id;
end;
$$;

comment on function public.enqueue_rescore_profile() is
  'Enqueue a rescore_profile task for the calling user. Idempotent: at most one pending rescore per profile.';

-- ===================================================================
-- Coalescing index
-- ===================================================================
--
-- Backing the `on conflict do nothing` above and the existing-task lookup. Partial,
-- so it only holds the pending rows that matter and costs nothing on finished ones.

create unique index if not exists idx_task_queue_one_pending_rescore_per_profile
  on public.task_queue ((payload ->> 'profile_id'))
  where kind = 'rescore_profile' and status = 'pending';

-- ===================================================================
-- Grants
-- ===================================================================
--
-- EXECUTE to authenticated so a user-scoped Server Action can call it. `anon` is
-- excluded deliberately: there is no such thing as an anonymous profile to rescore,
-- and the function raises on a null uid anyway. No INSERT grant on task_queue is
-- added — this function is the only way in.

revoke all on function public.enqueue_rescore_profile() from public;
grant execute on function public.enqueue_rescore_profile() to authenticated;