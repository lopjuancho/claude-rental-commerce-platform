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
    case "RA011":
      // Hardening H1: capacity-reducing edits are refused while bookings/holds need the stock.
      return new DomainError(
        "CONFLICT",
        "That change would take away stock that is booked, held or blocked. " +
          (error.details ? `(${error.details}) ` : "") +
          "Move or cancel those bookings first, or add a maintenance block for the future.",
        { cause: error },
      );
    case "RA012":
      return new DomainError("INVALID_INPUT", error.message.replace(/^INVALID_LOCAL_TIME: /, ""), {
        cause: error,
      });
    case "42501":
      return new DomainError("FORBIDDEN", undefined, { cause: error });
    case "PGRST116":
      return new DomainError("NOT_FOUND", `${what} not found.`, { cause: error });
    default:
      return new DomainError("INTERNAL", `Could not save ${what.toLowerCase()}.`, { cause: error });
  }
}
