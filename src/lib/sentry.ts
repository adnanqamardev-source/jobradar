/**
 * sentry.ts — Sentry initialization for Next.js.
 *
 * docs/03 §5.3: sendDefaultPii: false (no résumé content, no email in breadcrumbs).
 * Every caught AppError reports with { code, requestId, userId }.
 */

import * as Sentry from "@sentry/nextjs";

export function initSentry() {
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) {
    // Sentry DSN not configured — skip initialization
    return;
  }

  Sentry.init({
    dsn,
    // Performance monitoring
    tracesSampleRate: 0.2, // 20% traces
    // Filter out health checks and noise
    ignoreErrors: [
      // Ignore network errors that are not actionable
      "NetworkError",
      "Failed to fetch",
      // Next.js specific noise
      "NEXT_REDIRECT",
      "NEXT_NOT_FOUND",
    ],
    // Custom tags for filtering
    initialScope: {
      tags: {
        environment: process.env.NODE_ENV || "development",
      },
    },
    // Before send hook to attach structured context
    beforeSend(event, hint) {
      // Only send error events, not transactions
      if (event.exception) {
        const error = hint.originalException;
        if (error && typeof error === "object" && "code" in error) {
          // AppError has code, requestId, userId
          const appError = error as { code?: string; requestId?: string; userId?: string };
          if (appError.code) {
            event.tags = { ...event.tags, error_code: appError.code };
          }
          if (appError.requestId) {
            event.tags = { ...event.tags, request_id: appError.requestId };
          }
          if (appError.userId) {
            event.user = { id: appError.userId };
          }
        }
      }
      return event;
    },
  });
}

// Export Sentry for manual capture
export { Sentry };