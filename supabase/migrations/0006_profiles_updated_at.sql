-- 0006_profiles_updated_at.sql — make `profiles.updated_at` actually move (2026-10-06)
--
-- ## The defect
--
-- docs/03 §5.2 requires: "Concurrent edits (two tabs) → `updated_at`
-- optimistic-concurrency check → 'This changed in another tab. Reload to see the
-- latest.'"
--
-- `lib/db/profile-update.ts` implements that by scoping the UPDATE to the
-- `updated_at` the caller last read. But `profiles.updated_at` only ever had
-- `default now()`, which applies to INSERT. No trigger touched it on UPDATE, so
-- the column was byte-identical before and after every write.
--
-- The guard therefore always matched: it looked correct, passed every test, and
-- never once detected a conflict. Two tabs editing a profile still silently
-- clobbered each other — exactly the behaviour the guard was written to prevent.
-- `resumes` has had `resumes_updated_at` since 0002; `profiles` was missed.
--
-- Found by `tests/integration/profile-mutations.db.test.ts`, which asserts against
-- a real Postgres. The unit tests could not have caught it: they mock Supabase, so
-- the mock asserted its own `.eq()` calls and never asked whether the column moves.
--
-- ## The fix
--
-- Reuse `update_updated_at_column()` from 0002 rather than defining a new function —
-- two functions doing the same thing is how `profiles` got missed the first time.
-- Forward-only: this is a new migration, and 0001..0005 are untouched.

create trigger profiles_updated_at
  before update on profiles
  for each row
  execute function update_updated_at_column();

-- ===================================================================
-- Backfill rows written before this trigger existed
-- ===================================================================
--
-- Existing rows carry an `updated_at` equal to their `created_at` (insert-time
-- `now()`), which is now indistinguishable from "never written since". Bump them
-- so the first post-migration edit has a value to conflict against. The guard is
-- opt-in (`expectedUpdatedAt` is optional), so this only affects callers that
-- opted in — but an unbackfilled row would let a stale first write through.
update profiles set updated_at = now() where updated_at = created_at;