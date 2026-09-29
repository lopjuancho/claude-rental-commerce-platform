import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DistanceProvider } from "@/domain/delivery/provider";
import { DomainError } from "@/domain/errors";
import { priceRequestSchema, type PriceRequest } from "@/domain/pricing/context";
import { eventRow, quotePriceRequest, type EventInput } from "@/domain/quotes/schemas";
import { fromEngineError } from "@/server/availability/errors";
import {
  runPricing,
  userPricingSource,
  type PricingRun,
  type PricingSource,
} from "@/server/pricing/run";
import type { CalculationActor, TrustedGateway } from "@/server/trusted/gateway";
import type { Database, Json } from "@/types/database";

type Db = SupabaseClient<Database>;

/** Postgres returns "+00" offsets; the pricing request requires full ISO instants. */
export function eventWindow(row: {
  eventId: string;
  startsAt: string | null;
  endsAt: string | null;
}) {
  if (!row.startsAt || !row.endsAt) {
    throw new DomainError("INVALID_INPUT", "The event needs a date, start time and end time.");
  }
  return {
    eventId: row.eventId,
    startsAt: new Date(row.startsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
  };
}

export function buildPriceRequest(args: Parameters<typeof quotePriceRequest>[0]): PriceRequest {
  return priceRequestSchema.parse(quotePriceRequest(args));
}

/** Pricing for a quote: reads under the caller's authority, snapshot stored by trusted code. */
export async function priceQuote(
  deps: {
    source: PricingSource;
    gateway: TrustedGateway;
    provider: DistanceProvider | null;
    actor: CalculationActor;
  },
  organizationId: string,
  request: PriceRequest,
  channel: "staff" | "public",
): Promise<PricingRun & { calculationId: string }> {
  const run = await runPricing(deps, organizationId, request, { channel, save: true });
  if (!run.calculationId) throw new DomainError("INTERNAL");
  return { ...run, calculationId: run.calculationId };
}

// ── staff helpers (RLS-scoped user client) ──────────────────────────────────

export async function staffCreateEvent(
  db: Db,
  organizationId: string,
  customerId: string,
  event: EventInput,
) {
  const { data, error } = await db.rpc("create_event", {
    p_organization_id: organizationId,
    p_customer_id: customerId,
    p_event: eventRow(event) as Json,
  });
  if (error) throw fromEngineError(error, "Event");
  const row = data[0];
  if (!row) throw new DomainError("INTERNAL");
  return eventWindow({ eventId: row.event_id, startsAt: row.starts_at, endsAt: row.ends_at });
}

export async function staffUpdateEvent(
  db: Db,
  organizationId: string,
  eventId: string,
  customerId: string,
  event: EventInput,
) {
  // The event belongs to the quote's customer (booking-critical, ADR 0015 §15): kept in step.
  const { data, error } = await db
    .from("events")
    .update({ ...eventRow(event), customer_id: customerId })
    .eq("organization_id", organizationId)
    .eq("id", eventId)
    .select("id, starts_at, ends_at")
    .single();
  if (error) throw fromEngineError(error, "Event");
  return eventWindow({ eventId: data.id, startsAt: data.starts_at, endsAt: data.ends_at });
}

export async function staffCreateQuote(
  db: Db,
  organizationId: string,
  args: {
    customerId: string;
    eventId: string;
    request: PriceRequest;
    calculationId: string;
    customerNotes: string | null;
    internalNotes: string | null;
  },
) {
  const { data, error } = await db.rpc("create_quote", {
    p_organization_id: organizationId,
    p_customer_id: args.customerId,
    p_event_id: args.eventId,
    p_calculation_id: args.calculationId,
    p_price_request: args.request as unknown as Json,
    p_source: "admin",
    ...(args.customerNotes ? { p_customer_notes: args.customerNotes } : {}),
    ...(args.internalNotes ? { p_internal_notes: args.internalNotes } : {}),
  });
  if (error) throw fromEngineError(error, "Quote");
  const row = data[0];
  if (!row) throw new DomainError("INTERNAL");
  return { quoteId: row.quote_id, quoteNumber: row.quote_number };
}

/** Re-prices a draft with current rules (a new snapshot; the old one stays for the audit trail). */
export async function repriceDraft(
  db: Db,
  gateway: TrustedGateway,
  provider: DistanceProvider | null,
  userId: string,
  organizationId: string,
  quoteId: string,
  request: PriceRequest,
): Promise<PricingRun> {
  const run = await priceQuote(
    {
      source: userPricingSource(db, organizationId),
      gateway,
      provider,
      actor: { type: "user", userId },
    },
    organizationId,
    request,
    "staff",
  );
  const { error, data } = await db
    .from("quotes")
    .update({
      price_request: request,
      pricing_calculation_id: run.calculationId,
    })
    .eq("organization_id", organizationId)
    .eq("id", quoteId)
    .select("id");
  if (error) throw fromEngineError(error, "Quote");
  if (data.length === 0) throw new DomainError("NOT_FOUND", "Quote not found.");
  return run;
}
