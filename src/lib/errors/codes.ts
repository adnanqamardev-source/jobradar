/**
 * errors/codes.ts — Stable error codes mapped to user-facing copy.
 *
 * docs/03 §5.1 defines the exact codes and messages. This file is the single
 * source of truth; both server and client import from here.
 */

export const ERROR_CODES = {
  validation_failed: {
    code: "validation_failed",
    httpStatus: 422,
    message: "Please check your input and try again.",
  },
  unauthenticated: {
    code: "unauthenticated",
    httpStatus: 401,
    message: "Your session expired. Sign in to pick up where you left off.",
  },
  forbidden: {
    code: "forbidden",
    httpStatus: 403,
    message: "That's a Pro feature.",
  },
  not_found: {
    code: "not_found",
    httpStatus: 404,
    message: "We couldn't find that.",
  },
  rate_limited: {
    code: "rate_limited",
    httpStatus: 429,
    message: "You're moving fast — try again in 60 seconds.",
  },
  quota_exceeded: {
    code: "quota_exceeded",
    httpStatus: 402,
    message: "You've reached your plan limit.",
  },
  upstream_timeout: {
    code: "upstream_timeout",
    httpStatus: 504,
    message: "That source is slow right now — we'll retry it in the background.",
  },
  upstream_error: {
    code: "upstream_error",
    httpStatus: 502,
    message: "That source returned an error — we'll retry it in the background.",
  },
  scrape_parse_failed: {
    code: "scrape_parse_failed",
    httpStatus: 500,
    message: "Failed to parse source data.",
  },
  email_delivery_failed: {
    code: "email_delivery_failed",
    httpStatus: 500,
    message: "Failed to send email.",
  },
  payment_failed: {
    code: "payment_failed",
    httpStatus: 402,
    message: "Payment didn't go through — your card was declined. Update it to stay on Pro.",
  },
  webhook_invalid: {
    code: "webhook_invalid",
    httpStatus: 400,
    message: "Invalid webhook signature.",
  },
  service_unavailable: {
    code: "service_unavailable",
    httpStatus: 503,
    message: "Something's on our end. We're looking into it.",
  },
  internal_error: {
    code: "internal_error",
    httpStatus: 500,
    message: "Something went wrong. Try again.",
  },
  file_too_large: {
    code: "file_too_large",
    httpStatus: 413,
    message: "PDFs under 5 MB only.",
  },
  file_type_invalid: {
    code: "file_type_invalid",
    httpStatus: 415,
    message: "PDFs only.",
  },
  account_locked: {
    code: "account_locked",
    httpStatus: 429,
    message: "Too many attempts. Wait 15 minutes and try again.",
  },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Get the user-facing message for an error code.
 * Never expose internal details — only the curated copy.
 */
export function getErrorMessage(code: ErrorCode): string {
  return ERROR_CODES[code]?.message ?? ERROR_CODES.internal_error.message;
}

/**
 * Get the HTTP status for an error code.
 */
export function getErrorStatus(code: ErrorCode): number {
  return ERROR_CODES[code]?.httpStatus ?? ERROR_CODES.internal_error.httpStatus;
}