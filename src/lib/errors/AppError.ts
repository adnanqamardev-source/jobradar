/**
 * errors/AppError.ts — Base application error class.
 *
 * All thrown errors in the app should be AppError instances (or subclasses).
 * This ensures every error carries a stable code, optional requestId, and userId.
 */

import { ErrorCode, getErrorMessage, getErrorStatus } from "./codes";

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus: number;
  public readonly requestId?: string;
  public readonly userId?: string;
  public readonly cause?: Error;

  constructor(
    code: ErrorCode,
    options: {
      message?: string;
      requestId?: string;
      userId?: string;
      cause?: Error;
    } = {}
  ) {
    super(options.message ?? getErrorMessage(code));
    this.name = "AppError";
    this.code = code;
    this.httpStatus = getErrorStatus(code);
    this.requestId = options.requestId;
    this.userId = options.userId;
    this.cause = options.cause;

    // Maintains proper stack trace in V8 environments
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * Serialize for logging — includes structured fields but not the stack.
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      requestId: this.requestId,
      userId: this.userId,
      cause: this.cause?.message,
    };
  }

  /**
   * Check if an error is an AppError (type guard).
   */
  static isAppError(err: unknown): err is AppError {
    return err instanceof AppError;
  }
}

/**
 * Create an AppError from an unknown error, defaulting to internal_error.
 */
export function toAppError(err: unknown, requestId?: string, userId?: string): AppError {
  if (AppError.isAppError(err)) return err;
  if (err instanceof Error) {
    return new AppError("internal_error", { message: err.message, requestId, userId, cause: err });
  }
  return new AppError("internal_error", { message: String(err), requestId, userId });
}