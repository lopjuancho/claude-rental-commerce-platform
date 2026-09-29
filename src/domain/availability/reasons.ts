/** Reasons returned by the availability functions (SQL) and relayed by services and the assistant. */
export const AVAILABILITY_REASONS = {
  INSUFFICIENT_QUANTITY: "Not enough units are free for that time.",
  BLACKOUT: "The business is closed for bookings then.",
  PRODUCT_BLOCKED: "This item is blocked for that time.",
  UNAVAILABLE: "This item is not available for that time.",
  VARIANT_INACTIVE: "This item is not currently offered.",
  WEATHER_BLOCK: "A weather safety block is in effect for this item at that time.",
  OUTSIDE_LEAD_TIME: "That is too soon to book online; please contact the business.",
  RENTAL_TOO_LONG: "That rental is longer than the maximum allowed.",
} as const;

export type AvailabilityReason = keyof typeof AVAILABILITY_REASONS;

export const isAvailabilityReason = (value: string): value is AvailabilityReason =>
  value in AVAILABILITY_REASONS;

/** SQLSTATE codes raised by the engine (see the availability migration header). */
export const ENGINE_ERRORS = {
  RA001: "INSUFFICIENT_AVAILABILITY",
  RA002: "BLOCKED",
  RA003: "OUTSIDE_LEAD_TIME",
  RA004: "HOLD_EXPIRED",
  RA005: "NOT_FOUND",
  RA006: "INVALID_REQUEST",
  RA007: "HOLD_RENEWAL_LIMIT",
  RA008: "REVIEW_REQUIRED",
  RA009: "QUOTE_EXPIRED",
  RA010: "INVALID_STATE",
  RA013: "STALE_BOOKING_REQUEST",
} as const;

export type EngineError = (typeof ENGINE_ERRORS)[keyof typeof ENGINE_ERRORS];

export function engineErrorFromSqlState(code: string | undefined): EngineError | null {
  return code && code in ENGINE_ERRORS ? ENGINE_ERRORS[code as keyof typeof ENGINE_ERRORS] : null;
}
