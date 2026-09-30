import "server-only";
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { DistanceCache, DistanceProvider } from "@/domain/delivery/provider";
import { quoteDelivery } from "@/domain/delivery/quote";
import { DomainError } from "@/domain/errors";
import {
  areaContextSchema,
  assemblePricingInput,
  deliveryConfig,
  type PriceRequest,
  pricingContextSchema,
  taxContextSchema,
  taxLocation,
} from "@/domain/pricing/context";
import { calculatePrice, canonicalJson } from "@/domain/pricing/engine";
import type { PriceResult, PricingInput } from "@/domain/pricing/types";
import { fromEngineError } from "@/server/availability/errors";
import { GatewayError, type CalculationActor, type TrustedGateway } from "@/server/trusted/gateway";
import type { Database } from "@/types/database";

export interface PricingRun {
  input: PricingInput;
  output: PriceResult;
  calculationId: string | null;
}

/** Read-only pricing data for one organization, fetched under the caller's own authority. */
export interface PricingSource {
  pricingContext(variantIds: string[]): Promise<unknown>;
  deliveryAreaContext(city: string, state: string, postalCode: string): Promise<unknown>;
  taxContext(state: string, postalCode: string, on: string): Promise<unknown>;
}

/**
 * Pricing dependencies. Reads come from `source`; every write (distance cache, calculation
 * snapshot) goes through the trusted gateway, so no client — not even staff — can store a
 * distance or a calculation the server did not compute (hardening H2/H3).
 */
export interface PricingDeps {
  source: PricingSource;
  gateway: TrustedGateway;
  provider: DistanceProvider | null;
  /** Who the snapshot is attributed to; from the verified session or the resolved tenant. */
  actor: CalculationActor;
}

/** Staff reads through their own RLS-scoped client (their permissions apply). */
export function userPricingSource(
  db: SupabaseClient<Database>,
  organizationId: string,
): PricingSource {
  const unwrap = <T>(res: { data: T; error: PostgrestError | null }, what: string): T => {
    if (res.error) throw fromEngineError(res.error, what);
    return res.data;
  };
  return {
    pricingContext: async (variantIds) =>
      unwrap(
        await db.rpc("pricing_context", {
          p_organization_id: organizationId,
          p_variant_ids: variantIds,
        }),
        "Pricing",
      ),
    deliveryAreaContext: async (city, state, postalCode) =>
      unwrap(
        await db.rpc("delivery_area_context", {
          p_organization_id: organizationId,
          p_city: city,
          p_state: state,
          p_postal_code: postalCode,
        }),
        "Delivery",
      ),
    taxContext: async (state, postalCode, on) =>
      unwrap(
        await db.rpc("tax_context", {
          p_organization_id: organizationId,
          p_state: state,
          p_postal_code: postalCode,
          p_on: on,
        }),
        "Tax",
      ),
  };
}

/** Public/assistant reads through the gateway, pinned to the server-resolved tenant. */
export function gatewayPricingSource(
  gateway: TrustedGateway,
  organizationId: string,
): PricingSource {
  return {
    pricingContext: (variantIds) => mapped(gateway.pricingContext(organizationId, variantIds)),
    deliveryAreaContext: (city, state, postalCode) =>
      mapped(gateway.deliveryAreaContext(organizationId, city, state, postalCode)),
    taxContext: (state, postalCode, on) =>
      mapped(gateway.taxContext(organizationId, state, postalCode, on)),
  };
}

async function mapped<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GatewayError) throw fromEngineError(e.db, "Pricing");
    throw e;
  }
}

/** Distance cache reads/writes through the trusted gateway (shared with the service-area check). */
export function gatewayCache(gateway: TrustedGateway, organizationId: string): DistanceCache {
  return {
    get: (key) => gateway.getCachedDistance(organizationId, key),
    put: (key, meters) => gateway.putCachedDistance(organizationId, key, meters),
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const localDate = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));

/**
 * Loads everything from the database, resolves delivery and tax, runs the engine, and (optionally)
 * stores an immutable snapshot. The organization id must come from a verified staff context or a
 * server-resolved tenant — never from request input. The request carries only what a customer or
 * staff member chooses (items, times, address, codes, adjusted amounts with reasons); prices,
 * rules, tax, delivery and the engine version are all determined here.
 */
export async function runPricing(
  deps: PricingDeps,
  organizationId: string,
  request: PriceRequest,
  opts: { channel: "staff" | "public"; save: boolean },
): Promise<PricingRun> {
  const context = pricingContextSchema.parse(
    await deps.source.pricingContext([...new Set(request.items.map((i) => i.variantId))]),
  );

  const destination = request.eventAddress;
  let area = { areasConfigured: false, match: null } as ReturnType<typeof areaContextSchema.parse>;
  if (destination) {
    area = areaContextSchema.parse(
      await deps.source.deliveryAreaContext(
        destination.city,
        destination.state,
        destination.postalCode,
      ),
    );
  }

  const delivery = await quoteDelivery({
    destination,
    config: deliveryConfig(context),
    area,
    provider: deps.provider,
    cache: gatewayCache(deps.gateway, organizationId),
    currency: context.organization.currency,
  });

  const location = taxLocation(context, request);
  const firstStart = request.items[0]?.start;
  let tax = taxContextSchema.parse({ status: "unresolved" });
  if (location && firstStart) {
    tax = taxContextSchema.parse(
      await deps.source.taxContext(
        location.state,
        location.postalCode,
        localDate(firstStart, context.organization.timezone),
      ),
    );
  }

  const input = assemblePricingInput({
    context,
    request,
    delivery,
    tax,
    channel: opts.channel,
    adjustmentsAuthorizedBy: deps.actor.type === "user" ? deps.actor.userId : null,
  });
  const output = calculatePrice(input);

  let calculationId: string | null = null;
  if (opts.save) {
    try {
      calculationId = await deps.gateway.recordCalculation(
        organizationId,
        {
          engineVersion: output.engineVersion,
          input,
          output,
          inputHash: await sha256Hex(canonicalJson(input)),
        },
        deps.actor,
      );
      // Manual adjustments are recorded explicitly: who, how much, and why (hardening H2).
      if (input.adjustments.length > 0 && deps.actor.type === "user") {
        await deps.gateway.recordAudit(organizationId, {
          actor: "user",
          actorUserId: deps.actor.userId,
          action: "pricing.adjusted",
          entityType: "pricing_calculation",
          entityId: calculationId,
          metadata: {
            adjustments: input.adjustments.map((a) => ({
              label: a.label,
              amountCents: a.amountCents,
              reason: a.reason ?? null,
            })),
            totalCents: output.summary.total,
          },
        });
      }
    } catch (e) {
      if (e instanceof GatewayError) throw fromEngineError(e.db, "Pricing");
      throw e;
    }
  }
  return { input, output, calculationId };
}

/** Recomputes a stored calculation from its stored input and checks it is byte-for-byte identical. */
export async function verifyStoredCalculation(
  db: SupabaseClient<Database>,
  organizationId: string,
  id: string,
) {
  const { data, error } = await db
    .from("pricing_calculations")
    .select("input, output, input_hash, engine_version")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromEngineError(error, "Pricing");
  if (!data) throw new DomainError("NOT_FOUND", "Calculation not found.");
  const input = data.input as unknown as PricingInput;
  const recomputed = calculatePrice(input);
  // A newer engine must reproduce older snapshots exactly; only its version label differs.
  const comparable = { ...recomputed, engineVersion: data.engine_version };
  return {
    inputIntact: (await sha256Hex(canonicalJson(input))) === data.input_hash,
    sameEngineVersion: recomputed.engineVersion === data.engine_version,
    reproducible: canonicalJson(comparable) === canonicalJson(data.output),
  };
}
