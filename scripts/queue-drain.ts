#!/usr/bin/env tsx
/**
 * queue-drain.ts — Process one batch of the task queue locally.
 * Replaces the Vercel cron for local development.
 *
 * Usage:
 *   pnpm queue:drain --once          # process one batch and exit
 *   pnpm queue:drain --once --kind=score_jobs  # filter by task_kind
 *
 * Env loading: Node's built-in `--env-file` flag (see package.json script).
 * No dotenv dependency — it was never in package.json.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Run via `pnpm queue:drain` so --env-file=.env.local is applied.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const kindArg = args.find((a) => a.startsWith("--kind="));
  const kind: string | null = kindArg ? (kindArg.split("=")[1] ?? null) : null;

  console.log(`[queue-drain] starting${once ? " (--once)" : ""}${kind ? ` kind=${kind}` : ""}`);

  const { data: tasks, error } = await supabase
    .from("task_queue")
    .select("*")
    .eq("status", "pending")
    // docs/02 §5.8 — priority is "lower runs first", so ascending.
    .order("priority", { ascending: true })
    .order("run_after", { ascending: true })
    .limit(kind ? 50 : 10);

  if (error) {
    console.error("[queue-drain] fetch error:", error.message);
    process.exit(1);
  }

  if (!tasks || tasks.length === 0) {
    console.log("[queue-drain] no pending tasks");
    return;
  }

  for (const task of tasks) {
    if (kind && task.kind !== kind) continue;

    const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    // Optimistic claim: the `.eq("status","pending")` guard makes this a
    // compare-and-swap, so two concurrent drains cannot both win.
    const { data: claimed, error: claimErr } = await supabase
      .from("task_queue")
      .update({
        status: "running",
        attempts: task.attempts + 1,
        last_error: null,
        locked_at: new Date().toISOString(),
        locked_by: "local-drain",
        run_after: leaseUntil,
      })
      .eq("id", task.id)
      .eq("status", "pending")
      .select("id");

    if (claimErr) {
      console.warn(`[queue-drain] task ${task.id} claim failed:`, claimErr.message);
      continue;
    }
    if (!claimed || claimed.length === 0) {
      console.log(`[queue-drain] task ${task.id} claimed by another worker, skipping`);
      continue;
    }

    console.log(`[queue-drain] processing ${task.kind} (${task.id})`);

    try {
      // Dispatch to the real handler — implemented in BE-108 / BE-312.
      // Placeholder until then: mark done so the local loop drains.
      const { error: doneErr } = await supabase
        .from("task_queue")
        .update({ status: "done" })
        .eq("id", task.id);

      if (doneErr) throw doneErr;
      console.log(`[queue-drain] ${task.kind} done`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // docs/02 §6.4 — run_after = now() + 2^n seconds, capped at 1 hour.
      const backoffMs = Math.min(1000 * 2 ** task.attempts, 3_600_000);
      await supabase
        .from("task_queue")
        .update({
          status: task.attempts + 1 >= task.max_attempts ? "failed" : "pending",
          last_error: msg,
          run_after: new Date(Date.now() + backoffMs).toISOString(),
        })
        .eq("id", task.id);
      console.error(`[queue-drain] ${task.kind} failed: ${msg}`);
    }
  }
}

main().catch((e) => {
  console.error("[queue-drain] fatal:", e);
  process.exit(1);
});