/**
 * logger.ts — Structured JSON logging with secret redaction.
 *
 * docs/03 §5.3: Every log line includes requestId/runId. Secrets are redacted.
 * The redaction runs on every log call — no secret should ever reach stdout.
 */

// Patterns to redact — covers all key formats in docs/02 §7.1
const SECRET_PATTERNS = [
  // Supabase keys
  /sb_secret_[A-Za-z0-9_-]{20,}/g,
  /sb_publishable_[A-Za-z0-9_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g,
  // OpenRouter
  /sk-or-v1-[A-Za-z0-9]{40,}/g,
  // Stripe
  /whsec_[A-Za-z0-9]{20,}/g,
  /rk_live_[A-Za-z0-9]{20,}/g,
  // Generic patterns for Authorization headers, cookies, etc.
  /authorization:\s*[^\s]+/gi,
  /cookie:\s*[^\s]+/gi,
  /\b[A-Za-z0-9_-]*[Kk][Ee][Yy][A-Za-z0-9_-]*\s*[=:]\s*[^\s]+/g,
  /\b[A-Za-z0-9_-]*[Ss][Ee][Cc][Rr][Ee][Tt][A-Za-z0-9_-]*\s*[=:]\s*[^\s]+/g,
  /\b[A-Za-z0-9_-]*[Tt][Oo][Kk][Ee][Nn][A-Za-z0-9_-]*\s*[=:]\s*[^\s]+/g,
];

/**
 * Redact secrets from a string.
 * Returns the string with all matched secrets replaced by ***.
 */
export function redact(input: string): string {
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, "***");
  }
  return output;
}

/**
 * Redact secrets from an object (shallow clone, recursive).
 */
export function redactObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = redact(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      const mapped = value.map((v): unknown =>
        typeof v === "string"
          ? redact(v)
          : v && typeof v === "object"
            ? redactObject(v as Record<string, unknown>)
            : v
      );
      result[key] = mapped;
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

/**
 * Generate a short request ID (8 chars from crypto.randomUUID).
 */
export function generateRequestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/**
 * Log levels in order of severity.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured log entry.
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  runId?: string;
  userId?: string;
  code?: string;
  [key: string]: unknown;
}

/**
 * Logger instance.
 */
class Logger {
  private minLevel: LogLevel = "info";
  private requestId?: string;
  private runId?: string;

  setRequestId(id: string) {
    this.requestId = id;
  }

  setRunId(id: string) {
    this.runId = id;
  }

  setMinLevel(level: LogLevel) {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error"];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private log(level: LogLevel, message: string, meta: Record<string, unknown> = {}) {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message: redact(message),
      timestamp: new Date().toISOString(),
      requestId: this.requestId,
      runId: this.runId,
      ...redactObject(meta),
    };

    // Use console.error for error/warn so they appear in stderr
    const consoleMethod = level === "error" || level === "warn" ? console.error : console.log;
    consoleMethod(JSON.stringify(entry));
  }

  debug(message: string, meta?: Record<string, unknown>) {
    this.log("debug", message, meta);
  }

  info(message: string, meta?: Record<string, unknown>) {
    this.log("info", message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>) {
    this.log("warn", message, meta);
  }

  error(message: string, meta?: Record<string, unknown>) {
    this.log("error", message, meta);
  }

  /**
   * Create a child logger with additional context.
   */
  child(context: Record<string, unknown>): Logger {
    const child = new Logger();
    child.minLevel = this.minLevel;
    child.requestId = this.requestId;
    child.runId = this.runId;
    // Override log to merge context
    const originalLog = child.log.bind(child);
    child.log = (level, message, meta) => {
      originalLog(level, message, { ...context, ...meta });
    };
    return child;
  }
}

// Singleton instance
export const logger = new Logger();