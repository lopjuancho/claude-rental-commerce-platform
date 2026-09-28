import { z } from "zod";
import {
  ANCHORING_METHODS,
  EVENT_TYPES,
  PRICING_TYPES,
  SURFACES,
  TRACKING_MODES,
} from "./vocabulary";

/**
 * Canonical catalog input schemas. The admin UI and every import adapter validate against these,
 * so there is exactly one definition of a valid product (ADR 0011). Database CHECK constraints
 * enforce the same rules again.
 */
const slug = z
  .string()
  .max(160)
  .regex(/^[a-z0-9](-?[a-z0-9])*$/, "Use lower-case letters, numbers and single hyphens.");
const minutes = z.int().min(0).max(1440);
const optionalText = (max: number) => z.string().trim().max(max).nullish();
const feet = z.number().positive().max(9999);

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug,
  description: optionalText(5000),
  parentId: z.uuid().nullish(),
  sortOrder: z.int().default(0),
  isPublished: z.boolean().default(true),
  setupBufferMinutes: minutes.nullish(),
  teardownBufferMinutes: minutes.nullish(),
  includedDurationMinutes: z.int().positive().max(20160).nullish(),
  overnightAllowed: z.boolean().nullish(),
  windSensitive: z.boolean().nullish(),
  windThresholdMph: z.int().positive().max(200).nullish(),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const productInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    slug,
    shortDescription: optionalText(300),
    description: optionalText(20000),
    primaryCategoryId: z.uuid().nullish(),
    categoryIds: z.array(z.uuid()).max(20).default([]),
    isPublished: z.boolean().default(false),
    isFeatured: z.boolean().default(false),
    sortOrder: z.int().default(0),
    pricingType: z.enum(PRICING_TYPES).default("per_event"),
    basePriceCents: z.int().min(0).max(100_000_000),
    includedDurationMinutes: z.int().positive().max(20160).nullish(),
    minimumRentalMinutes: z.int().positive().max(20160).nullish(),
    setupBufferMinutes: minutes.nullish(),
    teardownBufferMinutes: minutes.nullish(),
    minBookingLeadTimeMinutes: z.int().min(0).max(525600).nullish(),
    overnightAllowed: z.boolean().nullish(),
    windSensitive: z.boolean().nullish(),
    windThresholdMph: z.int().positive().max(200).nullish(),
    wetAllowed: z.boolean().default(false),
    dryAllowed: z.boolean().default(true),
    minimumAge: z.int().min(0).max(120).nullish(),
    maximumAge: z.int().min(0).max(120).nullish(),
    recommendedCapacity: z.int().positive().max(10000).nullish(),
    maxRiderWeightLbs: z.int().positive().max(2000).nullish(),
    idealEventTypes: z.array(z.enum(EVENT_TYPES)).max(EVENT_TYPES.length).default([]),
    indoorAllowed: z.boolean().default(false),
    outdoorAllowed: z.boolean().default(true),
    allowedSurfaces: z.array(z.enum(SURFACES)).default([]),
    spaceLengthFt: feet.nullish(),
    spaceWidthFt: feet.nullish(),
    spaceHeightFt: feet.nullish(),
    powerOutletsRequired: z.int().min(0).max(50).nullish(),
    powerNotes: optionalText(500),
    waterRequired: z.boolean().default(false),
    operatorRequired: z.boolean().default(false),
    attendantsRequired: z.int().min(0).max(20).default(0),
    setupMinutes: minutes.nullish(),
    teardownMinutes: minutes.nullish(),
    setupRequirements: optionalText(2000),
    anchoringMethods: z.array(z.enum(ANCHORING_METHODS)).default([]),
    tags: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).default([]),
    internalNotes: optionalText(5000),
  })
  .superRefine((p, ctx) => {
    if (!p.wetAllowed && !p.dryAllowed) {
      ctx.addIssue({
        code: "custom",
        path: ["dryAllowed"],
        message: "A product must allow wet or dry use.",
      });
    }
    if (!p.indoorAllowed && !p.outdoorAllowed) {
      ctx.addIssue({
        code: "custom",
        path: ["outdoorAllowed"],
        message: "A product must allow indoor or outdoor use.",
      });
    }
    if (p.minimumAge != null && p.maximumAge != null && p.maximumAge < p.minimumAge) {
      ctx.addIssue({
        code: "custom",
        path: ["maximumAge"],
        message: "Maximum age must be at least the minimum age.",
      });
    }
    if (p.primaryCategoryId && !p.categoryIds.includes(p.primaryCategoryId)) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryCategoryId"],
        message: "Primary category must be one of the product's categories.",
      });
    }
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const variantInventoryInputSchema = z.discriminatedUnion("trackingMode", [
  z.object({ trackingMode: z.literal(TRACKING_MODES[0]) }),
  z.object({
    trackingMode: z.literal(TRACKING_MODES[1]),
    pooledQuantity: z.int().min(0).max(1_000_000),
  }),
]);
export type VariantInventoryInput = z.infer<typeof variantInventoryInputSchema>;
