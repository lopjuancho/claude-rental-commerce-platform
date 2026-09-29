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
