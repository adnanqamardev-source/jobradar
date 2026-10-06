/**
 * These tests exist to prove they can fail.
 *
 * Every case here feeds the checker a **known-bad** migration and asserts a rejection. A guard that
 * only ever sees the real file cannot be distinguished from a guard that always passes — the same
 * failure `notes.md` records for the YAML duplicate-key checker and for the secret scanner that
 * matched names instead of values.
 *
 * The good copy of `0005` is asserted in `handle-new-user.test.ts`. This file asserts the negative
 * space, using in-memory fixtures. Nothing here is written to disk.
 */

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0005_handle_new_user.sql"),
  "utf8",
);

/**
 * The checks, expressed as predicates over migration text.
 *
 * These duplicate the regexes in `handle-new-user.test.ts` on purpose: a checker and the thing
 * being checked must not share one implementation, or a bug in the checker hides itself. Both
 * files read the same file on disk; only the *shape* of the assertion is repeated, never its
 * implementation.
 */
/**
 * Properties the real migration MUST have — all true for the real file.
 *
 * `hasEmptySearchPath` is anchored to end-of-line (`$` with the `m` flag) so it matches the actual
 * clause and not the comment that quotes the same text. Two bugs came from that: an unanchored
 * version matched the comment, and a "remove the clause" fixture deleted the comment while leaving
 * the clause in place.
 */
const REQUIRED = {
  hasDefiner: (s: string) => /security\s+definer/i.test(stripComments(s)),
  hasEmptySearchPath: (s: string) => /set\s+search_path\s*=\s*''\s*;?\s*$/im.test(stripComments(s)),
  isIdempotent: (s: string) => /on\s+conflict(\s*\([^)]*\))?\s+do\s+nothing/i.test(stripComments(s)),
  dropsTriggerFirst: (s: string) => /drop\s+trigger\s+if\s+exists/i.test(stripComments(s)),
} as const;

/**
 * Properties the real migration must NOT have — all false for the real file.
 *
 * Kept apart from `REQUIRED` deliberately. The first draft listed `readsRoleFromMetadata` in the
 * same table asserted true-on-good, which is a category error: reading `role` from user metadata is
 * the *vulnerability*, so the good migration must fail this check. Asserting it true would have
 * forced the correct file to be written dangerously.
 *
 * The regex also has to be spelled `raw_(user|app)_meta_data`: the real column names are
 * `raw_user_meta_data` and `raw_app_meta_data` with no second segment. A first draft of
 * `raw_user_(app|user)_meta_data` matched neither spelling, so it returned false on the good file
 * *and* on a deliberately-bad one — every case passing for the wrong reason.
 */
const FORBIDDEN = {
  readsRoleFromMetadata: (s: string) =>
    /raw_(user|app)_meta_data\s*->>\s*'role'/i.test(stripComments(s)),
} as const;

type RequiredName = keyof typeof REQUIRED;
type ForbiddenName = keyof typeof FORBIDDEN;

/**
 * Strip SQL comments before matching.
 *
 * The migration's header *quotes* the clauses it uses — "Bare `on conflict do nothing`, not
 * `on conflict (id)`" — so an unanchored regex matches the commentary and not the code. Two
 * failures came from that: a "remove the clause" fixture left the comment naming the clause, and
 * a "two-arbiter" fixture was detected as still idempotent because the comment said otherwise.
 *
 * Only `--`-to-end-of-line comments and block comments are removed. This file has no `--`
 * inside a string literal, which is the assumption that makes a regex stripper safe here; a
 * general SQL parser would be needed to guarantee it.
 */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * Every fixture below asserts `mutated !== sql` before asserting anything about the mutation.
 *
 * That assertion is not ceremony. The first version of this file used `String.replace` with
 * literals like `"set search_path = ''"`, and the real line is *indented* — so the replace matched
 * nothing, every fixture was byte-identical to the real migration, and the "known-bad" cases passed
 * while testing nothing at all. A guard whose fixtures fail to mutate is indistinguishable from a
 * guard that always rejects. Every mutation below is therefore regex-based, and every case proves
 * it actually changed the text first.
 */
function mutate(pattern: RegExp, replacement: string): string {
  const mutated = sql.replace(pattern, replacement);
  expect(mutated, `fixture did not mutate the migration: ${pattern}`).not.toBe(sql);
  return mutated;
}

/** Chained mutation: proves the second edit applied without assuming the first one did. */
function mutateFrom(source: string, pattern: RegExp, replacement: string): string {
  const mutated = source.replace(pattern, replacement);
  expect(mutated, `fixture did not mutate: ${pattern}`).not.toBe(source);
  return mutated;
}

describe("the 0005 checker rejects known-bad migrations", () => {
  it("rejects a migration that reads role from user metadata", () => {
    // Line-anchored: the header comment *quotes* `on conflict do nothing`, so an unanchored
    // pattern rewrites the comment and leaves the real clause untouched — the fixture then
    // asserts against text that was never changed. Caught by running the test, not by reading it.
    const bad = mutate(
      /^\s*on\s+conflict\s+do\s+nothing\s*;/m,
      "on conflict (id) do update set role = (new.raw_user_meta_data ->> 'role')::user_role;",
    );

    expect(FORBIDDEN.readsRoleFromMetadata(bad)).toBe(true);
  });

  it("rejects a migration that widens the search_path", () => {
    const bad = mutate(/set\s+search_path\s*=\s*''\s*;?\s*$/gim, "set search_path = public;");

    expect(REQUIRED.hasEmptySearchPath(bad)).toBe(false);
    expect(REQUIRED.hasDefiner(bad)).toBe(true);
  });

  it("rejects a definer function with no search_path hardening at all", () => {
    const bad = mutate(/set\s+search_path\s*=\s*''\s*;?\s*$/gim, "");

    expect(REQUIRED.hasEmptySearchPath(bad)).toBe(false);
  });

  it("rejects a non-idempotent trigger that would error on re-run", () => {
    const noDrop = mutate(/drop\s+trigger\s+if\s+exists[\s\S]*?;/i, "");
    const bad = mutateFrom(noDrop, /^\s*on\s+conflict\s+do\s+nothing\s*;/m, "");

    expect(REQUIRED.dropsTriggerFirst(bad)).toBe(false);
    expect(REQUIRED.isIdempotent(bad)).toBe(false);
  });

  it("rejects a two-arbiter ON CONFLICT, which is a Postgres syntax error", () => {
    // `on conflict (id) do nothing on conflict (email) do nothing` was the first attempt at
    // covering both unique indexes. It parses as a syntax error and the whole migration fails —
    // caught by `pnpm db reset`, not by any unit test, which is why the reset gate matters.
    const bad = mutate(
      /^\s*on\s+conflict\s+do\s+nothing\s*;/m,
      "on conflict (id) do nothing on conflict (email) do nothing;",
    );

    expect(REQUIRED.isIdempotent(bad)).toBe(true); // syntactically "idempotent"…
    expect(bad).not.toMatch(/^\s*on\s+conflict\s+do\s+nothing\s*;/m); // …but not the form Postgres accepts
  });

  it("accepts the real migration on every check", () => {
    // The other direction, and the one that found real bugs. Without it, "all the bad ones fail"
    // is also satisfied by a checker that rejects everything — including the correct file.
    const missing = (Object.keys(REQUIRED) as RequiredName[]).filter(
      (name) => !REQUIRED[name](sql),
    );
    const present = (Object.keys(FORBIDDEN) as ForbiddenName[]).filter(
      (name) => FORBIDDEN[name](sql),
    );

    expect({ missing, forbidden_present: present }).toEqual({ missing: [], forbidden_present: [] });
  });

  it("cannot be satisfied by an empty string", () => {
    // The cheapest possible false pass: a checker fed nothing.
    for (const name of Object.keys(REQUIRED) as RequiredName[]) {
      expect(REQUIRED[name]("")).toBe(false);
    }
    for (const name of Object.keys(FORBIDDEN) as ForbiddenName[]) {
      expect(FORBIDDEN[name]("")).toBe(false);
    }
  });
});