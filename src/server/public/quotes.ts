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

/**
 * Creates (or matches) the customer, the event, a priced snapshot and a draft quote.
 * `options.token` lets a caller that journals the request (the assistant, ADR 0017 §11) choose the
 * link token first, so it can find the quote by its hash if the response is lost.
 */
export async function submitQuoteRequest(
  tenant: ResolvedTenant,
  raw: unknown,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
  options: { token?: string; idempotencyKey?: string } = {},
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
    await mapped(
      deps.gateway.createEvent(org, customerId, eventRow(input.event), options.idempotencyKey),
      "Event",
    ),
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
  const token =
    options.token && isWellFormedQuoteToken(options.token) ? options.token : generateQuoteToken();
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
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    }),
    "Quote",
  );
  await audit(deps, tenant, meta, "quote.requested", "quote", quote.quoteId, {
    quoteNumber: quote.quoteNumber,
    items: input.items.length,
    totalCents: pricing.output.summary.total,
  });
  // With an idempotency key the quote may predate this call (another worker created it under the
  // same key): its token hash is the authoritative one, and our raw token is only valid if equal.
  return {
    token,
    quoteNumber: quote.quoteNumber,
    quoteId: quote.quoteId,
    tokenHash: quote.tokenHash ?? (await hashQuoteToken(token)),
  };
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
    z.object({
      name: z.string(),
      quantity: z.number(),
      start: z.string(),
      end: z.string(),
      variantId: z.string().nullish(),
      productId: z.string().nullish(),
    }),
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
  /** The event changed after this quote was priced: it must be re-quoted before booking. */
  stale: z.boolean().default(false),
});
export type PublicQuoteView = z.infer<typeof viewSchema>;

/**
 * Proof of access to a quote: the raw link token (storefront), or its SHA-256 for server-side
 * holders that never keep the raw token (the assistant's session, ADR 0017 §6).
 */
export type QuoteCredential = string | { tokenHash: string };

async function credentialHash(credential: QuoteCredential): Promise<string | null> {
  if (typeof credential !== "string") {
    return /^[0-9a-f]{64}$/.test(credential.tokenHash) ? credential.tokenHash : null;
  }
  return isWellFormedQuoteToken(credential) ? hashQuoteToken(credential) : null;
}

/** The customer's view of their quote (marks a sent quote viewed). Unknown token → null. */
export async function getPublicQuote(
  tenant: ResolvedTenant,
  token: QuoteCredential,
  deps: PublicDeps = defaultDeps(),
): Promise<PublicQuoteView | null> {
  const hash = await credentialHash(token);
  if (!hash) return null;
  const view = await mapped(deps.gateway.publicQuoteView(tenant.organizationId, hash), "Quote");
  return view === null ? null : viewSchema.parse(view);
}

const bookingInput = z.strictObject({ message: z.string().trim().max(2000).optional() });

async function tokenHash(token: QuoteCredential) {
  const hash = await credentialHash(token);
  if (!hash) throw new DomainError("NOT_FOUND", "Quote not found.");
  return hash;
}

/**
 * Holds the quote's items for the organization's hold duration (15 minutes by default). Each
 * anonymous visitor may have a limited number of live holds per organization (ADR 0015 §14); the
 * database counts them by the hash of the visitor token, never by email or IP.
 */
export async function requestPublicBooking(
  tenant: ResolvedTenant,
  token: QuoteCredential,
  raw: unknown,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
  options: { idempotencyKey?: string } = {},
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
      options.idempotencyKey,
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
