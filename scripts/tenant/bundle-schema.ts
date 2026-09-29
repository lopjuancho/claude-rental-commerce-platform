import { z } from "zod";

/**
 * Tenant configuration bundle: everything needed to onboard a rental company as DATA
 * (ADR 0003). Tiky Jumps is onboarded with the same format any future tenant uses.
 * Catalog products arrive separately through the CSV import (ADR 0011).
 */
const slug = z
  .string()
  .regex(/^[a-z0-9](-?[a-z0-9])*$/)
  .max(120);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optional = <T extends z.ZodType>(t: T) => t.nullish();

// Mirrors public.weather_hazard / threshold units (src/domain/weather/hazards.ts).
const hazardRule = z
  .object({
    hazard: z.enum(["wind", "lightning", "rain", "severe_weather", "temperature", "custom"]),
    sensitive: z.boolean(),
    thresholdValue: optional(z.number().positive().max(9999)),
    thresholdUnit: optional(z.enum(["mph", "kph", "fahrenheit", "celsius", "inches_per_hour"])),
  })
  .refine((r) => (r.thresholdValue == null) === (r.thresholdUnit == null), {
    message: "threshold needs value and unit",
  });

export const POLICY_TYPES = [
  "weather",
  "wind_safety",
  "cancellation",
  "overnight",
  "delivery",
  "setup_requirements",
  "power_requirements",
  "water_requirements",
  "supervision",
  "operator_requirements",
  "deposit",
  "safety",
  "other",
] as const;

export const tenantBundleSchema = z.object({
  organization: z.object({
    slug: slug.max(63),
    name: z.string().min(1).max(200),
    legalName: optional(z.string().max(200)),
    timezone: z.string().min(1),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .default("US"),
    status: z.enum(["onboarding", "active"]).default("onboarding"),
  }),
  ownerEmail: optional(z.email()),
  domains: z
    .array(
      z.object({
        hostname: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/),
        primary: z.boolean().default(false),
      }),
    )
    .default([]),
  settings: z
    .object({
      primaryColor: optional(color),
      secondaryColor: optional(color),
      accentColor: optional(color),
      contactPhone: optional(z.string().max(40)),
      smsPhone: optional(z.string().max(40)),
      contactEmail: optional(z.email()),
      websiteUrl: optional(z.url()),
      defaultSetupBufferMinutes: optional(z.int().min(0).max(1440)),
      defaultTeardownBufferMinutes: optional(z.int().min(0).max(1440)),
      defaultRentalDurationMinutes: optional(z.int().positive()),
      minBookingLeadTimeMinutes: optional(z.int().min(0)),
      overnightAllowed: optional(z.boolean()),
      quoteValidDays: optional(z.int().min(1).max(365)),
      bookingHoldMinutes: optional(z.int().min(1).max(1440)),
      multiDayBilling: optional(z.enum(["rolling_24h", "calendar_days"])),
      primaryDepot: optional(
        z.object({
          addressLine1: z.string().max(200),
          city: z.string().max(120),
          state: z.string().max(40),
          postalCode: z.string().max(20),
        }),
      ),
      mileage: optional(
        z.object({
          freeMiles: z.number().min(0).max(1000),
          perMileRateCents: z.int().min(0).max(100000),
          maximumMiles: optional(z.number().positive().max(5000)),
          rounding: z
            .enum(["ceil_whole_mile", "round_whole_mile", "none"])
            .default("ceil_whole_mile"),
          basis: z.enum(["one_way", "round_trip"]).default("one_way"),
        }),
      ),
    })
    .default({}),
  categories: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        slug,
        sortOrder: z.int().default(0),
        includedDurationMinutes: optional(z.int().positive()),
        setupBufferMinutes: optional(z.int().min(0).max(1440)),
        teardownBufferMinutes: optional(z.int().min(0).max(1440)),
        overnightAllowed: optional(z.boolean()),
        weather: z.array(hazardRule).default([]),
      }),
    )
    .default([]),
  /** Pricing rules (ADR 0013), upserted by name. Scope by category slug; none = organization-wide. */
  pricingRules: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        type: z.enum([
          "extra_hour",
          "overnight",
          "additional_day",
          "attendant_fee",
          "fee",
          "discount_percent",
          "discount_fixed",
          "minimum_charge",
        ]),
        categorySlug: optional(slug),
        params: z.record(z.string(), z.unknown()),
        priority: z.int().default(0),
        active: z.boolean().default(true),
      }),
    )
    .default([]),
  /** Organization-level hazard defaults (least specific level). */
  weatherRules: z.array(hazardRule).default([]),
  policies: z
    .array(
      z
        .object({
          type: z.enum(POLICY_TYPES),
          title: z.string().min(1).max(200),
          body: z.string().min(1).max(20000),
          published: z.boolean().default(false),
          /** Placeholder wording: inserted only if the tenant has no policy of this type; never published. */
          placeholder: z.boolean().default(false),
        })
        .refine((p) => !(p.placeholder && p.published), {
          message: "placeholder policies cannot be published",
        }),
    )
    .default([]),
});

export type TenantBundle = z.infer<typeof tenantBundleSchema>;
