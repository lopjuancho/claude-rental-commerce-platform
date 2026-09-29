/**
 * Quote lifecycle (ADR 0014). Mirrors app.quote_transition_allowed() in the database, which is the
 * authority; this copy drives the UI (which buttons to show) and is checked against SQL in tests.
 */
export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
  "cancelled",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const QUOTE_TRANSITIONS: Readonly<Record<QuoteStatus, readonly QuoteStatus[]>> = {
  draft: ["sent", "accepted", "cancelled"],
  sent: ["viewed", "accepted", "declined", "expired", "cancelled", "draft"],
  viewed: ["accepted", "declined", "expired", "cancelled", "draft"],
  accepted: [],
  declined: [],
  expired: ["draft"],
  cancelled: [],
};

export function canTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return from === to || QUOTE_TRANSITIONS[from].includes(to);
}

/** Only drafts can be re-priced or edited; every other state is a fixed document. */
export const isEditable = (status: QuoteStatus) => status === "draft";

/** A booking (15-minute hold) can be requested from these states. */
export const canRequestBooking = (status: QuoteStatus) =>
  status === "draft" || status === "sent" || status === "viewed";

export interface ReviewState {
  manualReviewRequired: boolean | null;
  reviewApprovedAt: string | null;
}

/** Sending or accepting a price that needs review requires a staff sign-off first. */
export const reviewBlocks = (q: ReviewState) =>
  q.manualReviewRequired === true && q.reviewApprovedAt === null;

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  accepted: "Accepted",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
};
