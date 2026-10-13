/**
 * queue-kind-vocabulary.test.ts — the three `task_queue.kind` vocabularies must be one.
 *
 * ## What went wrong
 *
 * `task_queue.kind` has three independent definitions: the Postgres `task_kind` enum
 * (0001_init.sql:51), the Zod mirror `taskKindSchema` (types/db.ts:111), and the dispatcher's
 * `TASK_KINDS` list. They drifted, and the drift was invisible to every gate:
 *
 * - `/api/cron/enqueue` inserted `kind: "scrape_source"`, which the enum has never contained,
 *   through `kind: row.kind as never` — a cast that discards the compiler's only opinion.
 * - A live `GET /api/cron/enqueue` against the configured database returned all nine sources
 *   failing with `invalid input value for enum task_kind: "scrape_source"`. Ingestion had
 *   **never enqueued a single task**, and nothing in the repo said so.
 * - `dispatch.ts` also listed `generate_rationale`, `embed_jobs` and `freshness_sweep`, which
 *   do not exist in the enum, while the enum's `ingest_source`, `account_export` and
 *   `cleanup` were absent from the list.
 *
 * Typecheck passed because the Supabase client is untyped and the insert was cast to `never`.
 * The unit tests passed because they asserted the code agreed with itself — the same failure
 * mode as the feed's `.000Z` fixtures, one layer up: a test that only checks the code against
 * the code cannot notice that the code is wrong about the database.
 *
 * ## What this file asserts
 *
 * That the three agree, and that the handler registry is a subset of the database's vocabulary
 * — the specific check that would have caught the bug on the day it was written.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `dispatch.ts` imports `createAdminClient`, which imports `env`, which validates the whole
// environment at module load. Unit tests run without `--env-file=.env.local`, so the import
// would throw before a single assertion ran. Mocked the same way `phase1-queue.test.ts` does
// it — the values are placeholders and are never used: this file asserts types and reads SQL.
vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test",
    SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test",
    CRON_SECRET: "a".repeat(64),
    OPENROUTER_API_KEY: "sk-or-v1-test",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_EMBEDDING_MODEL: "nvidia/nemotron-3-embed-1b:free",
    OPENROUTER_CHAT_MODEL: "qwen/qwen3.8-27b:free",
  },
}));

import { HANDLERS, TASK_KINDS, hasHandler, registeredKinds } from "@/lib/queue/dispatch";
import { taskKindSchema } from "@/types/db";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * The `task_kind` enum exactly as the migrations declare it.
 *
 * Parsed from the SQL rather than imported, because importing it *is* the thing that drifted:
 * `taskKindSchema` and the enum agreed with each other and both disagreed with the dispatcher.
 * Reading the SQL makes the database the authority for what this test is about.
 */
function declaredEnumValues(): string[] {
  const sql = readFileSync(join(MIGRATIONS_DIR, "0001_init.sql"), "utf8");
  const declaration = /create type task_kind\s+as enum\s*\(([^)]*)\)/i.exec(sql);
  if (!declaration?.[1]) throw new Error("could not find the task_kind enum declaration");
  return declaration[1]
    .split(",")
    .map((value) => value.trim().replace(/^'|'$/g, ""))
    .filter((value) => value.length > 0);
}

describe("task_queue.kind vocabulary", () => {
  const declared = declaredEnumValues();
  const schemaValues = taskKindSchema.options;

  it("the Zod schema mirrors the Postgres enum exactly", () => {
    expect([...schemaValues].sort()).toEqual([...declared].sort());
  });

  it("the dispatcher derives its kinds from the schema, not a hand-written list", () => {
    // If this ever needs a literal list again, the two will drift again — that is what
    // happened. Deriving is the fix, not the duplication.
    expect([...TASK_KINDS].sort()).toEqual([...schemaValues].sort());
  });

  it("registers no handler under a kind the database would reject", () => {
    // The check that would have caught this bug: `HANDLERS` is typed
    // `Partial<Record<TaskKind, …>>` over the schema union, so a phantom key is a compile
    // error. Asserted anyway, because a `Partial` plus a widened key type is exactly how the
    // cast in the enqueue route was allowed to exist.
    const handlers = Object.keys(HANDLERS).sort();
    const unknown = handlers.filter((kind) => !schemaValues.includes(kind as never));
    expect(unknown).toEqual([]);
  });

  it("has a handler for every kind it claims to dispatch", () => {
    // `registeredKinds()` is what `dispatchTask` consults, so a kind in TASK_KINDS with no
    // handler produces a task that can be enqueued and then always fails. Two are implemented
    // (`ingest_source`, `rescore_profile`); the other four are in the enum and unimplemented,
    // which is legitimate — they get a clear "no handler registered" failure. Pinned so the
    // list cannot grow silently as handlers land.
    const implemented = new Set(Object.keys(HANDLERS));
    const unimplemented = [...schemaValues].filter((kind) => !implemented.has(kind)).sort();
    expect(unimplemented).toEqual([
      "account_export",
      "cleanup",
      "score_jobs",
      "send_digest",
    ]);
  });

  it("names the ingest kind the way the enum does", () => {
    // `docs/02` §5.9 and the enum both say `ingest_source`. `scrape_source` was the code's
    // name, the enum never had it, and every enqueue failed.
    expect(hasHandler("ingest_source")).toBe(true);
    expect(hasHandler("scrape_source")).toBe(false);
    expect(registeredKinds()).toEqual(["ingest_source", "rescore_profile"]);
  });
});
