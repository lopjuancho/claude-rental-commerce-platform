import { createHash } from "node:crypto";
import type { DistanceCache, DistanceProvider } from "@/domain/delivery/provider";
import { METERS_PER_MILE } from "@/domain/delivery/mileage";
import { quoteDelivery } from "@/domain/delivery/quote";
import {
  areaContextSchema,
  assemblePricingInput,
  deliveryConfig,
  type PriceRequest,
  priceRequestSchema,
  pricingContextSchema,
  taxContextSchema,
  taxLocation,
} from "@/domain/pricing/context";
import { calculatePrice, canonicalJson } from "@/domain/pricing/engine";
import type { PriceResult, PricingInput } from "@/domain/pricing/types";
import { rpc } from "./availability";
import type { Actor, TestOrg } from "./db";

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

/** DistanceCache over the real get/put_cached_distance functions, called as `actor`. */
export function dbCache(actor: Actor, org: TestOrg): DistanceCache {
  return {
    get: async (k) =>
      (
        await rpc<{ m: number | null }>(
          actor,
          "select public.get_cached_distance($1, $2, $3, $4) as m",
          [org.id, k.provider, k.version, k.routeKey],
        )
      )[0]!.m,
    put: async (k, meters) => {
      await rpc(actor, "select public.put_cached_distance($1, $2, $3, $4, $5)", [
        org.id,
        k.provider,
        k.version,
        k.routeKey,
        Math.round(meters),
      ]);
    },
  };
}

export async function price(
  actor: Actor,
  org: TestOrg,
  raw: unknown,
  opts: { provider?: DistanceProvider | null; channel?: "staff" | "public" } = {},
): Promise<{ input: PricingInput; output: PriceResult }> {
  const request: PriceRequest = priceRequestSchema.parse(raw);
  const [ctxRow] = await rpc<{ c: unknown }>(actor, "select public.pricing_context($1, $2) as c", [
    org.id,
    request.items.map((i) => i.variantId),
  ]);
  const context = pricingContextSchema.parse(ctxRow!.c);
  const area = request.eventAddress
    ? areaContextSchema.parse(
        (
          await rpc<{ a: unknown }>(
            actor,
            "select public.delivery_area_context($1, $2, $3, $4) as a",
            [
              org.id,
              request.eventAddress.city,
              request.eventAddress.state,
              request.eventAddress.postalCode,
            ],
          )
        )[0]!.a,
      )
    : { areasConfigured: false, match: null };
  const delivery = await quoteDelivery({
    destination: request.eventAddress,
    config: deliveryConfig(context),
    area,
    provider: opts.provider === undefined ? fakeProvider(8.2) : opts.provider,
    cache: dbCache(actor, org),
    currency: context.organization.currency,
  });
  const loc = taxLocation(context, request);
  const tax = loc
    ? taxContextSchema.parse(
        (
          await rpc<{ t: unknown }>(actor, "select public.tax_context($1, $2, $3, $4) as t", [
            org.id,
            loc.state,
            loc.postalCode,
            request.items[0]!.start.slice(0, 10),
          ])
        )[0]!.t,
      )
    : ({ status: "unresolved" } as const);
  const input = assemblePricingInput({
    context,
    request,
    delivery,
    tax,
    channel: opts.channel ?? "staff",
  });
  return { input, output: calculatePrice(input) };
}

export async function record(
  actor: Actor,
  org: TestOrg,
  input: PricingInput,
  output: PriceResult,
): Promise<string> {
  const [row] = await rpc<{ id: string }>(
    actor,
    "select public.record_pricing_calculation($1, $2, $3, $4, $5) as id",
    [
      org.id,
      output.engineVersion,
      JSON.stringify(input),
      JSON.stringify(output),
      await sha256(canonicalJson(input)),
    ],
  );
  return row!.id;
}
