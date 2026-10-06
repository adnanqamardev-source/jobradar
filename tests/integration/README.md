# Integration tests — local Postgres

Unit tests for DB-facing code mock Supabase, and a mock *defines* the answer: it
cannot fail unless someone already suspects the bug. Three defects in the BE-304
profile write paths shipped through a fully green suite because of this.

`tests/integration/*.db.test.ts` run against a real local Supabase stack.

## Running

```bash
pnpm db:reset                       # brings up the local stack and applies migrations

$env:TEST_SUPABASE_URL          = "http://127.0.0.1:54321"
$env:TEST_SUPABASE_SERVICE_ROLE = "<service_role key from the local stack>"
pnpm vitest run tests/integration
```

Without both variables the suite **skips** rather than failing. CI has no local
Postgres, and a red suite for "no database" trains people to ignore red.

The service-role key comes from the local stack only:

```bash
docker exec supabase_studio_jobradar printenv | Select-String '^SUPABASE_SECRET_KEY='
```

Never paste that value anywhere, and never point these tests at production. The
suite refuses to run unless the URL is `127.0.0.1` / `localhost`, and everything it
creates is tagged `integration-be304-` and removed in `afterAll`.

## Known failure

`profile-mutations.db.test.ts` has one **expected-to-fail** test,
`BUG: profiles.updated_at does not move on UPDATE`. `profiles` has no
`updated_at` trigger (only a `now()` default, which applies to INSERT) — unlike
`resumes`, which has `resumes_updated_at`. So the optimistic-concurrency guard in
`lib/db/profile-update.ts` can never detect a conflict: `updated_at` is identical
before and after a write.

It is left failing on purpose, as a pin on the fix. Adding migration `0006`
(`profiles_updated_at` BEFORE UPDATE trigger) turns it green. Do not "fix" it by
deleting or skipping the test.