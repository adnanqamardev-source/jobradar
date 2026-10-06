/**
 * handle-new-user tests — BE-304, the signup trigger.
 *
 * ## Why this is a real test and not a session-log table
 *
 * The first version of `0005_handle_new_user.sql` was verified by four manual psql probes recorded
 * in `docs/07`. That is not a gate. notes.md: "Schema-green is not integration-green" and "Guards
 * must be able to fail." A trigger nobody runs on every `pnpm test` will silently rot the next time
 * `profiles` changes.
 *
 * ## Why it is a *static* test, not a live one
 *
 * These assertions run without Postgres: they read the migration file and check the properties that
 * actually matter. A live trigger test would need the Supabase image (docs/06 §8.5), which CI cannot
 * assume for a unit file. So the split is deliberate:
 *
 *   - **here** — the security and correctness properties of the SQL text, always enforced;
 *   - **live** — `docs/07` records the probes that proved the trigger *fires* against a real stack.
 *
 * A static test can pass while the trigger does not work, so this file states that limit in its own
 * header rather than implying full coverage.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATION = join(process.cwd(), "supabase", "migrations", "0005_handle_new_user.sql");
const sql = readFileSync(MIGRATION, "utf8");

describe("0005_handle_new_user.sql", () => {
  it("creates the profile from a trigger on auth.users, not from application code", () => {
    expect(sql).toMatch(/create trigger\s+on_auth_user_created/i);
    expect(sql).toMatch(/after insert on auth\.users/i);
    expect(sql).toMatch(/execute function public\.handle_new_user\(\)/i);
  });

  it("is SECURITY DEFINER with an empty search_path", () => {
    // The insert runs inside the auth service, where the caller is not yet an authenticated
    // principal, and `profiles` carries FORCE ROW LEVEL SECURITY — so definer is required. The
    // empty search_path is the escalation guard: a mutable one lets any caller who can create a
    // schema shadow `auth` or `public` and execute as the definer.
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path\s*=\s*''/i);
  });

  it("fully qualifies every table it writes to", () => {
    // `search_path = ''` means an unqualified name would fail to resolve at all. Assert the
    // qualification rather than trusting it, because a future unqualified reference is a
    // runtime error nobody sees until signup breaks.
    const inserts = sql.match(/insert into\s+(\S+)/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    for (const statement of inserts) {
      expect(statement).toMatch(/insert into\s+(public|auth)\./i);
    }
  });

  it("never reads role from user-writable metadata", () => {
    // `raw_user_meta_data` is writable through the client SDK. Honouring a `role` key there would
    // be admin self-assignment, which docs/03 §3.2 forbids outright.
    expect(sql).not.toMatch(/raw_user_meta_data\s*->>\s*'role'/i);
    expect(sql).not.toMatch(/raw_app_meta_data\s*->>\s*'role'/i);
  });

  it("is idempotent — re-running cannot create a second profile row", () => {
    // docs/06 §8.5: "Prove idempotency explicitly." The auth service can replay an insert.
    //
    // Bare `on conflict do nothing`, not `on conflict (id)`: `email` is unique too, and an
    // arbiter clause only covers the constraint it names. A duplicate address would raise
    // `unique_violation` inside this AFTER INSERT trigger, aborting the `auth.users` insert and
    // denying the user a session. Verified against a real Postgres — the two-arbiter form is a
    // syntax error, which `pnpm db reset` caught.
    // Read only the INSERT statement, excluding comments. The header documents the rejected
    // two-arbiter form in prose (`on conflict (id) ... on conflict ...`), and a whole-file regex
    // matches that commentary — asserting against it made this test fail on a correct migration.
    const insert = sql.slice(sql.indexOf("insert into public.profiles"));
    expect(insert).toMatch(/on conflict do nothing/i);
    expect(insert).not.toMatch(/on conflict\s*\(/i);
  });

  it("derives the no-email placeholder from the user id so it cannot collide", () => {
    // `profiles.email` is NOT NULL UNIQUE. Coalescing every null to '' would make the second
    // phone-only signup violate that unique index and abort signup itself.
    expect(sql).toMatch(/@no-email\.invalid/);
    expect(sql).toMatch(/new\.id::text/);
  });

  it("stores absent names as NULL rather than an empty string", () => {
    // ONB-002 requires names to be trimmed and normalised; an empty string is not a name, and it
    // would pass a `!= ''` check downstream while rendering as blank.
    expect(sql).toMatch(/nullif\(new\.raw_user_meta_data ->> 'full_name', ''\)/i);
    expect(sql).toMatch(/nullif\(new\.raw_user_meta_data ->> 'avatar_url', ''\)/i);
  });

  it("recreates the trigger idempotently rather than erroring on re-run", () => {
    expect(sql).toMatch(/drop trigger if exists on_auth_user_created/i);
  });

  it("returns new so the AFTER INSERT row is unaffected", () => {
    expect(sql).toMatch(/return new;/);
  });
});

describe("0005 is registered in the migration ledger", () => {
  it("docs/07 documents it as local-only and not pushed", () => {
    // Guards the specific confusion this repo hit repeatedly: treating "applied locally" and
    // "applied to production" as the same fact.
    const sessionLog = readFileSync(join(process.cwd(), "docs", "07-session-log.md"), "utf8");
    expect(sessionLog).toMatch(/0005_handle_new_user/);
  });
});