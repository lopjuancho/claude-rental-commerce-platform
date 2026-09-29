import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { engineErrorFromSqlState } from "@/domain/availability/reasons";
import { DomainError } from "@/domain/errors";
import { fromDbError } from "@/server/catalog/errors";

const MESSAGES = {
  INSUFFICIENT_AVAILABILITY: "Not enough units are available for that time.",
  BLOCKED: "That item is blocked for that time.",
  OUTSIDE_LEAD_TIME: "That is inside the minimum booking lead time.",
  HOLD_EXPIRED: "The hold has expired. Check availability again.",
  NOT_FOUND: "Not found.",
  INVALID_REQUEST: "The request is invalid.",
  HOLD_RENEWAL_LIMIT: "This hold cannot be extended again.",
  REVIEW_REQUIRED: "The price needs staff review before this step.",
  QUOTE_EXPIRED: "This quote has expired.",
  INVALID_STATE: "That action is not possible in the current state.",
} as const;

/** Maps availability-engine SQLSTATEs (RA001…) to domain errors with safe messages. */
export function fromEngineError(error: PostgrestError, what = "Reservation"): DomainError {
  const code = engineErrorFromSqlState(error.code);
  if (!code) return fromDbError(error, what);
  const detail =
    code === "BLOCKED" && error.details
      ? ` (${error.details.replaceAll(",", ", ").toLowerCase().replaceAll("_", " ")})`
      : "";
  const domainCode = code === "INVALID_REQUEST" ? "INVALID_INPUT" : code;
  return new DomainError(domainCode, MESSAGES[code] + detail, { cause: error });
}
