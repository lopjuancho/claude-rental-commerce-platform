import "server-only";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { QUOTE_STATUSES } from "@/domain/quotes/state-machine";
import { eventRow, publicQuoteRequestSchema } from "@/domain/quotes/schemas";
import { fromEngineError } from "@/server/availability/errors";
import { getDistanceProvider } from "@/server/delivery/provider";
import { gatewayPricingSource } from "@/server/pricing/run";
import { buildPriceRequest, eventWindow, priceQuote } from "@/server/quotes/core";
import { generateQuoteToken, hashQuoteToken, isWellFormedQuoteToken } from "@/server/quotes/token";
import { enforceRateLimit } from "@/server/rate-limit";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { GatewayError, systemGateway } from "@/server/trusted/gateway";
import type { PublicDeps, RequestMeta } from "./deps";
import { hashVisitorToken, isWellFormedVisitorToken } from "@/server/visitor";

/**
 * The public quote / booking-request flow (ADR 0001, 0002, 0014, 0015).
 * - The organization is always the host-resolved tenant; nothing in the input can change it.
 * - Inputs are strict: contact, event, item choices, delivery-or-pickup, an optional code/message.
 * - Visitors never touch the database: every write is one explicit gateway operation (a narrow SQL
 *   function), with the same invariants as staff paths (derived totals, lock protocol, holds).
 * - Every write is rate-limited per tenant + client and audited as 'public'.
 * - Prices shown are exactly the engine's snapshot; availability is decided by the database.
 */
function defaultDeps(): PublicDeps {
  return { gateway: systemGateway(), rateLimit: enforceRateLimit, provider: getDistanceProvider() };
}

async function mapped<T>(p: Promise<T>, what: string): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GatewayError) throw fromEngineError(e.db, what);
    throw e;
  }
}

const limitKey = (tenant: ResolvedTenant, meta: RequestMeta) =>
  `${tenant.organizationId}:${meta.ip}`;

async function audit(
  deps: PublicDeps,
  tenant: ResolvedTenant,
  meta: RequestMeta,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Record<string, string | number | null>,
) {
  await deps.gateway.recordAudit(tenant.organizationId, {
    actor: meta.actor ?? "public",
    action,
    entityType,
    entityId,
    ...(metadata ? { metadata } : {}),
    ipAddress: meta.ip,
    userAgent: meta.userAgent ?? null,
    requestId: meta.requestId ?? null,
  });
}

/** Creates (or matches) the customer, the event, a priced snapshot and a draft quote. */
export async function submitQuoteRequest(
  tenant: ResolvedTenant,
  raw: unknown,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
) {
  await deps.rateLimit("publicWrite", limitKey(tenant, meta));
  const input = publicQuoteRequestSchema.parse(raw);
  const org = tenant.organizationId;
  const source = meta.actor === "ai" ? "assistant" : "web";

  const customerId = await mapped(
    deps.gateway.matchOrCreateCustomer(org, { ...input.contact, source }),
    "Customer",
  );
  const window = eventWindow(
    await mapped(deps.gateway.createEvent(org, customerId, eventRow(input.event)), "Event"),
  );
  const request = buildPriceRequest({
    items: input.items,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    address: input.event.address,
    delivery: input.delivery,
    discountCodes: input.discountCode ? [input.discountCode] : [],
  });
  const pricing = await priceQuote(
    {
      source: gatewayPricingSource(deps.gateway, org),
      gateway: deps.gateway,
      provider: deps.provider,
      actor: { type: meta.actor ?? "public" },
    },
    org,
    request,
    "public",
  );
  const token = generateQuoteToken();
  const quote = await mapped(
    deps.gateway.createQuote(org, {
      customerId,
      eventId: window.eventId,
      calculationId: pricing.calculationId,
      priceRequest: request,
      source,
      tokenHash: await hashQuoteToken(token),
      customerNotes: input.message ?? null,
      submittedContact: input.contact,
    }),
    "Quote",
  );
  await audit(deps, tenant, meta, "quote.requested", "quote", quote.quoteId, {
    quoteNumber: quote.quoteNumber,
    items: input.items.length,
    totalCents: pricing.output.summary.total,
  });
  return { token, quoteNumber: quote.quoteNumber };
}

const viewSchema = z.object({
  quoteNumber: z.string(),
  status: z.enum(QUOTE_STATUSES),
  expired: z.boolean(),
  expiresAt: z.string().nullable(),
  currency: z.string(),
  priceIsFinal: z.boolean(),
  lines: z.array(z.object({ label: z.string(), amountCents: z.number(), kind: z.string() })),
  taxLines: z.array(z.object({ name: z.string(), amountCents: z.number() })),
  subtotalCents: z.number(),
  taxCents: z.number(),
  totalCents: z.number(),
  items: z.array(
    z.object({ name: z.string(), quantity: z.number(), start: z.string(), end: z.string() }),
  ),
  event: z
    .object({
      startsAt: z.string().nullable(),
      endsAt: z.string().nullable(),
      address: z.string().nullable(),
    })
    .nullable(),
  booking: z
    .object({
      status: z.enum(["pending", "confirmed", "declined", "cancelled"]),
      holdExpiresAt: z.string().nullable(),
      holdActive: z.boolean(),
    })
    .nullable(),
  canRequestBooking: z.boolean(),
});
export type PublicQuoteView = z.infer<typeof viewSchema>;

/** The customer's view of their quote (marks a sent quote viewed). Unknown token → null. */
export async function getPublicQuote(
  tenant: ResolvedTenant,
  token: string,
  deps: PublicDeps = defaultDeps(),
): Promise<PublicQuoteView | null> {
  if (!isWellFormedQuoteToken(token)) return null;
  const view = await mapped(
    deps.gateway.publicQuoteView(tenant.organizationId, await hashQuoteToken(token)),
    "Quote",
  );
  return view === null ? null : viewSchema.parse(view);
}

const bookingInput = z.strictObject({ message: z.string().trim().max(2000).optional() });

async function tokenHash(token: string) {
  if (!isWellFormedQuoteToken(token)) throw new DomainError("NOT_FOUND", "Quote not found.");
  return hashQuoteToken(token);
}

/**
 * Holds the quote's items for the organization's hold duration (15 minutes by default). Each
 * anonymous visitor may have a limited number of live holds per organization (ADR 0015 §14); the
 * database counts them by the hash of the visitor token, never by email or IP.
 */
export async function requestPublicBooking(
  tenant: ResolvedTenant,
  token: string,
  raw: unknown,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
) {
  await deps.rateLimit("publicWrite", limitKey(tenant, meta));
  const { message } = bookingInput.parse(raw);
  if (!isWellFormedVisitorToken(meta.visitorToken)) {
    throw new DomainError(
      "INVALID_INPUT",
      "We could not identify your browser session. Please reload the page and try again.",
    );
  }
  const hold = await mapped(
    deps.gateway.requestBookingByToken(
      tenant.organizationId,
      await tokenHash(token),
      meta.actor === "ai" ? "assistant" : "web",
      message ?? null,
      await hashVisitorToken(meta.visitorToken),
    ),
    "Booking request",
  );
  await audit(deps, tenant, meta, "booking.requested", "booking_request", hold.bookingRequestId, {
    quoteNumber: hold.quoteNumber,
    holdExpiresAt: hold.holdExpiresAt,
  });
  return { holdExpiresAt: hold.holdExpiresAt };
}

export async function renewPublicHold(
  tenant: ResolvedTenant,
  token: string,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
) {
  await deps.rateLimit("publicWrite", limitKey(tenant, meta));
  const holdExpiresAt = await mapped(
    deps.gateway.renewBookingHoldByToken(tenant.organizationId, await tokenHash(token)),
    "Booking request",
  );
  return { holdExpiresAt };
}

export async function cancelPublicBooking(
  tenant: ResolvedTenant,
  token: string,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
) {
  await deps.rateLimit("publicWrite", limitKey(tenant, meta));
  const id = await mapped(
    deps.gateway.cancelBookingByToken(tenant.organizationId, await tokenHash(token)),
    "Booking request",
  );
  await audit(deps, tenant, meta, "booking.cancelled", "booking_request", id);
}
