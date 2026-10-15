-- 0013_reaper_guard_and_orphan_cleanup.sql — stop `claim_tasks` from wedging the whole queue.
--
-- ## The defect, observed
--
-- `claim_tasks` (0009) opens with a reaper that resets expired leases:
--
--     update task_queue set status = 'pending'
--      where status = 'running' and locked_at < now() - interval
--
-- It has no knowledge of `idx_task_queue_one_pending_rescore_per_profile` (0007), the partial
-- unique index that permits **one pending rescore per profile**. So when a profile holds both a
-- stale `running` row and a `pending` row, the reap tries to create a second pending row for
-- that profile, Postgres raises
--
--     duplicate key value violates unique constraint
--     "idx_task_queue_one_pending_rescore_per_profile"
--
-- and because the reap is the first statement of the function, the **whole transaction
-- aborts**. `claim_tasks` throws, `/api/cron/process` answers `500 {"error":"claim_failed"}`,
-- and *no task for any user is claimable*. One stale lease pair is enough to stop scoring for
-- the entire project, permanently — the failure is self-sustaining, because the reaper that
-- causes it is the code that would have cleared it.
--
-- Observed on the linked project: `{"error":"claim_failed"}` on every call, with one profile
-- holding a `running` row last touched at 13:55 and a `pending` row created at 14:00.
--
-- ## How the state arises
--
-- `runRescoreProfile` requeues by inserting a *continuation* row carrying `resume_after`
-- (`rescore-store.ts`). The worker then settles the original row. If the process dies between
-- those two writes, the profile is left with a stale `running` row (expired lease) **and** the
-- pending continuation. The next `claim_tasks` call then wedges. docs/02b §6.4's batching rule
-- makes this a normal occurrence rather than an exotic one: any worker interrupted mid-batch
-- produces exactly this pair.
--
-- ## The fix is a function replacement, not a one-off statement
--
-- An earlier draft of this file "fixed" the problem with standalone UPDATEs run once. That
-- would have cleared today's wedge and left the bug completely intact — the reap lives inside
-- `claim_tasks`, so it would wedge again on the next interrupted worker. The guarded reap below
-- is inside the replaced function body, where it actually runs on every claim.
--
-- The reap is now two statements, and the order matters:
--
-- 1. **Retire superseded rows.** A stale `running` rescore row that already has a `pending`
--    sibling is finished work: the continuation carries the cursor forward, so the predecessor
--    is `done`, not `pending`. That is the truthful terminal state, and it also removes the row
--    from the reap's reach.
-- 2. **Guard the reap.** Any other `rescore_profile` row is resurrected only when no pending
--    sibling exists, so the partial unique index can never be violated whatever state the queue
--    is in.
--
-- Step 2's guard reads the *post-step-1* state, which is what makes "a pending sibling exists"
-- mean "one that step 1 did not already retire".
--
-- ## Residual, stated rather than hidden
--
-- Two or more stale `running` rescore rows for one profile with **no** pending row: step 1 does
-- not fire (nothing to retire) and step 2's guard blocks both from resurrecting, so they stay
-- `running`. Not reachable through the enqueue path — the partial index makes one pending row
-- per profile a database invariant — and harmless: a later profile save enqueues a fresh pending
-- task, which is claimed normally. Tidying long-dead rows is an ops decision, not a correctness
-- one, so it is not done here.
--
-- ## Orphan cleanup
--
-- `task_queue.payload` is `jsonb` and so cannot carry a foreign key. Deleting an auth user
-- cascades through `profiles` but leaves every queued task behind, and the worker keeps claiming
-- tasks for profiles that no longer exist. Measured before this migration: **95 of 100 pending
-- rescore tasks referenced a deleted profile.** The DELETE at the end clears them.
--
-- The durable fix is a real foreign key, which a jsonb payload cannot express. `tests/e2e/support/auth.ts`
-- now deletes a user's tasks before deleting the user, so the E2E suite stops adding to this; an
-- account deleted through any other path (the Supabase dashboard, say) will still leave orphans.
-- That gap is real and still open.

-- ---------------------------------------------------------------------------
-- The durable fix: the reap inside claim_tasks.
-- ---------------------------------------------------------------------------
create or replace function public.claim_tasks(
  p_worker_id      text,
  p_limit          integer default 25,
  p_kind           public.task_kind default null,
  p_lease_seconds  integer default 300
)
returns setof public.task_queue
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effective_limit integer := greatest(1, least(coalesce(p_limit, 25), 100));
begin
  -- Step 1 — retire rescore rows whose continuation is already queued. See the header for why
  -- this must run before the reap rather than inside it.
  update public.task_queue as t
     set status     = 'done',
         locked_at  = null,
         locked_by  = null,
         updated_at = now()
   where t.status = 'running'
     and t.kind = 'rescore_profile'
     and exists (
           select 1
             from public.task_queue as p
            where p.kind = 'rescore_profile'
              and p.status = 'pending'
              -- Text comparison, deliberately: `(payload->>'profile_id')::uuid` throws on any
              -- payload that is not a uuid, and one malformed row must not abort the reap for
              -- every other user.
              and (p.payload ->> 'profile_id') = (t.payload ->> 'profile_id')
         );

  -- Step 2 — reap remaining expired leases. Only rows whose lease has *expired* are touched: a
  -- row a live worker still holds keeps its lease, and `run_after` is reset so the task is
  -- immediately due rather than sitting in a stale backoff window.
  update public.task_queue as t
     set status     = 'pending',
         locked_at  = null,
         locked_by  = null,
         run_after  = now(),
         updated_at = now()
   where t.status = 'running'
     and t.locked_at is not null
     and t.locked_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 1))
     and not (
       t.kind = 'rescore_profile'
       and exists (
             select 1
               from public.task_queue as p
              where p.kind = 'rescore_profile'
                and p.status = 'pending'
                and p.id <> t.id
                and (p.payload ->> 'profile_id') = (t.payload ->> 'profile_id')
           )
         );

  return query
  with candidates as (
    select t.id
      from public.task_queue as t
     where t.status = 'pending'
       and (t.run_after is null or t.run_after <= now())
       and (p_kind is null or t.kind = p_kind)
     order by t.priority asc, t.run_after asc nulls last, t.created_at asc
     -- The two clauses docs/02b §6.4 requires. `skip locked` is what makes a second
     -- worker fall through to the next candidate instead of blocking on — or
     -- double-claiming — the rows the first worker is holding.
     for update skip locked
     limit v_effective_limit
  )
  update public.task_queue as t
     set status     = 'running',
         locked_at  = now(),
         locked_by  = p_worker_id,
         updated_at = now()
    from candidates as c
   where t.id = c.id
  returning t.*;
end;
$$;

comment on function public.claim_tasks(text, integer, public.task_kind, integer) is
  'Atomically claim up to p_limit pending task_queue rows for p_worker_id using FOR UPDATE SKIP LOCKED, ordered by priority then run_after. Reaps leases older than p_lease_seconds back to pending first, except that a rescore_profile task is only reaped when no pending rescore already exists for the same profile -- otherwise the reap would violate idx_task_queue_one_pending_rescore_per_profile and abort the whole claim. A stale running rescore with a pending continuation is retired to done instead, because the continuation carries the cursor. Does not increment attempts and does not touch run_after: the queue protocol lives in src/lib/queue/plan.ts.';

-- The grants are restated because `create or replace function` keeps the existing ones; 0009
-- revoked PUBLIC and granted only service_role, and claiming must stay a worker capability --
-- `authenticated` reaching it would let any signed-in user take arbitrary tasks and run work as
-- the service role. Restated so this file is self-contained rather than depending on 0009's
-- grants having survived.
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from anon;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from authenticated;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from public;

grant execute on function public.claim_tasks(text, integer, public.task_kind, integer) to service_role;

-- ---------------------------------------------------------------------------
-- One-time purge of tasks whose profile no longer exists.
--
-- Scoped to rows that actually carry a `profile_id`: `ingest_source` payloads carry `source_id`
-- instead, and a NULL `profile_id` must not read as "orphaned".
-- ---------------------------------------------------------------------------
delete from public.task_queue as t
 where t.payload ? 'profile_id'
   and t.payload ->> 'profile_id' is not null
   and not exists (
         select 1
           from public.profiles as p
          where p.id::text = t.payload ->> 'profile_id'
       );