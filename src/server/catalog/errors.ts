import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { DomainError } from "@/domain/errors";

/** Maps database errors to safe domain errors. Constraint details never reach the client. */
export function fromDbError(error: PostgrestError, what: string): DomainError {
  switch (error.code) {
    case "23505":
      return new DomainError(
        "CONFLICT",
        `${what} with that URL slug or identifier already exists.`,
        { cause: error },
      );
    case "23514":
    case "23503":
    case "22P02":
      return new DomainError("INVALID_INPUT", `${what} data is invalid.`, { cause: error });
    case "42501":
      return new DomainError("FORBIDDEN", undefined, { cause: error });
    case "PGRST116":
      return new DomainError("NOT_FOUND", `${what} not found.`, { cause: error });
    default:
      return new DomainError("INTERNAL", `Could not save ${what.toLowerCase()}.`, { cause: error });
  }
}
