/** Stable, non-sensitive error codes shared by services, API responses and (later) AI tools. */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "TENANT_NOT_FOUND",
  "RATE_LIMITED",
  "CONFLICT",
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
