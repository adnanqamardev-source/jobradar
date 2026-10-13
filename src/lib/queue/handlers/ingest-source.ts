/**
 * ingest-source.ts - the `ingest_source` task handler (ING-008, ING-011).
 */

import { createAdminClient } from "@/lib/db/admin";
import { getConnector, installBuiltInConnectors } from "@/lib/connectors";
import { normaliseJob } from "@/lib/ingest/normalize";
import { computeDedupeHash, upsertCanonicalJob } from "@/lib/ingest/dedupe";
import { emptyRunCounts, runStatusFor, buildRunLog } from "@/lib/ingest/sources";
import type { HandlerContext } from "@/lib/queue/dispatch";
import type { Outcome } from "@/lib/queue/plan";
import type { SourceKind } from "@/types/db";

installBuiltInConnectors();

export async function runIngestSource(context: HandlerContext): Promise<Outcome> {
  const { task, now, signal } = context;
  const payload = task.payload;
  const sourceId = typeof payload.source_id === "string" ? payload.source_id : null;

  if (!sourceId) {
    return { ok: false, error: "ingest_source: payload.source_id is missing or not a string" };
  }

  const supabase = createAdminClient();
  const startTime = Date.now();

  // 1. Read source
  const sourceResult = await supabase
    .from("sources")
    .select("*")
    .eq("id", sourceId)
    .single();

  if (sourceResult.error || !sourceResult.data) {
    return { ok: false, error: `ingest_source: source ${sourceId} not found` };
  }

  const source = sourceResult.data as Record<string, unknown>;
  const sourceKind = (typeof source.kind === "string" ? source.kind : "") as SourceKind;
  const sourceName = typeof source.name === "string" ? source.name : "";
  const sourceConfig = (source.config && typeof source.config === "object") ? (source.config as Record<string, unknown>) : {};
  const consecutiveFailures = typeof source.consecutive_failures === "number" ? source.consecutive_failures : 0;
  const lastSuccessAt = typeof source.last_success_at === "string" ? source.last_success_at : null;

  // 2. Insert starting scrape_runs row
  const { data: runRow } = await supabase
    .from("scrape_runs")
    .insert({
      source_id: sourceId,
      task_id: task.id,
      status: "partial",
      started_at: now.toISOString(),
      found: 0,
      inserted: 0,
      duplicates: 0,
      failed: 0,
      api_calls: 0,
    })
    .select("id")
    .single();

  const runRowRecord = runRow ? (runRow as Record<string, unknown>) : null;
  const runId = runRowRecord && typeof runRowRecord.id === "string" ? runRowRecord.id : undefined;

  try {
    const connector = getConnector(sourceKind);
    const counts = emptyRunCounts();
    const errors: string[] = [];

    const jobWriter = {
      async rpc(fn: "upsert_job", args: { p_row: Record<string, unknown> }) {
        const res = (await supabase.rpc(fn, args)) as unknown as { data: unknown; error: { message: string } | null };
        const resError = res.error ? { message: res.error.message } : null;
        return { data: res.data, error: resError };
      },
    };

    const fetchResult = connector.fetch({
      id: sourceId,
      name: sourceName,
      kind: sourceKind,
      ...sourceConfig,
    }, {
      runId: task.id,
      signal,
      now: () => now.getTime(),
      sleep: (ms: number) => new Promise((res) => setTimeout(res, ms)),
      fetch: globalThis.fetch,
      onRequest: () => {
        counts.apiCalls++;
      },
    });

    for await (const raw of fetchResult) {
      if (signal.aborted) break;
      counts.found++;

      try {
        const canonical = normaliseJob(raw);
        const hash = computeDedupeHash(canonical);
        const upsertResult = await upsertCanonicalJob(jobWriter, canonical, hash, sourceId);

        if (upsertResult.ok) {
          counts.inserted++;
        } else {
          counts.duplicates++;
        }
      } catch (err) {
        counts.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
      }
    }

    const durationMs = Date.now() - startTime;
    const hasError = errors.length > 0;
    const finalStatus = runStatusFor(counts, hasError);
    const logJson = buildRunLog({ status: finalStatus, errors, skipped: counts.failed });

    if (runId) {
      await supabase
        .from("scrape_runs")
        .update({
          status: finalStatus,
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
          found: counts.found,
          inserted: counts.inserted,
          duplicates: counts.duplicates,
          failed: counts.failed,
          api_calls: counts.apiCalls,
          log: logJson,
        })
        .eq("id", runId);
    }

    // Update source status
    await supabase
      .from("sources")
      .update({
        last_success_at: finalStatus !== "failed" ? new Date().toISOString() : lastSuccessAt,
        consecutive_failures: finalStatus === "failed" ? consecutiveFailures + 1 : 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceId);

    if (finalStatus === "failed") {
      return { ok: false, error: `Scrape run failed with 0 found or unhandled errors` };
    }

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    if (runId) {
      await supabase
        .from("scrape_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          duration_ms: durationMs,
          error: message,
        })
        .eq("id", runId);
    }

    await supabase
      .from("sources")
      .update({
        consecutive_failures: consecutiveFailures + 1,
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", sourceId);

    return { ok: false, error: message };
  }
}
