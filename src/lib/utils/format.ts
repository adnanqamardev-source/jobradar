/**
 * format.ts — display formatters shared by the feed card and the job detail.
 *
 * Pure functions, no React — the detail page (FE-108) imports the same two
 * helpers so a salary or date never renders differently between the card and
 * the page. Phase 3 owns how they *look*; this file owns what they *say*.
 */

import type { FeedRow } from "@/lib/db/queries/feed";

const PERIOD_LABELS: Record<string, string> = {
  year: "/yr",
  month: "/mo",
  hour: "/hr",
};

/**
 * Format a job's salary range, or `null` when nothing was parsed.
 *
 * Both bounds present → `160000–190000 USD/yr`. One bound → `from 160000 …`
 * / `up to 190000 …`. No currency → the numbers still render, because a salary
 * without a currency is more useful than no salary at all.
 */
export function formatSalary(job: Pick<FeedRow, "salary_min" | "salary_max" | "salary_currency" | "salary_period">): string | null {
  const { salary_min, salary_max, salary_currency, salary_period } = job;
  if (salary_min == null && salary_max == null) return null;

  const currency = salary_currency ?? "";
  const period = salary_period ? (PERIOD_LABELS[salary_period] ?? ` ${salary_period}`) : "";

  if (salary_min != null && salary_max != null) {
    return `${salary_min}–${salary_max} ${currency}${period}`.trim();
  }
  if (salary_min != null) {
    return `from ${salary_min} ${currency}${period}`.trim();
  }
  return `up to ${salary_max} ${currency}${period}`.trim();
}

/**
 * Format an ISO timestamp as a short local date. `posted_at` is nullable —
 * a job with no parsed date renders "unknown", never "Invalid Date".
 *
 * The locale is pinned (`en-US`) rather than taken from the runtime: the same
 * posting must render the same date on the server, on the client, and in
 * tests, regardless of where the process runs. Phase 3 may revisit this.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("en-US");
}
