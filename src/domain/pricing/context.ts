import { z } from "zod";
import { postalAddressSchema } from "@/domain/delivery/address";
import type { AreaContext, DeliveryConfig } from "@/domain/delivery/quote";
import { DomainError } from "@/domain/errors";
import {
  PRICING_RULE_TYPES,
  TAX_COMPONENTS,
  type DeliveryResult,
  type PricingInput,
  type TaxContext,
} from "./types";

/**
 * Bridges database context (public.pricing_context / tax_context / delivery_area_context) and a
 * validated pricing request into an engine input. Pure: every I/O result is passed in.
 */
const isoInstant = z.iso.datetime({ offset: true });

export const priceRequestSchema = z.object({
  items: z
    .array(
      z.object({
        variantId: z.uuid(),
        quantity: z.int().min(1).max(1000),
        kind: z.enum(["rental", "add_on"]).default("rental"),
        start: isoInstant,
        end: isoInstant,
      }),
    )
    .min(1)
    .max(50),
  /** Event/service location. Null = customer pickup (no delivery; tax uses the depot location). */
  eventAddress: postalAddressSchema.nullable(),
  discountCodes: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
  adjustments: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        amountCents: z.int().min(-100_000_000).max(100_000_000),
      }),
    )
    .max(10)
    .default([]),
});
export type PriceRequest = z.infer<typeof priceRequestSchema>;

export const pricingContextSchema = z.object({
  organization: z.object({
    id: z.uuid(),
    currency: z.string().length(3),
    timezone: z.string(),
    status: z.string(),
  }),
  delivery: z.object({
    depot: postalAddressSchema.nullable(),
    freeMiles: z.number().nullable(),
    perMileRateCents: z.number().nullable(),
    maximumMiles: z.number().nullable(),
    rounding: z.enum(["ceil_whole_mile", "round_whole_mile", "none"]),
    basis: z.enum(["one_way", "round_trip"]),
  }),
  variants: z.array(
    z.object({
      variantId: z.uuid(),
      productId: z.uuid(),
      name: z.string(),
      primaryCategoryId: z.uuid().nullable(),
      categoryIds: z.array(z.uuid()),
      basePriceCents: z.number().int(),
      includedDurationMinutes: z.number().int(),
      overnightAllowed: z.boolean(),
      attendantsRequired: z.number().int(),
      published: z.boolean(),
      active: z.boolean(),
    }),
  ),
  rules: z.array(
    z.object({
      id: z.uuid(),
      revision: z.number().int(),
      name: z.string(),
      type: z.enum(PRICING_RULE_TYPES),
      categoryId: z.uuid().nullable(),
      productId: z.uuid().nullable(),
      variantId: z.uuid().nullable(),
      params: z.record(z.string(), z.unknown()),
      priority: z.number().int(),
      discountCode: z.string().nullable(),
      validFrom: z.string().nullable(),
      validTo: z.string().nullable(),
    }),
  ),
});
export type PricingContext = z.infer<typeof pricingContextSchema>;

export const taxContextSchema: z.ZodType<TaxContext> = z.union([
  z.object({ status: z.literal("unresolved") }),
  z.object({
    status: z.literal("resolved"),
    jurisdiction: z.object({
      id: z.uuid(),
      revision: z.number().int(),
      name: z.string(),
      status: z.enum(["test", "active"]),
      boundaryReview: z.boolean(),
    }),
    rates: z.array(z.object({ id: z.uuid(), name: z.string(), rateBps: z.number().int() })),
    taxability: z.partialRecord(z.enum(TAX_COMPONENTS), z.boolean()),
  }),
]);

export const areaContextSchema: z.ZodType<AreaContext> = z.object({
  areasConfigured: z.boolean(),
  match: z
    .object({
      id: z.uuid(),
      revision: z.number().int(),
      name: z.string(),
      pricing: z.enum(["flat", "mileage", "manual_review"]),
      flatFeeCents: z.number().int().nullable(),
    })
    .nullable(),
});

export function deliveryConfig(ctx: PricingContext): DeliveryConfig {
  return { ...ctx.delivery };
}

/** Where tax is determined: the event address, or the depot for customer pickup. */
export function taxLocation(ctx: PricingContext, request: PriceRequest) {
  return request.eventAddress ?? ctx.delivery.depot;
}

export function assemblePricingInput(args: {
  context: PricingContext;
  request: PriceRequest;
  delivery: DeliveryResult;
  tax: TaxContext;
  /** Public/assistant callers may only price published products and cannot add adjustments. */
  channel: "staff" | "public";
}): PricingInput {
  const { context, request } = args;
  const byId = new Map(context.variants.map((v) => [v.variantId, v]));
  const items = request.items.map((it, index) => {
    const v = byId.get(it.variantId);
    if (!v || (args.channel === "public" && !v.published))
      throw new DomainError("NOT_FOUND", "Product not found.");
    return {
      lineId: `L${index + 1}`,
      variantId: v.variantId,
      productId: v.productId,
      name: v.name,
      primaryCategoryId: v.primaryCategoryId,
      categoryIds: v.categoryIds,
      kind: it.kind,
      quantity: it.quantity,
      basePriceCents: v.basePriceCents,
      includedDurationMinutes: v.includedDurationMinutes,
      overnightAllowed: v.overnightAllowed,
      attendantsRequired: v.attendantsRequired,
      active: v.active,
      start: new Date(it.start).toISOString(),
      end: new Date(it.end).toISOString(),
    };
  });
  if (args.channel === "public" && request.adjustments.length > 0)
    throw new DomainError("FORBIDDEN");
  return {
    currency: context.organization.currency,
    timeZone: context.organization.timezone,
    items,
    rules: context.rules,
    discountCodes: request.discountCodes,
    delivery: args.delivery,
    tax: args.tax,
    adjustments: request.adjustments,
  };
}
