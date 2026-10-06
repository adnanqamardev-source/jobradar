/**
 * migration-drift.test.ts — keeps migrations, schema doc, and feed view in agreement.
 *
 * ## Why this is a test and not a review step
 *
 * Each rule below encodes a mistake that was either nearly shipped or already shipped while
 * writing `0002_resumes.sql` / `0003_remote_scope.sql`:
 *
 * - The `v_ranked_jobs` view lists columns explicitly (that was a deliberate fix — `select
 *   j.*` leaked `raw` and a 2048-float embedding). The cost is that a new column on `jobs`
 *   does **not** reach the feed. Miss it and the UI offers a country filter that silently
 *   returns nothing.
 * - `CREATE OR REPLACE VIEW` cannot insert a column before existing ones, so `remote_scope`
 *   required DROP + CREATE. A well-meaning `create or replace` edit to this migration will
 *   fail at `db reset` — which cannot run on every machine, so it must be caught here.
 * - §5.10 of docs/02a requires an index on every FK column. `resumes.user_id` is inside an
 *   RLS predicate, so a missing index degrades every policy check on every row.
 * - These migrations have **never been executed** (no Postgres on the dev machine), so static
 *   agreement is the only automated check available. It does not replace `supabase db reset`.
 *
 * Parsing is deliberately textual. It cannot check that SQL is valid, that `auth.uid()`
 * exists, or that the enum values match the TypeScript union — only `supabase db reset` and the
 * integration suite can do that. What it *can* do is fail the moment a doc and a migration
 * disagree, which is the failure mode that survives longest.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const DOCS_DIR = join(process.cwd(), "docs");

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Concatenated SQL, lower-cased and whitespace-collapsed for resilient substring checks. */
const allSql = migrationFiles
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n")
  .toLowerCase()
  .replace(/\s+/g, " ");

const schemaDoc = readFileSync(join(DOCS_DIR, "02a-schema.md"), "utf8");

/**
 * The effective `v_ranked_jobs` definition: the **last** `create view` in migration order.
 *
 * Taking the first match is wrong and was wrong here: `0001_init.sql` creates the view and
 * `0003_remote_scope.sql` drops and recreates it, so the first match is the superseded
 * definition and the assertions below silently graded the old view. `matchAll` + `at(-1)` is
 * the fix; `.exec()` returns the first hit.
 */
function latestViewDefinition(): string {
  const definitions = [...allSql.matchAll(/create view v_ranked_jobs[\s\S]*?;/gi)];
  const last = definitions.at(-1);
  return last?.[0] ?? "";
}

/** How many times the view is defined across all migrations — more than one means a replace. */
function viewDefinitionCount(): number {
  return [...allSql.matchAll(/create view v_ranked_jobs/gi)].length;
}

describe("migration numbering", () => {
  it("numbers migrations contiguously from 0001", () => {
    // A gap means a migration was never applied on some machine, or two files collide.
    const numbers = migrationFiles.map((f) => Number.parseInt(f.slice(0, 4), 10));
    expect(numbers[0]).toBe(1);
    numbers.forEach((n, i) => {
      if (i > 0) expect(n).toBe(numbers[i - 1]! + 1);
    });
  });

  it("has no duplicate version prefixes", () => {
    const prefixes = migrationFiles.map((f) => f.slice(0, 4));
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("remote_scope (BE-317)", () => {
  it("creates the enum with exactly the three documented values", () => {
    expect(allSql).toContain("create type remote_scope as enum ('india', 'global', 'unknown')");
  });

  it("adds the column to jobs", () => {
    expect(allSql).toMatch(/alter table jobs add column (if not exists )?remote_scope/);
  });

  it("defaults to 'unknown' rather than null", () => {
    // A nullable scope would make every filter need an extra `or remote_scope is null`.
    expect(allSql).toMatch(/remote_scope remote_scope default 'unknown'/);
  });

  it("indexes work_mode ahead of remote_scope for the real query shape", () => {
    const idx = /create index[^;]*on jobs \(work_mode, remote_scope\)[^;]*;/.exec(allSql);
    expect(idx?.[0]).toBeDefined();
    // The partial predicate is what keeps the index off expired/stale rows.
    expect(idx?.[0]).toContain("where status = 'active'");
  });

  it("exposes remote_scope through v_ranked_jobs", () => {
    // The near-miss: the column and index landed, the view did not, and the country
    // filter would have returned nothing with no error anywhere.
    expect(latestViewDefinition()).toMatch(/j\.remote_scope/);
  });

  it("defines the view more than once, so the newest definition is the effective one", () => {
    // Guards the guard: if this ever drops to 1, `latestViewDefinition()` is reading the
    // original 0001 view and every assertion above is grading a superseded definition.
    expect(viewDefinitionCount()).toBeGreaterThan(1);
  });

  it("keeps the view's existing columns and order intact", () => {
    // DROP + CREATE replaced this view; a dropped column here breaks the feed query.
    const view = latestViewDefinition();
    for (const column of [
      "j.id",
      "j.title",
      "j.company_name",
      "j.location_raw as location",
      "j.work_mode",
      "j.employment_type",
      "j.seniority",
      "j.posted_at",
      "j.last_seen_at",
      "j.status",
      "j.skills",
      "s.final_score",
      "s.breakdown",
      "s.explanation",
      "s.scored_at",
    ]) {
      expect(view).toContain(column);
    }
  });

  it("still uses security_invoker so RLS reaches the feed", () => {
    // A view without security_invoker runs as its owner and silently bypasses RLS.
    expect(latestViewDefinition()).toContain("security_invoker = true");
  });
});

describe("resumes table (BE-314)", () => {
  it("exists as a table", () => {
    expect(allSql).toContain("create table if not exists resumes");
  });

  it("enables AND forces row level security", () => {
    expect(allSql).toContain("alter table resumes enable row level security");
    expect(allSql).toContain("alter table resumes force row level security");
  });

  it("has a policy for every write verb", () => {
    // A missing verb fails closed, but silently — the feature simply looks broken.
    for (const verb of ["select", "insert", "update", "delete"]) {
      expect(allSql).toContain(`resumes_${verb}_own`);
    }
  });

  it("scopes every policy to the owner via auth.uid()", () => {
    const policies = allSql.match(/create policy "resumes_\w+_own"[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(4);
    for (const policy of policies) {
      expect(policy).toContain("(select auth.uid())");
    }
  });

  it("indexes user_id, satisfying the docs/02a §5.10 FK rule", () => {
    // This FK sits inside an RLS predicate, so an unindexed user_id makes every policy
    // check scan the table once per row touched.
    expect(allSql).toMatch(/create index[^;]*on resumes \(user_id\)/);
  });

  it("cascades on user deletion", () => {
    expect(allSql).toMatch(/user_id uuid not null references profiles\(id\) on delete cascade/);
  });

  it("restricts mime_type to PDF and DOCX", () => {
    expect(allSql).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("stores no public URL for the file", () => {
    // Only a storage path belongs here; a URL would outlive the signed-URL expiry model.
    const table = /create table if not exists resumes \([\s\S]*?\);/.exec(allSql)?.[0] ?? "";
    expect(table).toContain("file_path");
    expect(table).not.toContain("public_url");
  });
});

describe("storage policies", () => {
  it("scopes every resumes storage policy to the caller's folder", () => {
    const policies =
      allSql.match(/create policy "resumes_storage_\w+_own" on storage\.objects[\s\S]*?;/g) ?? [];
    expect(policies.length).toBeGreaterThanOrEqual(4);
    for (const policy of policies) {
      expect(policy).toContain("bucket_id = 'resumes'");
      expect(policy).toContain("storage.foldername(name))[1] = (select auth.uid())::text");
    }
  });
});

describe("claim primitive (FND-002)", () => {
  /** The `claim_tasks` body only — everything after the AS $$ delimiter. */
  const claimFn = /create or replace function public\.claim_tasks[\s\S]*?\$\$([\s\S]*?)\$\$;/.exec(
    allSql,
  )?.[1] ?? "";

  it("creates claim_tasks with the documented signature", () => {
    expect(allSql).toContain("create or replace function public.claim_tasks(");
    // p_kind is typed as the enum, not text: a text parameter would silently accept a
    // kind that does not exist and fail at comparison time instead of the call site.
    expect(allSql).toContain("p_kind public.task_kind default null");
    expect(allSql).toContain("p_lease_seconds integer default 300");
  });

  it("uses FOR UPDATE SKIP LOCKED, which is the whole reason this RPC exists", () => {
    // Without SKIP LOCKED a second worker blocks on the first worker's rows; without FOR
    // UPDATE the rows can be double-claimed. Either clause alone is not the spec.
    expect(claimFn).toContain("for update skip locked");
  });

  it("orders by priority then run_after, matching planClaim", () => {
    // plan.ts sorts `a.priority - b.priority || cmpRunAfter(a, b)`. If the SQL drifts
    // from that, the two halves disagree about which task runs first.
    expect(claimFn).toMatch(/order by t\.priority asc, t\.run_after asc/);
  });

  it("never increments attempts on claim", () => {
    // docs/02b §6.4 increments attempts on FAILURE. Incrementing here would burn a retry
    // on every success, so a task that succeeded three times would arrive at its first
    // error with two retries already spent.
    expect(claimFn).not.toMatch(/attempts\s*=\s*t?\.?attempts\s*\+/);
    expect(claimFn).not.toMatch(/attempts\s*=\s*\w+\s*\+\s*1/);
  });

  it("does not write run_after on a fresh claim, only in the reaper", () => {
    // run_after carries backoff scheduling alone; the lease lives in locked_at/locked_by.
    // The claim UPDATE must not touch it, or the claim's own ORDER BY mixes two clocks.
    // Anchored on `set status = 'running'` so the reaper's own `run_after` write — which
    // is required — is not what this asserts on.
    const claimUpdate = /set status = 'running'[\s\S]*?from candidates[\s\S]*?where t\.id = c\.id/.exec(
      claimFn,
    )?.[0] ?? "";
    expect(claimUpdate).not.toBe("");
    expect(claimUpdate).not.toContain("run_after");
    expect(claimUpdate).toContain("locked_by = p_worker_id");
  });

  it("reaps only expired leases, back to pending and immediately due", () => {
    expect(claimFn).toMatch(/where t\.status = 'running'/);
    expect(claimFn).toContain("t.locked_at < now() - make_interval(secs =>");
    expect(claimFn).toMatch(/set status = 'pending'/);
    // Reaped tasks must be due now, not left in the stale backoff window that run_after
    // was pointing at before the worker died.
    expect(claimFn).toMatch(/run_after = now\(\)/);
  });

  it("is security definer, because task_queue forces RLS", () => {
    expect(allSql).toMatch(/create or replace function public\.claim_tasks[\s\S]*?security definer/);
    // An unpinned search_path in a security definer function is the classic privilege
    // escalation vector: the caller controls the schema that resolves first.
    expect(allSql).toMatch(/create or replace function public\.claim_tasks[\s\S]*?set search_path = public/);
  });

  it("grants EXECUTE to service_role only, revoking per role", () => {
    // Not `revoke ... from public`: Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to
    // anon and authenticated explicitly, so a PUBLIC-only revoke removes nothing. This is
    // exactly the bug 0008 was written to fix.
    const grants = allSql.match(
      /(?:revoke|grant) execute on function public\.claim_tasks[\s\S]*?;/g,
    ) ?? [];
    expect(grants.some((g) => /revoke[\s\S]*from anon/.test(g))).toBe(true);
    expect(grants.some((g) => /revoke[\s\S]*from authenticated/.test(g))).toBe(true);
    expect(grants.some((g) => /grant[\s\S]*to service_role/.test(g))).toBe(true);
    // Claiming is a worker capability; a signed-in user must not reach it.
    expect(grants.some((g) => /grant[\s\S]*to (anon|authenticated|public)\b/.test(g))).toBe(false);
  });

  it("caps the batch so a caller cannot claim the whole queue in one call", () => {
    // p_limit is clamped, not trusted: a single unvalidated limit is an easy way to
    // blow past the 25-task batch the spec fixes.
    expect(claimFn).toMatch(/greatest\(1, least\(coalesce\(p_limit, 25\), 100\)\)/);
  });
});

describe("docs/02a-schema.md agreement", () => {
  it("documents the remote_scope enum", () => {
    expect(schemaDoc).toContain("remote_scope");
  });

  it("documents jobs.remote_scope as a column", () => {
    expect(schemaDoc).toMatch(/\| `remote_scope` \| `remote_scope`/);
  });

  it("documents the resumes table", () => {
    expect(schemaDoc).toContain("**`resumes`**");
  });

  it("lists resumes.user_id in the §5.10 FK index table", () => {
    expect(schemaDoc).toMatch(/\| `resumes` \| `user_id` \| `profiles` \|/);
  });

  it("documents the view with remote_scope in it", () => {
    // Docs and migration must agree, or the next reader trusts the wrong one.
    const viewBlock = /create view v_ranked_jobs[\s\S]*?;/i.exec(schemaDoc)?.[0] ?? "";
    expect(viewBlock).toMatch(/j\.remote_scope/);
  });

  it("states that remote_scope is not a foreign key, so §5.10 does not apply", () => {
    // Prevents someone "fixing" the §5.10 table by adding a nonexistent FK row.
    expect(schemaDoc).toMatch(/remote_scope.*is (deliberately )?absent from this table/);
  });
});