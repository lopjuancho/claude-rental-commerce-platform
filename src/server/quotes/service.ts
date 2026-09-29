import "server-only";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { priceRequestSchema } from "@/domain/pricing/context";
import type { PriceResult } from "@/domain/pricing/types";
import { QUOTE_STATUSES, type QuoteStatus } from "@/domain/quotes/state-machine";
import { staffQuoteSchema } from "@/domain/quotes/schemas";
import { fromEngineError } from "@/server/availability/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { getDistanceProvider } from "@/server/delivery/provider";
import { userPricingSource } from "@/server/pricing/run";
import { systemGateway } from "@/server/trusted/gateway";
import {
  buildPriceRequest,
  priceQuote,
  repriceDraft,
  staffCreateEvent,
  staffCreateQuote,
  staffUpdateEvent,
} from "./core";
import { generateQuoteToken, hashQuoteToken } from "./token";

const QUOTE_COLUMNS = `id, quote_number, status, source, customer_id, event_id, pricing_calculation_id,
  price_request, currency, subtotal_cents, delivery_cents, discount_cents, tax_cents, total_cents,
  manual_review_required, review_reasons, review_approved_at, review_approved_by, review_note,
  token_hash, expires_at, sent_at, viewed_at, accepted_at, declined_at, cancelled_at,
  customer_notes, internal_notes, created_by_type, created_at, updated_at`;

export async function listQuotes(status?: string) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  let query = db
    .from("quotes")
    .select(
      "id, quote_number, status, total_cents, currency, manual_review_required, review_approved_at, source, created_at, expires_at, customers(first_name, last_name, company_name, email, phone_e164), events(starts_at, city)",
    )
    .eq("organization_id", ctx.organizationId)
    .order("created_at", { ascending: false })
    .limit(200);
  const s = z.enum(QUOTE_STATUSES).safeParse(status);
  if (s.success) query = query.eq("status", s.data);
  const { data, error } = await query;
  if (error) throw fromEngineError(error, "Quote");
  return data;
}

export async function getQuote(id: string) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const quoteId = z.uuid().parse(id);
  const { data: quote, error } = await db
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("organization_id", ctx.organizationId)
    .eq("id", quoteId)
    .maybeSingle();
  if (error) throw fromEngineError(error, "Quote");
  if (!quote) throw new DomainError("NOT_FOUND", "Quote not found.");

  const [items, calc, customer, event, bookings] = await Promise.all([
    db.from("quote_items").select("*").eq("quote_id", quote.id).order("sort_order"),
    quote.pricing_calculation_id
      ? db
          .from("pricing_calculations")
          .select("id, output, engine_version, created_at")
          .eq("id", quote.pricing_calculation_id)
          .single()
      : Promise.resolve({ data: null, error: null }),
    quote.customer_id
      ? db
          .from("customers")
          .select("id, first_name, last_name, company_name, email, phone_e164")
          .eq("id", quote.customer_id)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    quote.event_id
      ? db.from("events").select("*").eq("id", quote.event_id).single()
      : Promise.resolve({ data: null, error: null }),
    db
      .from("booking_requests")
      .select(
        "id, status, source, customer_message, decision_note, created_at, decided_at, reservation_id, reservations(status, hold_expires_at)",
      )
      .eq("quote_id", quote.id)
      .order("created_at", { ascending: false }),
  ]);
  for (const r of [items, calc, customer, event, bookings]) {
    if (r.error) throw fromEngineError(r.error, "Quote");
  }
  const { token_hash, ...rest } = quote;
  return {
    ...rest,
    hasCustomerLink: token_hash !== null,
    items: items.data ?? [],
    pricing: (calc.data?.output ?? null) as unknown as PriceResult | null,
    pricingCreatedAt: calc.data?.created_at ?? null,
    customer: customer.data,
    event: event.data,
    bookingRequests: bookings.data ?? [],
  };
}

/** Creates the event, prices it (immutable snapshot, stored by trusted code) and saves a draft. */
export async function createQuote(raw: unknown) {
  const ctx = await requireStaff("quotes.write");
  if (!ctx.permissions.has("events.write")) throw new DomainError("FORBIDDEN");
  const input = staffQuoteSchema.parse(raw);
  const db = await createUserClient();
  const window = await staffCreateEvent(db, ctx.organizationId, input.customerId, input.event);
  const request = buildPriceRequest({
    items: input.items,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    address: input.event.address,
    delivery: input.delivery,
    discountCodes: input.discountCodes,
    adjustments: input.adjustments,
  });
  const pricing = await priceQuote(
    {
      source: userPricingSource(db, ctx.organizationId),
      gateway: systemGateway(),
      provider: getDistanceProvider(),
      actor: { type: "user", userId: ctx.user.id },
    },
    ctx.organizationId,
    request,
    "staff",
  );
  const quote = await staffCreateQuote(db, ctx.organizationId, {
    customerId: input.customerId,
    eventId: window.eventId,
    request,
    calculationId: pricing.calculationId,
    customerNotes: input.customerNotes ?? null,
    internalNotes: input.internalNotes ?? null,
  });
  return { ...quote, pricing };
}

/** Edits a draft (event + items) and re-prices it. Sent quotes must be revised to draft first. */
export async function updateDraftQuote(id: string, raw: unknown) {
  const ctx = await requireStaff("quotes.write");
  const quoteId = z.uuid().parse(id);
  const input = staffQuoteSchema.parse(raw);
  const db = await createUserClient();
  const current = await db
    .from("quotes")
    .select("status, event_id")
    .eq("organization_id", ctx.organizationId)
    .eq("id", quoteId)
    .maybeSingle();
  if (current.error) throw fromEngineError(current.error, "Quote");
  if (!current.data) throw new DomainError("NOT_FOUND", "Quote not found.");
  if (current.data.status !== "draft") {
    throw new DomainError("INVALID_STATE", "Only draft quotes can be edited.");
  }
  const window = current.data.event_id
    ? await staffUpdateEvent(db, ctx.organizationId, current.data.event_id, input.event)
    : await staffCreateEvent(db, ctx.organizationId, input.customerId, input.event);
  const request = buildPriceRequest({
    items: input.items,
    startsAt: window.startsAt,
    endsAt: window.endsAt,
    address: input.event.address,
    delivery: input.delivery,
    discountCodes: input.discountCodes,
    adjustments: input.adjustments,
  });
  const { error } = await db
    .from("quotes")
    .update({
      customer_id: input.customerId,
      event_id: window.eventId,
      customer_notes: input.customerNotes ?? null,
      internal_notes: input.internalNotes ?? null,
    })
    .eq("organization_id", ctx.organizationId)
    .eq("id", quoteId);
  if (error) throw fromEngineError(error, "Quote");
  return repriceDraft(
    db,
    systemGateway(),
    getDistanceProvider(),
    ctx.user.id,
    ctx.organizationId,
    quoteId,
    request,
  );
}

/** Re-runs the stored request against today's rules and prices (drafts only). */
export async function repriceQuote(id: string) {
  const ctx = await requireStaff("quotes.write");
  const db = await createUserClient();
  const { data, error } = await db
    .from("quotes")
    .select("status, price_request")
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id))
    .maybeSingle();
  if (error) throw fromEngineError(error, "Quote");
  if (!data?.price_request) throw new DomainError("NOT_FOUND", "Quote not found.");
  if (data.status !== "draft") {
    throw new DomainError("INVALID_STATE", "Only draft quotes can be re-priced.");
  }
  return repriceDraft(
    db,
    systemGateway(),
    getDistanceProvider(),
    ctx.user.id,
    ctx.organizationId,
    id,
    priceRequestSchema.parse(data.price_request),
  );
}

const STAFF_TARGETS = ["sent", "accepted", "declined", "cancelled", "draft"] as const;

/** Status change; the database validates the transition, review sign-off and expiry. */
export async function transitionQuote(id: string, to: string) {
  const ctx = await requireStaff("quotes.write");
  const target = z.enum(STAFF_TARGETS).parse(to) satisfies QuoteStatus;
  const db = await createUserClient();
  const { data, error } = await db
    .from("quotes")
    .update({ status: target })
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id))
    .select("id");
  if (error) throw fromEngineError(error, "Quote");
  if (data.length === 0) throw new DomainError("NOT_FOUND", "Quote not found.");
}

/** Staff sign-off for a price flagged for manual review (e.g. tax verified by hand). */
export async function approveQuoteReview(id: string, note: string) {
  const ctx = await requireStaff("quotes.write");
  const reviewNote = z.string().trim().min(3).max(1000).parse(note);
  const db = await createUserClient();
  const { data, error } = await db
    .from("quotes")
    .update({ review_approved_at: new Date().toISOString(), review_note: reviewNote })
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id))
    .eq("manual_review_required", true)
    .select("id");
  if (error) throw fromEngineError(error, "Quote");
  if (data.length === 0) throw new DomainError("INVALID_STATE", "This quote needs no review.");
}

/**
 * Creates (or replaces) the customer's link. The token is returned once; only its hash is stored,
 * so creating a new link invalidates the previous one.
 */
export async function createQuoteLink(id: string) {
  const ctx = await requireStaff("quotes.write");
  const token = generateQuoteToken();
  const db = await createUserClient();
  const { data, error } = await db
    .from("quotes")
    .update({ token_hash: await hashQuoteToken(token) })
    .eq("organization_id", ctx.organizationId)
    .eq("id", z.uuid().parse(id))
    .select("id");
  if (error) throw fromEngineError(error, "Quote");
  if (data.length === 0) throw new DomainError("NOT_FOUND", "Quote not found.");
  const domain = await db
    .from("organization_domains")
    .select("hostname")
    .eq("organization_id", ctx.organizationId)
    .eq("is_primary", true)
    .maybeSingle();
  const path = `/q/${token}`;
  return { path, url: domain.data ? `https://${domain.data.hostname}${path}` : null };
}
