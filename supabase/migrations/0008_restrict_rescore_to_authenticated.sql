-- 0008_restrict_rescore_to_authenticated.sql — anon must not enqueue (2026-10-06)
--
-- ## Why a separate migration
--
-- `0007_enqueue_rescore.sql` ended with:
--
--   revoke all on function public.enqueue_rescore_profile() from public;
--   grant execute on function public.enqueue_rescore_profile() to authenticated;
--
-- That looked right and was not. Supabase configures ALTER DEFAULT PRIVILEGES in the
-- `public` schema so that `anon`, `authenticated` and `service_role` receive EXECUTE
-- on every newly created function. Those are *explicit* per-role grants, not the
-- PUBLIC grant, so `revoke ... from public` removed a grant that was never there and
-- changed nothing.
--
-- Verified on the local stack rather than assumed — the ACL came back as:
--
--   {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
--
-- `anon=X/postgres` means any unauthenticated caller could invoke the function.
--
-- ## Impact while 0007 was live
--
-- Small, but real: the function raises on a null `auth.uid()`, so an anon call errors
-- rather than enqueueing anything. There is no unauthenticated profile to rescore, and
-- the function ignores caller-supplied profile ids entirely. So this is a hardening fix
-- — deny a capability nobody should have had — not a fix for an exploitable hole. It was
-- never applied to production.
--
-- ## The fix
--
-- Revoke explicitly from the roles that should not have it, rather than from `public`.
-- Doing it per-role is what actually works against default privileges, and it also
-- documents intent: `authenticated` may enqueue its own rescore, `anon` may not.

revoke execute on function public.enqueue_rescore_profile() from anon;
revoke execute on function public.enqueue_rescore_profile() from public;

-- Re-assert, in case a prior default-privilege grant is ever revoked wholesale.
grant execute on function public.enqueue_rescore_profile() to authenticated;

-- `service_role` keeps EXECUTE via its own default grant and via bypassrls; workers
-- and admin tooling legitimately enqueue rescore tasks for other profiles, which this
-- function deliberately does not permit (it is hard-wired to auth.uid()). Those callers
-- should insert into task_queue directly with the service-role client.
comment on function public.enqueue_rescore_profile() is
  'Enqueue a rescore_profile task for the calling user. Idempotent: at most one pending rescore per profile. Callable by authenticated only; service-role callers wanting to rescore another profile should insert into task_queue directly.';