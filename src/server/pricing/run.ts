import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
import { DatabaseDistanceCache } from "@/server/delivery/cache";
import { getDistanceProvider } from "@/server/delivery/provider";
import type { Database, Json } from "@/types/database";

export interface PricingRun {
  input: PricingInput;
  output: PriceResult;
  calculationId: string | null;
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
 * server-resolved tenant — never from request input.
 */
export async function runPricing(
  db: SupabaseClient<Database>,
  organizationId: string,
  request: PriceRequest,
  opts: { channel: "staff" | "public"; save: boolean },
): Promise<PricingRun> {
  const ctxRes = await db.rpc("pricing_context", {
    p_organization_id: organizationId,
    p_variant_ids: [...new Set(request.items.map((i) => i.variantId))],
  });
  if (ctxRes.error) throw fromEngineError(ctxRes.error, "Pricing");
  const context = pricingContextSchema.parse(ctxRes.data);

  const destination = request.eventAddress;
  let area = { areasConfigured: false, match: null } as ReturnType<typeof areaContextSchema.parse>;
  if (destination) {
    const res = await db.rpc("delivery_area_context", {
      p_organization_id: organizationId,
      p_city: destination.city,
      p_state: destination.state,
      p_postal_code: destination.postalCode,
    });
    if (res.error) throw fromEngineError(res.error, "Delivery");
    area = areaContextSchema.parse(res.data);
  }

  const delivery = await quoteDelivery({
    destination,
    config: deliveryConfig(context),
    area,
    provider: getDistanceProvider(),
    cache: new DatabaseDistanceCache(db, organizationId),
    currency: context.organization.currency,
  });

  const location = taxLocation(context, request);
  const firstStart = request.items[0]?.start;
  let tax = taxContextSchema.parse({ status: "unresolved" });
  if (location && firstStart) {
    const res = await db.rpc("tax_context", {
      p_organization_id: organizationId,
      p_state: location.state,
      p_postal_code: location.postalCode,
      p_on: localDate(firstStart, context.organization.timezone),
    });
    if (res.error) throw fromEngineError(res.error, "Tax");
    tax = taxContextSchema.parse(res.data);
  }

  const input = assemblePricingInput({ context, request, delivery, tax, channel: opts.channel });
  const output = calculatePrice(input);

  let calculationId: string | null = null;
  if (opts.save) {
    const { data, error } = await db.rpc("record_pricing_calculation", {
      p_organization_id: organizationId,
      p_engine_version: output.engineVersion,
      p_input: input as unknown as Json,
      p_output: output as unknown as Json,
      p_input_hash: await sha256Hex(canonicalJson(input)),
    });
    if (error) throw fromEngineError(error, "Pricing");
    calculationId = data;
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
  return {
    inputIntact: (await sha256Hex(canonicalJson(input))) === data.input_hash,
    sameEngineVersion: recomputed.engineVersion === data.engine_version,
    reproducible: canonicalJson(recomputed) === canonicalJson(data.output),
  };
}
