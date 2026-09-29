import { formatCents } from "@/domain/money";
import type { DeliveryResult } from "@/domain/pricing/types";
import { normalizeAddress, type PostalAddress } from "./address";
import { mileageFee, type MileageSettings } from "./mileage";
import type { DistanceCache, DistanceProvider } from "./provider";

export interface DeliveryConfig {
  depot: PostalAddress | null;
  freeMiles: number | null;
  perMileRateCents: number | null;
  maximumMiles: number | null;
  rounding: MileageSettings["rounding"];
  basis: MileageSettings["basis"];
}

export interface AreaContext {
  areasConfigured: boolean;
  match: {
    id: string;
    revision: number;
    name: string;
    pricing: "flat" | "mileage" | "manual_review";
    flatFeeCents: number | null;
  } | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const routeKey = (origin: PostalAddress, destination: PostalAddress) =>
  sha256Hex(`${normalizeAddress(origin)}|${normalizeAddress(destination)}`);

/**
 * Delivery price for an event address (ADR 0009). Service areas decide WHERE delivery is offered;
 * mileage settings decide HOW MUCH. Anything uncertain is manual review — never a guessed fee.
 */
export async function quoteDelivery(args: {
  destination: PostalAddress | null;
  config: DeliveryConfig;
  area: AreaContext;
  provider: DistanceProvider | null;
  cache: DistanceCache | null;
  currency: string;
}): Promise<DeliveryResult> {
  const { destination, config, area } = args;
  if (!destination) return { status: "not_requested" };

  if (area.areasConfigured && !area.match)
    return { status: "manual_review", reason: "OUTSIDE_SERVICE_AREA" };
  if (area.match?.pricing === "manual_review")
    return { status: "manual_review", reason: "SERVICE_AREA_REQUIRES_REVIEW" };
  if (area.match?.pricing === "flat" && area.match.flatFeeCents !== null) {
    return {
      status: "priced",
      method: "flat",
      feeCents: area.match.flatFeeCents,
      label: `Delivery (${area.match.name})`,
      distanceMiles: null,
      billableMiles: null,
      serviceAreaId: area.match.id,
      serviceAreaRevision: area.match.revision,
      provider: null,
    };
  }

  // Mileage pricing.
  if (config.freeMiles === null || config.perMileRateCents === null)
    return { status: "manual_review", reason: "MILEAGE_NOT_CONFIGURED" };
  if (!config.depot) return { status: "manual_review", reason: "DEPOT_NOT_CONFIGURED" };
  if (!args.provider)
    return { status: "manual_review", reason: "DISTANCE_PROVIDER_NOT_CONFIGURED" };

  const key = {
    provider: args.provider.id,
    version: args.provider.version,
    routeKey: await routeKey(config.depot, destination),
  };
  let meters = args.cache ? await args.cache.get(key).catch(() => null) : null;
  if (meters === null) {
    let result;
    try {
      result = await args.provider.getRoadDistance(config.depot, destination);
    } catch {
      result = { ok: false as const, reason: "PROVIDER_ERROR" as const };
    }
    if (!result.ok) return { status: "manual_review", reason: result.reason };
    meters = result.meters;
    // A cache failure must never block pricing.
    await args.cache?.put(key, meters).catch(() => undefined);
  }

  const fee = mileageFee(meters, {
    freeMiles: config.freeMiles,
    perMileRateCents: config.perMileRateCents,
    maximumMiles: config.maximumMiles,
    rounding: config.rounding,
    basis: config.basis,
  });
  if (fee.status === "manual_review") return { status: "manual_review", reason: fee.reason };
  const rate = formatCents(config.perMileRateCents, args.currency);
  const label =
    fee.billableMiles === 0
      ? `Delivery (${fee.distanceMiles} mi, within ${config.freeMiles} free miles)`
      : `Delivery (${fee.distanceMiles} mi${config.basis === "round_trip" ? " each way" : ""}: ${fee.billableMiles} billable mi × ${rate})`;
  return {
    status: "priced",
    method: "mileage",
    feeCents: fee.feeCents,
    label,
    distanceMiles: fee.distanceMiles,
    billableMiles: fee.billableMiles,
    serviceAreaId: area.match?.id ?? null,
    serviceAreaRevision: area.match?.revision ?? null,
    provider: args.provider.id,
  };
}
