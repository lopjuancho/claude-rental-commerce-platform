/** Stable, non-sensitive error codes shared by services, API responses and (later) AI tools. */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "TENANT_NOT_FOUND",
  "RATE_LIMITED",
  "CONFLICT",
  "INSUFFICIENT_AVAILABILITY",
  "BLOCKED",
  "OUTSIDE_LEAD_TIME",
  "HOLD_EXPIRED",
  "HOLD_RENEWAL_LIMIT",
  "REVIEW_REQUIRED",
  "QUOTE_EXPIRED",
  "INVALID_STATE",
  "STALE_BOOKING_REQUEST",
  "PUBLIC_HOLD_LIMIT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DomainError";
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
