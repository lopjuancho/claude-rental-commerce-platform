/**
 * What the customer's quote page offers next (ADR 0016). Decided from the server's quote view only,
 * in priority order, so a stale or expired quote never shows "Request booking".
 */
export interface QuoteViewFacts {
  status: string;
  expired: boolean;
  stale?: boolean;
  canRequestBooking: boolean;
  booking: { status: string; holdActive: boolean; holdExpiresAt: string | null } | null;
}

export type QuoteStep =
  | { kind: "confirmed" }
  | { kind: "closed"; status: string }
  | { kind: "stale" }
  | { kind: "expired" }
  | { kind: "holding"; until: string }
  | { kind: "awaiting_review" }
  | { kind: "request" }
  | { kind: "none" };

export const STALE_MESSAGE =
  "Your event details changed, so we need to recalculate availability and pricing.";

export function quoteNextStep(q: QuoteViewFacts): QuoteStep {
  if (q.booking?.status === "confirmed" || q.status === "accepted") return { kind: "confirmed" };
  if (q.status === "declined" || q.status === "cancelled")
    return { kind: "closed", status: q.status };
  // A request already with our team keeps its hold controls; staff re-quote if needed.
  if (q.booking?.status === "pending" && q.booking.holdActive && q.booking.holdExpiresAt)
    return { kind: "holding", until: q.booking.holdExpiresAt };
  if (q.booking?.status === "pending") return { kind: "awaiting_review" };
  if (q.stale) return { kind: "stale" };
  if (q.expired || q.status === "expired") return { kind: "expired" };
  if (q.canRequestBooking) return { kind: "request" };
  return { kind: "none" };
}
