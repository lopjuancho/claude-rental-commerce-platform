/** A pg Client or Pool. */
interface Queryable {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export function resolveOrganization(db: Queryable, hostname: string): Promise<string | null>;
export function quoteByLink(
  db: Queryable,
  organizationId: string,
  url: string | null | undefined,
): Promise<{ id: string; quoteNumber: string } | null>;
export function bookingRequestsFor(
  db: Queryable,
  organizationId: string,
  quoteIds: string[],
): Promise<number>;
export function expireQuote(
  db: Queryable,
  organizationId: string,
  quoteId: string,
): Promise<number>;
export function makeQuoteStale(
  db: Queryable,
  organizationId: string,
  quoteId: string,
): Promise<number>;
export function currentSessionToken(jar: Map<string, string>): string | null;
export function toolsRun(
  db: Queryable,
  organizationId: string,
  sessionToken: string | null,
): Promise<Set<string>>;
export function countForCustomer(
  db: Queryable,
  organizationId: string,
  email: string,
  kind: "quotes" | "bookings",
): Promise<number>;
export function storedTurn(
  db: Queryable,
  organizationId: string,
  sessionToken: string | null,
  requestKey: string,
): Promise<{ status: string; attempt: number; bookingRefs: number } | null>;
export function conversationCounters(
  db: Queryable,
  organizationId: string,
  sessionToken: string | null,
): Promise<{ messages: number; actions: number; attempts: number } | null>;
export function cancelSmokeBooking(
  client: Queryable,
  organizationId: string,
  quoteId: string,
): Promise<string | null>;
export function bookingStatus(
  db: Queryable,
  organizationId: string,
  quoteId: string,
): Promise<string | null>;
export const SMOKE_TAG: RegExp;
export interface SmokeBlock {
  id: string;
  productId: string;
}
export function addSmokeAvailabilityBlock(
  db: Queryable,
  organizationId: string,
  productSlug: string,
  isoDate: string,
  tag: string,
): Promise<SmokeBlock | null>;
export function removeSmokeAvailabilityBlock(
  db: Queryable,
  organizationId: string,
  block: SmokeBlock,
  tag: string,
): Promise<number>;
export function bookingHoldReleased(
  db: Queryable,
  organizationId: string,
  quoteId: string,
): Promise<{
  requestStatus: string;
  blockingAllocations: number;
  residualAllocations: number;
} | null>;
export function reconcileSmokeBookings(
  db: Queryable,
  organizationId: string,
  quoteIds: Iterable<string>,
  emails: Iterable<string>,
): Promise<{
  quotes: number;
  quoteList: { id: string; quoteNumber: string }[];
  requests: number;
  cancelled: number;
  unresolved: string[];
}>;
export const LEASE_GRACE_SECONDS: number;
export type RequestTransport =
  "in_flight" | "response_completed" | "transport_failed_unknown" | "wait_timed_out_unknown";
export interface SmokeDelivery {
  state: RequestTransport;
  httpStatus: number | null;
  /** A recognized application pre-turn refusal code (PRE_TURN_REFUSALS), or null. */
  refusal: string | null;
}
export const PRE_TURN_REFUSALS: Readonly<Record<number, readonly string[]>>;
export function preTurnRefusal(status: number | null, body: unknown): string | null;
export function requestTerminality(
  db: Queryable,
  organizationId: string,
  sessionToken: string | null,
  requestKey: string,
  sends?: Pick<SmokeDelivery, "refusal">[],
): Promise<{ terminal: boolean; reason: string }>;
export interface SmokeRequestIntent {
  requestId: string;
  sessionToken: string | null;
  sends: SmokeDelivery[];
  /** The latest delivery's transport state. */
  state: RequestTransport;
  resolution: "terminal" | "unknown" | null;
}
export function trackedExchange<R extends { status: number; text: () => Promise<string> }>(
  cleanup: ReturnType<typeof createSmokeCleanup>,
  requestId: string,
  sessionToken: string | null,
  send: () => Promise<R>,
): Promise<{ res: R; raw: string; body: unknown }>;
export function modelCalls(
  db: Queryable,
  organizationId: string,
  sessionToken: string | null,
): Promise<number>;
export interface SmokeCleanupState {
  tag: string;
  organizationId: string | null;
  quoteIds: Set<string>;
  quoteNumbers: Map<string, string>;
  customerEmails: Set<string>;
  requests: Map<string, SmokeRequestIntent>;
  bookingOutcome:
    | "not_started"
    | "reconciled_no_booking_terminal"
    | "reconciled_booking_cancelled"
    | "unresolved";
  block: SmokeBlock | null;
  bookingCleanup: string;
  blockCleanup: string;
  unresolved: string[];
  stopping: boolean;
  inFlight: Promise<unknown> | null;
}
export function createSmokeCleanup(
  db: Queryable,
  tag: string,
): {
  state: SmokeCleanupState;
  run(options?: { waitForInFlightMs?: number; blockOnly?: boolean }): Promise<SmokeCleanupState>;
  recovery(): string[];
  beginRequest(
    requestId: string,
    sessionToken: string | null,
  ): {
    intent: SmokeRequestIntent;
    send: SmokeDelivery;
    responded: (httpStatus?: number | null, body?: unknown) => void;
    failed: () => void;
  };
};
