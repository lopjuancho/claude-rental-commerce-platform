/** Engine contract. All money is integer cents; all instants are ISO strings; nothing is implicit. */
export const ENGINE_VERSION = "pricing-2026.09.30-1";

/**
 * How a rental period becomes billable days (organization setting, ADR 0013).
 * - rolling_24h: ceil(duration / 24 h). Fri 17:00 → Sun 12:00 (43 h) = 2 days.
 * - calendar_days: every local calendar date touched counts. Fri 17:00 → Sun 12:00 = 3 days.
 *   A rental crossing midnight is then a second day, so the overnight rule never applies.
 */
export const MULTI_DAY_BILLING_STRATEGIES = ["rolling_24h", "calendar_days"] as const;
export type MultiDayBillingStrategy = (typeof MULTI_DAY_BILLING_STRATEGIES)[number];

export const TAX_COMPONENTS = [
  "rental",
  "add_on",
  "delivery",
  "labor",
  "fee",
  "discount",
  "adjustment",
] as const;
export type TaxComponent = (typeof TAX_COMPONENTS)[number];

export const PRICING_RULE_TYPES = [
  "extra_hour",
  "overnight",
  "additional_day",
  "attendant_fee",
  "fee",
  "discount_percent",
  "discount_fixed",
  "minimum_charge",
] as const;
export type PricingRuleType = (typeof PRICING_RULE_TYPES)[number];

export interface PricingRule {
  id: string;
  revision: number;
  name: string;
  type: PricingRuleType;
  categoryId: string | null;
  productId: string | null;
  variantId: string | null;
  params: Record<string, unknown>;
  priority: number;
  discountCode: string | null;
  validFrom: string | null; // YYYY-MM-DD
  validTo: string | null;
}

export interface PricingItem {
  lineId: string;
  variantId: string;
  productId: string;
  name: string;
  primaryCategoryId: string | null;
  categoryIds: string[];
  /** 'add_on' items are priced like rentals but reported (and taxed) as add-ons. */
  kind: "rental" | "add_on";
  quantity: number;
  basePriceCents: number;
  includedDurationMinutes: number;
  overnightAllowed: boolean;
  attendantsRequired: number;
  active: boolean;
  start: string;
  end: string;
}

export type DeliveryResult =
  | { status: "not_requested" }
  | {
      status: "priced";
      method: "flat" | "mileage";
      feeCents: number;
      label: string;
      distanceMiles: number | null;
      billableMiles: number | null;
      serviceAreaId: string | null;
      serviceAreaRevision: number | null;
      provider: string | null;
    }
  | { status: "manual_review"; reason: string };

export type TaxContext =
  | { status: "unresolved" }
  | {
      status: "resolved";
      jurisdiction: {
        id: string;
        revision: number;
        name: string;
        status: "test" | "active";
        boundaryReview: boolean;
      };
      rates: { id: string; name: string; rateBps: number }[];
      taxability: Partial<Record<TaxComponent, boolean>>;
    };

export interface ManualAdjustment {
  label: string;
  amountCents: number; // signed
  /** Why staff adjusted the price, and who (user id from the verified session). Snapshots made
   *  before these fields existed omit them; the engine never reads them. */
  reason?: string;
  authorizedBy?: string | null;
}

export interface PricingInput {
  currency: string;
  timeZone: string;
  /** Absent in snapshots made before the setting existed; those used rolling_24h. */
  multiDayBilling?: MultiDayBillingStrategy;
  items: PricingItem[];
  rules: PricingRule[];
  discountCodes: string[];
  delivery: DeliveryResult;
  tax: TaxContext;
  adjustments: ManualAdjustment[];
}

export type PriceLineKind =
  | "base"
  | "extra_hours"
  | "overnight"
  | "additional_days"
  | "labor"
  | "fee"
  | "discount"
  | "minimum_charge"
  | "delivery"
  | "adjustment";

export interface PriceLine {
  kind: PriceLineKind;
  label: string;
  lineId: string | null;
  quantity: number;
  amountCents: number;
  component: TaxComponent;
  taxable: boolean | null;
  ruleId: string | null;
  ruleRevision: number | null;
}

export interface TaxLine {
  rateId: string;
  name: string;
  rateBps: number;
  taxableBaseCents: number;
  amountCents: number;
}

export interface PriceSummary {
  base: number;
  extra_hours: number;
  overnight: number;
  additional_days: number;
  quantity: number;
  add_ons: number;
  labor: number;
  fees: number;
  delivery: number;
  discounts: number;
  adjustments: number;
  subtotal: number;
  taxable_subtotal: number;
  tax: number;
  total: number;
  manual_review_required: boolean;
}

export interface PriceResult {
  engineVersion: string;
  currency: string;
  lines: PriceLine[];
  taxLines: TaxLine[];
  summary: PriceSummary;
  manualReviewRequired: boolean;
  /** Machine-readable reasons, e.g. OVERNIGHT_PRICING_NOT_CONFIGURED, DELIVERY:PROVIDER_ERROR. */
  reviewReasons: string[];
  warnings: string[];
  appliedRules: { id: string; revision: number; type: PricingRuleType; name: string }[];
  tax: { jurisdictionId: string; revision: number; name: string; status: "test" | "active" } | null;
  delivery: DeliveryResult;
}
