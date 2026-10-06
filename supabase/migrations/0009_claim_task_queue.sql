-- 0009_claim_task_queue.sql — the `FOR UPDATE SKIP LOCKED` claim primitive (FND-002)
--
-- ## Why this migration exists
--
-- docs/02b §6.4 specifies the claim as:
--
--   "Worker claims <= 25 tasks (FOR UPDATE SKIP LOCKED), runs each in a try/catch with a
--    5-minute lease."
--
-- `supabase-js` cannot express that statement. Its query builder composes
-- `select`/`update` calls and has no way to attach `FOR UPDATE` or `SKIP LOCKED` to a
-- read, so the only way to get the specified primitive is an RPC created here. Until this
-- migration the executors claimed by compare-and-swap (`.eq("status","pending")` on the
-- update), which preserves mutual exclusion *per task* but not batch-claim atomicity: two
-- workers can both read the same candidate list and both win on disjoint subsets.
--
-- ## What the function must not decide
--
-- Everything in `src/lib/queue/plan.ts` stays in TypeScript. This function only performs
-- the claim that `planClaim` decides is legal. Concretely:
--
--   - It does NOT increment `attempts`. docs/02b §6.4 increments on *failure*; a task
--     that succeeds three times must not arrive at its first error with retries spent.
--     Incrementing here would burn a retry on every success.
--   - It does NOT touch `run_after` on a fresh claim. `run_after` carries backoff
--     scheduling alone; the lease lives in `locked_at`/`locked_by` so that the claim's
--     `ORDER BY run_after` never mixes two clocks.
--
-- ## Reaping expired leases
--
-- A worker killed mid-task leaves the row `running` forever. `planClaim` skips any row
-- whose status is not `pending`, so the reaper has to live here, inside the same
-- transaction as the claim — otherwise orphaned tasks are stranded with nothing able to
-- pick them up. Reaping is deliberately narrow: only `running` rows whose lease is
-- older than the lease duration, never a row a live worker still holds.
--
-- ## Security
--
-- `security definer` is required because `task_queue` has RLS enabled *and forced*
-- (0001_init.sql), so the owner role would otherwise be filtered by its own policies.
--
-- The grants below follow the lesson from 0008_restrict_rescore_to_authenticated.sql:
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to `anon`,
-- `authenticated` and `service_role` explicitly, so `revoke ... from public` alone
-- removes a grant that was never there and changes nothing. Revoke per role.
--
-- Claiming is a worker capability. `authenticated` must never reach it: it would let any
-- signed-in user take arbitrary tasks and, through the handler dispatch, run work as the
-- service role.

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
  -- Reap orphaned leases first. Only rows whose lease has *expired* are touched: a row a
  -- live worker still holds keeps its lease, and `run_after` is reset so the task is
  -- immediately due rather than sitting in a stale backoff window.
  update public.task_queue as t
     set status     = 'pending',
         locked_at  = null,
         locked_by  = null,
         run_after  = now(),
         updated_at = now()
   where t.status = 'running'
     and t.locked_at is not null
     and t.locked_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 300), 1));

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
  'Atomically claim up to p_limit pending task_queue rows for p_worker_id using FOR UPDATE SKIP LOCKED, ordered by priority then run_after. Reaps leases older than p_lease_seconds back to pending first. Does not increment attempts and does not touch run_after: the queue protocol lives in src/lib/queue/plan.ts.';

-- Reclaim from the explicit default-privilege grants (see 0008's header for the proof
-- that a PUBLIC-only revoke is a no-op here) and grant only to the worker role.
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from anon;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from authenticated;
revoke execute on function public.claim_tasks(text, integer, public.task_kind, integer) from public;

grant execute on function public.claim_tasks(text, integer, public.task_kind, integer) to service_role;