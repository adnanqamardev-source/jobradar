/**
 * GET /api/cron/enqueue — turn due sources into `scrape_source` tasks (BE-109).
 *
 * docs/02b §6.4: Vercel Cron drives the queue. This route is the *producer* half; `/api/cron/process`
 * is the consumer. They are separate on purpose: enqueueing is cheap and idempotent, while
 * processing is expensive, and a producer that also drained would make the run duration depend
 * on how much work happened to be pending.
 *
 * ## What it does not decide
 *
 * Which sources are due, and what `next_run_at` becomes, is `planEnqueue`'s job
 * (`src/lib/cron/plan-enqueue.ts`). This route executes the plan. That split is what makes
 * "exactly once per cycle" testable: the plan is computed from one snapshot of the sources
 * before any row is written, so a re-read mid-cycle cannot enqueue a source twice.
 *
 * ## Per-source isolation
 *
 * docs/05b ING-009: "A failing source cannot stall other sources." Each source's enqueue and
 * `next_run_at` write is settled independently — one throw is recorded in `skipped` and the
 * loop continues. A batch-wide transaction would make a single bad row discard the whole
 * cycle, which is the opposite of the requirement.
 *
 * ## Not yet complete
 *
 * The `scrape_source` handler itself is BE-108's remaining work, so enqueued tasks will fail
 * with "no handler registered" until it lands. That is visible in `failed`/`audit_logs` rather
 * than silent, which is the property that matters while the ticket is open.
 */

import { NextResponse } from "next/server";

import { CRON_HEADER, cronUnauthorizedBody, verifyCronSecret } from "@/lib/cron/auth";
import { planEnqueue } from "@/lib/cron/plan-enqueue";
import { env } from "@/lib/env";
import { createClient } from "@/lib/db/client";
import { readSources } from "@/lib/ingest/sources";
import { logger } from "@/lib/logger";
import type { TaskKind } from "@/types/db";

export const dynamic = "force-dynamic";

/**
 * The task kind this route creates.
 *
 * `ingest_source`, not `scrape_source`. The Postgres `task_kind` enum (0001_init.sql:51) and
 * `docs/02` §5.9 both name it `ingest_source`; `docs/02` §7 even lists the handler file as
 * `handlers/ingest_source.ts`. This route said `scrape_source`, which the enum has never
 * contained, so **every insert failed**:
 *
 *   {"due":9,"enqueued":0,"failed":[{"reason":"invalid input value for enum task_kind:
 *    \"scrape_source\""}, x9]}
 *
 * and ingestion could never run a single task. Nothing caught it because the insert went
 * through `kind: row.kind as never`, which discards the compiler's only opinion. `row.kind`
 * is typed `TaskKind` below, so the same mistake is now a compile error, and
 * `tests/unit/queue-kind-vocabulary.test.ts` fails if a handler is registered under a kind the
 * database would reject.
 *
 * Note `EnqueuePlanEntry.kind` carries the *source* kind (`api_greenhouse`, …) and this route
 * does not use it — every source produces the same task kind and the handler re-reads
 * `sources.kind` itself. Left in place because it is part of the plan's public shape, but it
 * is not the value written to `task_queue.kind`.
 */
const ENQUEUE_TASK_KIND = "ingest_source" satisfies TaskKind;

interface EnqueueStore {
  insertTask(row: { kind: TaskKind; payload: Record<string, unknown> }): Promise<string | null>;
  advanceSource(sourceId: string, nextRunAt: string): Promise<string | null>;
}

export async function GET(request: Request) {
  const requestId = crypto.randomUUID();

  // Authenticate before touching the database. A 401 that has already run a query is a free
  // DoS amplifier, and the secret is the only thing standing between this route and the
  // service-role key.
  const auth = verifyCronSecret(request.headers.get(CRON_HEADER), env.CRON_SECRET);
  if (!auth.ok) {
    logger.warn("Cron auth failed", { requestId, route: "enqueue", reason: auth.reason });
    return NextResponse.json(cronUnauthorizedBody(requestId), { status: 401 });
  }

  const supabase = createClient();
  const now = new Date();

  let sources;
  try {
    sources = await readSources(supabase as unknown as Parameters<typeof readSources>[0]);
  } catch (error) {
    // A read failure is a 500, not a 401 — the credential was fine.
    logger.error("Cron enqueue: source read failed", {
      requestId,
      message: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "enqueue_failed", message: "Could not read sources.", requestId },
      { status: 500 },
    );
  }

  const { entries, skipped } = planEnqueue(sources, now);

  const store: EnqueueStore = {
    async insertTask(row) {
      const { data, error } = await supabase
        .from("task_queue")
        .insert({ kind: row.kind, payload: row.payload, status: "pending" })
        .select("id")
        .single();
      if (error) {
        logger.error("Cron enqueue: task insert failed", {
          requestId,
          sourceId: row.payload.source_id,
          message: error.message,
        });
        return error.message;
      }
      const id = (data as { id?: unknown } | null)?.id;
      return typeof id === "string" ? null : "insert returned no id";
    },
    async advanceSource(sourceId, nextRunAt) {
      const { error } = await supabase
        .from("sources")
        .update({ next_run_at: nextRunAt, updated_at: now.toISOString() })
        .eq("id", sourceId);
      return error ? error.message : null;
    },
  };

  const enqueued: string[] = [];
  const failed: { sourceId: string; reason: string }[] = [];

  for (const entry of entries) {
    const insertError = await store.insertTask({
      kind: ENQUEUE_TASK_KIND,
      payload: { source_id: entry.sourceId, enqueued_at: now.toISOString() },
    });
    if (insertError) {
      failed.push({ sourceId: entry.sourceId, reason: insertError });
      continue;
    }

    // `next_run_at` advances only after the task exists. The other order would lose a cycle
    // if the insert failed — the source would be marked as already-run for a task that was
    // never created, and nothing would pick it up until the next cadence.
    const advanceError = await store.advanceSource(entry.sourceId, entry.nextRunAt);
    if (advanceError) {
      // The task exists and will run, so this is not a lost cycle. Recorded because the
      // source will be re-enqueued next cycle, producing a duplicate run.
      failed.push({ sourceId: entry.sourceId, reason: `next_run_at: ${advanceError}` });
      continue;
    }

    enqueued.push(entry.sourceId);
  }

  logger.info("Cron enqueue complete", {
    requestId,
    due: entries.length,
    enqueued: enqueued.length,
    skipped: skipped.length,
    failed: failed.length,
  });

  return NextResponse.json({
    ok: failed.length === 0,
    requestId,
    due: entries.length,
    enqueued: enqueued.length,
    skipped: skipped.map((s) => ({ sourceId: s.sourceId, reason: s.reason })),
    failed,
  });
}
