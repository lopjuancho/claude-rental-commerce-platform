/** Engine contract. All money is integer cents; all instants are ISO strings; nothing is implicit. */
export const ENGINE_VERSION = "pricing-2026.09.29-1";

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
}

export interface PricingInput {
  currency: string;
  timeZone: string;
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
