/**
 * instrumentation.ts — Next.js Sentry instrumentation entry point.
 *
 * This runs once when the Next.js server starts.
 */

import { initSentry } from "@/lib/sentry";

export function register() {
  initSentry();
}