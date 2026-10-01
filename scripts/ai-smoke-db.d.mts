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
export function addSmokeAvailabilityBlock(
  db: Queryable,
  organizationId: string,
  productSlug: string,
  isoDate: string,
  tag: string,
): Promise<string | null>;
export function removeSmokeAvailabilityBlocks(
  db: Queryable,
  organizationId: string,
  tag: string,
): Promise<number>;
