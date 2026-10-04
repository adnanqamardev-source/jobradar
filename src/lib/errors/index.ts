/**
 * errors/index.ts — Public exports for the error taxonomy.
 */

export { ERROR_CODES, type ErrorCode, getErrorMessage, getErrorStatus } from "./codes";
export { AppError, toAppError } from "./AppError";