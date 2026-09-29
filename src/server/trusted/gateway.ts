import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { createSystemClient } from "@/server/db/system";
import type { Json } from "@/types/database";

/**
 * EVERY service-role (RLS-bypassing) operation in the application, as an explicit method
 * (ADR 0001, hardening H5). There is no generic table access: each method is one allow-listed
 * SQL function or the audit insert, and every organization id passed in must come from a
 * server-resolved tenant or a verified staff context — never from request input.
 *
 * Production uses supabase-js with the service-role key; integration tests use the same SQL
 * functions through `service_role` (tests/integration/support/gateway.ts). A static test
 * (tests/unit/service-role-inventory.test.ts) fails if the service-role client is used anywhere
 * else or if this file reaches beyond the listed functions.
 */
export interface DistanceKey {
  provider: string;
  version: string;
  routeKey: string;
}

export type CalculationActor =
  { type: "user"; userId: string } | { type: "public" } | { type: "ai" } | { type: "system" };

export interface TrustedCalculation {
  engineVersion: string;
  input: unknown;
  output: unknown;
  inputHash: string;
}

export interface TrustedAuditEvent {
  actor: "user" | "public" | "ai" | "system";
  /** Required for actor 'user': the verified session's user id (never from input). */
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Json;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface EventWindow {
  eventId: string;
  startsAt: string | null;
  endsAt: string | null;
}

export interface NewQuote {
  customerId: string;
  eventId: string;
  calculationId: string;
  priceRequest: unknown;
  source: "web" | "assistant";
  tokenHash: string;
  customerNotes: string | null;
}

export interface BookingHold {
  bookingRequestId: string;
  reservationId: string;
  holdExpiresAt: string;
  quoteNumber: string;
}

export interface TrustedGateway {
  pricingContext(organizationId: string, variantIds: string[]): Promise<unknown>;
  deliveryAreaContext(
    organizationId: string,
    city: string,
    state: string,
    postalCode: string,
  ): Promise<unknown>;
  taxContext(
    organizationId: string,
    state: string,
    postalCode: string,
    on: string,
  ): Promise<unknown>;
  getCachedDistance(organizationId: string, key: DistanceKey): Promise<number | null>;
  putCachedDistance(organizationId: string, key: DistanceKey, meters: number): Promise<void>;
  recordCalculation(
    organizationId: string,
    calc: TrustedCalculation,
    actor: CalculationActor,
  ): Promise<string>;
  recordAudit(organizationId: string, event: TrustedAuditEvent): Promise<void>;
  // ── M5 public quote / booking flow (ADR 0015) ──
  matchOrCreateCustomer(organizationId: string, contact: Record<string, unknown>): Promise<string>;
  createEvent(
    organizationId: string,
    customerId: string,
    event: Record<string, unknown>,
  ): Promise<EventWindow>;
  createQuote(
    organizationId: string,
    quote: NewQuote,
  ): Promise<{ quoteId: string; quoteNumber: string }>;
  publicQuoteView(organizationId: string, tokenHash: string): Promise<unknown>;
  requestBookingByToken(
    organizationId: string,
    tokenHash: string,
    source: "web" | "assistant",
    message: string | null,
  ): Promise<BookingHold>;
  renewBookingHoldByToken(organizationId: string, tokenHash: string): Promise<string>;
  cancelBookingByToken(organizationId: string, tokenHash: string): Promise<string>;
}

/** Error carrying the database SQLSTATE, so callers map it like any other engine error. */
export class GatewayError extends Error {
  constructor(readonly db: PostgrestError) {
    super(db.message);
  }
}

function unwrap<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw new GatewayError(res.error);
  return res.data;
}

function present<T>(value: T | null | undefined, fn: string): T {
  if (value === null || value === undefined) throw new Error(`${fn} returned nothing`);
  return value;
}

export function systemGateway(): TrustedGateway {
  const db = createSystemClient();
  return {
    async pricingContext(organizationId, variantIds) {
      return unwrap(
        await db.rpc("pricing_context", {
          p_organization_id: organizationId,
          p_variant_ids: variantIds,
        }),
      );
    },
    async deliveryAreaContext(organizationId, city, state, postalCode) {
      return unwrap(
        await db.rpc("delivery_area_context", {
          p_organization_id: organizationId,
          p_city: city,
          p_state: state,
          p_postal_code: postalCode,
        }),
      );
    },
    async taxContext(organizationId, state, postalCode, on) {
      return unwrap(
        await db.rpc("tax_context", {
          p_organization_id: organizationId,
          p_state: state,
          p_postal_code: postalCode,
          p_on: on,
        }),
      );
    },
    async getCachedDistance(organizationId, key) {
      return unwrap(
        await db.rpc("get_cached_distance", {
          p_organization_id: organizationId,
          p_provider: key.provider,
          p_provider_version: key.version,
          p_route_key: key.routeKey,
        }),
      );
    },
    async putCachedDistance(organizationId, key, meters) {
      unwrap(
        await db.rpc("put_cached_distance", {
          p_organization_id: organizationId,
          p_provider: key.provider,
          p_provider_version: key.version,
          p_route_key: key.routeKey,
          p_meters: Math.round(meters),
          p_ttl_days: 30,
        }),
      );
    },
    async recordCalculation(organizationId, calc, actor) {
      const id = unwrap(
        await db.rpc("record_pricing_calculation", {
          p_organization_id: organizationId,
          p_engine_version: calc.engineVersion,
          p_input: calc.input as Json,
          p_output: calc.output as Json,
          p_input_hash: calc.inputHash,
          p_created_by_type: actor.type,
          ...(actor.type === "user" ? { p_created_by: actor.userId } : {}),
        }),
      );
      if (!id) throw new Error("record_pricing_calculation returned no id");
      return id;
    },
    async matchOrCreateCustomer(organizationId, contact) {
      return present(
        unwrap(
          await db.rpc("match_or_create_customer", {
            p_organization_id: organizationId,
            p_customer: contact as Json,
          }),
        ),
        "match_or_create_customer",
      );
    },
    async createEvent(organizationId, customerId, event) {
      const [row] = present(
        unwrap(
          await db.rpc("create_event", {
            p_organization_id: organizationId,
            p_customer_id: customerId,
            p_event: event as Json,
          }),
        ),
        "create_event",
      );
      if (!row) throw new Error("create_event returned no row");
      return { eventId: row.event_id, startsAt: row.starts_at, endsAt: row.ends_at };
    },
    async createQuote(organizationId, q) {
      const [row] = present(
        unwrap(
          await db.rpc("create_quote", {
            p_organization_id: organizationId,
            p_customer_id: q.customerId,
            p_event_id: q.eventId,
            p_calculation_id: q.calculationId,
            p_price_request: q.priceRequest as Json,
            p_source: q.source,
            p_token_hash: q.tokenHash,
            ...(q.customerNotes ? { p_customer_notes: q.customerNotes } : {}),
          }),
        ),
        "create_quote",
      );
      if (!row) throw new Error("create_quote returned no row");
      return { quoteId: row.quote_id, quoteNumber: row.quote_number };
    },
    async publicQuoteView(organizationId, tokenHash) {
      return unwrap(
        await db.rpc("public_quote_view", {
          p_organization_id: organizationId,
          p_token_hash: tokenHash,
        }),
      );
    },
    async requestBookingByToken(organizationId, tokenHash, source, message) {
      const [row] = present(
        unwrap(
          await db.rpc("request_booking_by_token", {
            p_organization_id: organizationId,
            p_token_hash: tokenHash,
            p_source: source,
            ...(message ? { p_message: message } : {}),
          }),
        ),
        "request_booking_by_token",
      );
      if (!row) throw new Error("request_booking_by_token returned no row");
      return {
        bookingRequestId: row.booking_request_id,
        reservationId: row.reservation_id,
        holdExpiresAt: row.hold_expires_at,
        quoteNumber: row.quote_number,
      };
    },
    async renewBookingHoldByToken(organizationId, tokenHash) {
      return present(
        unwrap(
          await db.rpc("renew_booking_hold_by_token", {
            p_organization_id: organizationId,
            p_token_hash: tokenHash,
          }),
        ),
        "renew_booking_hold_by_token",
      );
    },
    async cancelBookingByToken(organizationId, tokenHash) {
      return present(
        unwrap(
          await db.rpc("cancel_booking_by_token", {
            p_organization_id: organizationId,
            p_token_hash: tokenHash,
          }),
        ),
        "cancel_booking_by_token",
      );
    },
    async recordAudit(organizationId, event) {
      unwrap(
        await db.from("audit_logs").insert({
          organization_id: organizationId,
          actor_type: event.actor,
          actor_user_id: event.actor === "user" ? (event.actorUserId ?? null) : null,
          action: event.action,
          entity_type: event.entityType,
          entity_id: event.entityId ?? null,
          changes: event.metadata ?? null,
          request_id: event.requestId ?? null,
          ip_address: event.ipAddress ?? null,
          user_agent: event.userAgent?.slice(0, 500) ?? null,
        }),
      );
    },
  };
}
