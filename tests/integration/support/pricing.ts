import { createHash } from "node:crypto";
import type { PostgrestError } from "@supabase/supabase-js";
import type { DistanceProvider } from "@/domain/delivery/provider";
import { METERS_PER_MILE } from "@/domain/delivery/mileage";
import { priceRequestSchema } from "@/domain/pricing/context";
import { canonicalJson } from "@/domain/pricing/engine";
import type { PriceResult, PricingInput } from "@/domain/pricing/types";
import { fromEngineError } from "@/server/availability/errors";
import { runPricing, type PricingSource } from "@/server/pricing/run";
import { GatewayError, type TrustedGateway } from "@/server/trusted/gateway";
import { rpc, SYSTEM } from "./availability";
import { admin, type Actor, type TestOrg } from "./db";

export function sha256(text: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(text).digest("hex"));
}

export function fakeProvider(miles: number): DistanceProvider & { calls: number } {
  const p = {
    id: "fake",
    version: "1",
    calls: 0,
    getRoadDistance: () => {
      p.calls++;
      return Promise.resolve({ ok: true as const, meters: miles * METERS_PER_MILE });
    },
  };
  return p;
}

const asPostgrest = (e: unknown): PostgrestError => {
  const err = e as { code?: string; message?: string; detail?: string };
  return {
    name: "PostgrestError",
    code: err.code ?? "",
    message: err.message ?? "",
    details: err.detail ?? "",
    hint: "",
  } as PostgrestError;
};

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

async function one<T>(actor: Actor, sql: string, params: unknown[]): Promise<T> {
  const rows = await rpc<{ v: T }>(actor, sql, params);
  return rows[0]!.v;
}

/**
 * The production TrustedGateway contract, implemented with the same SQL functions executed as
 * `service_role` (what supabase-js does with the service key). Every call is recorded.
 */
export function pgGateway(): TrustedGateway & { calls: string[] } {
  const calls: string[] = [];
  const svc = async <T>(name: string, sql: string, params: unknown[]): Promise<T> => {
    calls.push(name);
    try {
      return await one<T>(SYSTEM, sql, params);
    } catch (e) {
      throw new GatewayError(asPostgrest(e));
    }
  };
  return {
    calls,
    pricingContext: (org, ids) =>
      svc("pricing_context", "select public.pricing_context($1, $2) as v", [org, ids]),
    deliveryAreaContext: (org, city, state, zip) =>
      svc("delivery_area_context", "select public.delivery_area_context($1, $2, $3, $4) as v", [
        org,
        city,
        state,
        zip,
      ]),
    taxContext: (org, state, zip, on) =>
      svc("tax_context", "select public.tax_context($1, $2, $3, $4) as v", [org, state, zip, on]),
    getCachedDistance: (org, k) =>
      svc("get_cached_distance", "select public.get_cached_distance($1, $2, $3, $4) as v", [
        org,
        k.provider,
        k.version,
        k.routeKey,
      ]),
    putCachedDistance: async (org, k, meters) => {
      await svc(
        "put_cached_distance",
        "select public.put_cached_distance($1, $2, $3, $4, $5)::text as v",
        [org, k.provider, k.version, k.routeKey, Math.round(meters)],
      );
    },
    recordCalculation: (org, c, actor) =>
      svc(
        "record_pricing_calculation",
        "select public.record_pricing_calculation($1, $2, $3, $4, $5, $6, $7) as v",
        [
          org,
          c.engineVersion,
          JSON.stringify(c.input),
          JSON.stringify(c.output),
          c.inputHash,
          actor.type,
          actor.type === "user" ? actor.userId : null,
        ],
      ),
    matchOrCreateCustomer: (org, contact) =>
      svc("match_or_create_customer", "select public.match_or_create_customer($1, $2) as v", [
        org,
        JSON.stringify(contact),
      ]),
    createEvent: async (org, customerId, event) => {
      const v = await svc<{ event_id: string; starts_at: Date | null; ends_at: Date | null }>(
        "create_event",
        "select row_to_json(e) as v from public.create_event($1, $2, $3) e",
        [org, customerId, JSON.stringify(event)],
      );
      return { eventId: v.event_id, startsAt: iso(v.starts_at), endsAt: iso(v.ends_at) };
    },
    createQuote: async (org, q) => {
      const v = await svc<{ quote_id: string; quote_number: string }>(
        "create_quote",
        "select row_to_json(q) as v from public.create_quote($1, $2, $3, $4, $5, $6, $7, $8, null, $9) q",
        [
          org,
          q.customerId,
          q.eventId,
          q.calculationId,
          JSON.stringify(q.priceRequest),
          q.source,
          q.tokenHash,
          q.customerNotes,
          JSON.stringify(q.submittedContact),
        ],
      );
      return { quoteId: v.quote_id, quoteNumber: v.quote_number };
    },
    publicQuoteView: (org, hash) =>
      svc("public_quote_view", "select public.public_quote_view($1, $2) as v", [org, hash]),
    requestBookingByToken: async (org, hash, source, message) => {
      const v = await svc<{
        booking_request_id: string;
        reservation_id: string;
        hold_expires_at: string;
        quote_number: string;
      }>(
        "request_booking_by_token",
        "select row_to_json(b) as v from public.request_booking_by_token($1, $2, $3, $4) b",
        [org, hash, source, message],
      );
      return {
        bookingRequestId: v.booking_request_id,
        reservationId: v.reservation_id,
        holdExpiresAt: v.hold_expires_at,
        quoteNumber: v.quote_number,
      };
    },
    renewBookingHoldByToken: async (org, hash) =>
      iso(
        await svc<Date>(
          "renew_booking_hold_by_token",
          "select public.renew_booking_hold_by_token($1, $2) as v",
          [org, hash],
        ),
      ) ?? "",
    cancelBookingByToken: (org, hash) =>
      svc("cancel_booking_by_token", "select public.cancel_booking_by_token($1, $2) as v", [
        org,
        hash,
      ]),
    recordAudit: async (org, e) => {
      calls.push("audit");
      await admin(
        `insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, changes, request_id, ip_address, user_agent, actor_user_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          org,
          e.actor,
          e.action,
          e.entityType,
          e.entityId ?? null,
          e.metadata === undefined ? null : JSON.stringify(e.metadata),
          e.requestId ?? null,
          e.ipAddress ?? null,
          e.userAgent ?? null,
          e.actor === "user" ? (e.actorUserId ?? null) : null,
        ],
      );
    },
  };
}

/** Staff reads as the given actor (their RLS/permissions apply), like userPricingSource. */
export function pgSource(actor: Actor, org: TestOrg): PricingSource {
  const call = async <T>(sql: string, params: unknown[]) => {
    try {
      return await one<T>(actor, sql, params);
    } catch (e) {
      throw fromEngineError(asPostgrest(e), "Pricing");
    }
  };
  return {
    pricingContext: (ids) => call("select public.pricing_context($1, $2) as v", [org.id, ids]),
    deliveryAreaContext: (city, state, zip) =>
      call("select public.delivery_area_context($1, $2, $3, $4) as v", [org.id, city, state, zip]),
    taxContext: (state, zip, on) =>
      call("select public.tax_context($1, $2, $3, $4) as v", [org.id, state, zip, on]),
  };
}

/**
 * Runs the REAL server pipeline (runPricing) for a staff member or the system context.
 * `save` persists through the trusted gateway exactly like production.
 */
export async function price(
  actor: Actor,
  org: TestOrg,
  raw: unknown,
  opts: {
    provider?: DistanceProvider | null;
    channel?: "staff" | "public";
    save?: boolean;
    gateway?: TrustedGateway;
  } = {},
): Promise<{ input: PricingInput; output: PriceResult; calculationId: string | null }> {
  return runPricing(
    {
      source: pgSource(actor, org),
      gateway: opts.gateway ?? pgGateway(),
      provider: opts.provider === undefined ? fakeProvider(8.2) : opts.provider,
      actor: actor.kind === "user" ? { type: "user", userId: actor.id } : { type: "system" },
    },
    org.id,
    priceRequestSchema.parse(raw),
    { channel: opts.channel ?? "staff", save: opts.save ?? false },
  );
}

/** Calls record_pricing_calculation directly as `actor` — what an attacker would try. */
export async function record(
  actor: Actor,
  org: TestOrg,
  input: PricingInput,
  output: PriceResult,
): Promise<string> {
  const [row] = await rpc<{ id: string }>(
    actor,
    "select public.record_pricing_calculation($1, $2, $3, $4, $5, $6, $7) as id",
    [
      org.id,
      output.engineVersion,
      JSON.stringify(input),
      JSON.stringify(output),
      await sha256(canonicalJson(input)),
      actor.kind === "user" ? "user" : "system",
      actor.kind === "user" ? actor.id : null,
    ],
  );
  return row!.id;
}
