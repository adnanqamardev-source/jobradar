-- 0014_reaper_lease_guard.sql — do not retire a rescore row a live worker still holds.
--
-- ## What 0013 got wrong
--
-- 0013 fixed the queue-wedging defect, and this is the gap found reviewing it, one commit later.
-- Its first reap statement retires a superseded rescore row like this:
--
--     update task_queue set status = 'done', ...
--      where status = 'running'
--        and kind = 'rescore_profile'
--        and exists (select 1 from task_queue p where p.status = 'pending' and <same profile>)
--
-- There is no lease condition. "Running, with a pending sibling" was treated as sufficient to
-- mean *superseded*, and it is not.
--
-- ## Why the state is reachable in normal operation
--
-- `runRescoreProfile` inserts its continuation row **while it is still running**: the handler
-- requeues, returns, and only then does the worker settle the original row. For that whole
-- window — however short — the original row is `running` with a *live* lease and a pending
-- sibling already exists. 0013 retired it.
--
-- The damage is not the premature `done`. It is `locked_at = null, locked_by = null`: the lease
-- is cleared under a worker that is still executing. If that worker's settle then takes the
-- retry branch (`!outcome.ok`, attempts not exhausted), it writes the row back to `pending`
-- beside the continuation it just inserted — and that is
-- `idx_task_queue_one_pending_rescore_per_profile` raising `23505` again. The same collision,
-- arriving from the opposite direction to the one 0013 fixed, in the very code path 0013 wrote
-- the guard for.
--
-- Observed by `tests/integration/claim-reaper.db.test.ts` against 0013:
--
--     AssertionError: expected 'done' to be 'running'
--
-- ## The fix
--
-- Scope the retirement to the same population the reap already targets: an **expired** lease.
-- A live worker's row is none of 0013's business, which is the correct division — 0013 exists to
-- recover from a worker that died, not to second-guess one that is still running.
--
-- The rest of the function is unchanged from 0013 and repeated here deliberately: a migration
-- cannot reference another migration's body, and `0013` is applied so it cannot be edited.

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
  -- Step 1 — retire a rescore row that is *stale* and already has a pending continuation. It is
  -- finished work: the continuation carries `resume_after` forward. The lease condition is the
  -- whole point of this migration — without it a live worker's row is retired mid-flight and its
  -- lease is cleared underneath it. See the header for the failure mode that produced.
  update public.task_queue as t
     set status     = 'done',
         locked_at  = null,
         locked_by  = null,
         updated_at = now()
   where t.status = 'running'
     and t.kind = 'rescore_profile'
     and t.locked_at is not null
     and t.locked_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 1))
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
  -- immediately due rather than sitting in a stale backoff window. The guard is what keeps the
  -- reap from violating idx_task_queue_one_pending_rescore_per_profile.
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
  'Atomically claim up to p_limit pending task_queue rows for p_worker_id using FOR UPDATE SKIP LOCKED, ordered by priority then run_after. Reaps leases older than p_lease_seconds back to pending first, except that a rescore_profile task is only reaped when no pending rescore already exists for the same profile -- otherwise the reap would violate idx_task_queue_one_pending_rescore_per_profile and abort the whole claim. A STALE running rescore with a pending continuation is retired to done, because the continuation carries the cursor; a row whose lease is still live is left alone. Does not increment attempts and does not touch run_after: the queue protocol lives in src/lib/queue/plan.ts.';

-- Restated rather than inherited: claiming is a worker capability, and `authenticated` reaching
-- it would let any signed-in user take arbitrary tasks and run work as the service role.
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from anon;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from authenticated;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from public;

grant execute on function public.claim_tasks(text, integer, public.task_kind, integer) to service_role;