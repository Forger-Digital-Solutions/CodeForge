export type CodeForgeErrorCode =
  | "FORGE_ZERO_VIOLATION"
  | "PAID_MODEL_REJECTED"
  | "LOCAL_MODEL_REJECTED"
  | "UNKNOWN_COST_REJECTED"
  | "PAID_FALLBACK_REJECTED"
  | "NO_FREE_PROVIDER"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_QUOTA_EXHAUSTED"
  | "QUOTA_EXHAUSTED"
  | "TASK_CANCELLED"
  | "TASK_TIMEOUT"
  | "RETRY_BUDGET_EXHAUSTED"
  | "SANDBOX_VIOLATION"
  | "WORKSPACE_ESCAPE"
  | "SECRET_DETECTED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "REQUIRES_SUBSCRIPTION"
  | "NOT_ENTITLED"
  | "INTERNAL_ERROR";

export class CodeForgeError extends Error {
  readonly code: CodeForgeErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CodeForgeErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CodeForgeError";
    this.code = code;
    this.details = details;
  }
}

export const forgeError = (
  code: CodeForgeErrorCode,
  message: string,
  details?: Record<string, unknown>,
): CodeForgeError => new CodeForgeError(code, message, details);
