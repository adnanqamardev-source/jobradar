/**
 * sources.ts — the `sources` row shape and its reader (BE-109, BE-111).
 *
 * Two things live here, both of which are load-bearing for the cron cycle and neither of
 * which belongs in a route handler:
 *
 *  - **the row shape** `plan-enqueue.ts` plans over, so the planner stays pure and the
 *    column list is stated once.
 *  - **`readScrapeRunCounts` / `runStatusFor`**, the accounting a `scrape_runs` row needs
 *    (ING-011: "Partial parses set `status='partial'` with parse diagnostics in `log`").
 *
 * ## Why the reader is narrow
 *
 * The cron cycle reads every source row on every minute. Selecting `*` would pull each
 * source's `config` jsonb — which holds board slugs, country lists and scraper URLs — for
 * rows that are only being checked for due-ness. The column list is explicit for that reason,
 * and `readSources` is the only place that knows it.
 */

/** The `sources` columns the enqueue cycle and run accounting read. */
export interface SourceRow {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  cadence_minutes: number;
  next_run_at: string | null;
  consecutive_failures: number;
}

/** The columns `readSources` selects. `config` is deliberately absent — see the docstring. */
const SOURCE_COLUMNS = "id,name,kind,enabled,cadence_minutes,next_run_at,consecutive_failures";

/** The structural slice of the Supabase client these readers need. */
export interface SourceReader {
  from(table: "sources"): {
    select(columns: string): {
      eq(column: string, value: boolean): Promise<{
        data: unknown;
        error: { message: string } | null;
      }>;
    };
  };
}

function toSourceRow(row: Record<string, unknown>): SourceRow | null {
  if (typeof row.id !== "string" || typeof row.kind !== "string") return null;
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : "",
    kind: row.kind,
    enabled: row.enabled === true,
    cadence_minutes: typeof row.cadence_minutes === "number" ? row.cadence_minutes : 0,
    next_run_at: typeof row.next_run_at === "string" ? row.next_run_at : null,
    consecutive_failures:
      typeof row.consecutive_failures === "number" ? row.consecutive_failures : 0,
  };
}

/**
 * Read every enabled-or-not source row for the cycle.
 *
 * Reads *all* sources, not only enabled ones, and lets `planEnqueue` do the filtering.
 * That way a disabled source still appears in the plan's `skipped` list with
 * `reason: "disabled"`, which is what makes "why did my source not run" answerable. Filtering
 * in the query would make a disabled source indistinguishable from a missing one.
 */
export async function readSources(reader: SourceReader): Promise<SourceRow[]> {
  const { data, error } = await reader.from("sources").select(SOURCE_COLUMNS).eq("enabled", true);

  if (error) throw new Error(`read sources: ${error.message}`);

  return (Array.isArray(data) ? data : []).flatMap((row) => {
    const source = toSourceRow(row as Record<string, unknown>);
    return source ? [source] : [];
  });
}

// ---------------------------------------------------------------------------
// Run accounting (ING-011)
// ---------------------------------------------------------------------------

/** The counts a `scrape_runs` row records. Mirrors `0001_init.sql`'s `scrape_runs`. */
export interface RunCounts {
  found: number;
  inserted: number;
  duplicates: number;
  failed: number;
  apiCalls: number;
}

export function emptyRunCounts(): RunCounts {
  return { found: 0, inserted: 0, duplicates: 0, failed: 0, apiCalls: 0 };
}

/**
 * Derive `scrape_runs.status` from the counts.
 *
 * docs/05b ING-011 requires `status='partial'` with diagnostics when a parse only partly
 * succeeded — the case that matters operationally, because a run that fetched 200 postings
 * and failed to parse 3 is not a success and not a failure.
 *
 * The order is deliberate: `partial` is checked before `success`, so a run with both
 * successes and failures cannot report `success` and hide the failures.
 */
export function runStatusFor(
  counts: RunCounts,
  hadError: boolean,
): "success" | "partial" | "failed" {
  if (counts.found === 0 && hadError) return "failed";
  if (hadError) return "partial";
  if (counts.failed > 0) return "partial";
  if (counts.found === 0) return "failed";
  return "success";
}

/**
 * Build the `log` jsonb for a run.
 *
 * ING-011: "Partial parses set `status='partial'` with parse diagnostics in `log`". Only
 * `partial` and `failed` get diagnostics — a clean run's log is an empty object rather than
 * a list of zero-length arrays, so "was there anything to look at" is a single truthy check
 * for whoever is reading the admin table.
 */
export function buildRunLog(input: {
  status: string;
  errors: readonly string[];
  skipped: number;
}): Record<string, unknown> {
  if (input.status === "success") {
    return { skipped: input.skipped };
  }

  return {
    skipped: input.skipped,
    // Capped so one pathological source cannot write a multi-megabyte jsonb row.
    errors: input.errors.slice(0, 20),
    errorCount: input.errors.length,
    truncated: input.errors.length > 20,
  };
}
