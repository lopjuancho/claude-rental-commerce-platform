import { formatCents } from "@/domain/money";
import { humanize, type Product } from "./catalog";

/**
 * What the storefront may say about a product's price and specifications — only configured facts.
 */

export interface PriceSummary {
  /** Always "From": the quote adds delivery, tax and options to the starting price. */
  prefix: "From";
  /** e.g. "$175" */
  amount: string;
  /** e.g. "per event", "per hour", "per day", "each" */
  unit: string;
  /** e.g. "up to 4 hours" (from the configured included duration) */
  detail: string | null;
  /** Bookable variants start from different prices. */
  varies: boolean;
  /** Always shown next to the price: the quote is the only final price. */
  qualifier: string;
}

const UNIT: Record<string, string> = {
  per_event: "per event",
  hourly: "per hour",
  daily: "per day",
  per_unit: "each",
};

export const PRICE_QUALIFIER =
  "Starting price. Delivery, tax and options are calculated in your quote.";

function duration(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/**
 * The price the storefront may advertise: the lowest starting price of the product's bookable
 * variants as the pricing engine uses it, or null when there is none to state (never a guess).
 */
export function priceSummary(product: Product, currency: string): PriceSummary | null {
  if (product.startingPriceCents === null || !product.pricingType) return null;
  const included =
    product.pricingType === "per_event" && product.includedDurationMinutes
      ? `up to ${duration(product.includedDurationMinutes)}`
      : null;
  return {
    prefix: "From",
    amount: formatCents(product.startingPriceCents, currency).replace(/\.00$/, ""),
    unit: UNIT[product.pricingType] ?? "",
    detail: included,
    varies: product.priceVaries,
    qualifier: PRICE_QUALIFIER,
  };
}

export interface Spec {
  label: string;
  value: string;
}
export interface SpecGroup {
  title: string;
  specs: Spec[];
}

const yes = (b: boolean | null) => b === true;
const listOf = (xs: string[] | null) =>
  (xs ?? [])
    .filter((x) => x.trim() !== "")
    .map(humanize)
    .join(", ");

/** Specification groups built strictly from configured columns; empty groups are dropped. */
export function specGroups(product: Product): SpecGroup[] {
  const r = product.row;
  const groups: SpecGroup[] = [];
  const push = (title: string, specs: (Spec | null)[]) => {
    const kept = specs.filter((s): s is Spec => s !== null && s.value !== "");
    if (kept.length) groups.push({ title, specs: kept });
  };

  const modes = [
    yes(r.wet_allowed) ? "Wet (with water)" : null,
    yes(r.dry_allowed) ? "Dry" : null,
  ].filter(Boolean);
  const ages =
    r.minimum_age !== null && r.maximum_age !== null
      ? `${r.minimum_age}–${r.maximum_age} years`
      : r.minimum_age !== null
        ? `${r.minimum_age}+ years`
        : r.maximum_age !== null
          ? `Up to ${r.maximum_age} years`
          : null;
  push("Use", [
    modes.length ? { label: "Use", value: modes.join(" or ") } : null,
    ages ? { label: "Ages", value: ages } : null,
    r.recommended_capacity !== null
      ? { label: "Capacity", value: `Up to ${r.recommended_capacity} at a time` }
      : null,
    r.max_rider_weight_lbs !== null
      ? { label: "Max rider weight", value: `${r.max_rider_weight_lbs} lb` }
      : null,
    r.indoor_allowed !== null || r.outdoor_allowed !== null
      ? {
          label: "Setting",
          value: [
            yes(r.indoor_allowed) ? "Indoor" : null,
            yes(r.outdoor_allowed) ? "Outdoor" : null,
          ]
            .filter(Boolean)
            .join(" or "),
        }
      : null,
  ]);

  const dims = [r.space_length_ft, r.space_width_ft, r.space_height_ft];
  push("Space & setup", [
    dims.every((d) => d !== null)
      ? { label: "Space needed", value: `${dims[0]} ft L × ${dims[1]} ft W × ${dims[2]} ft H` }
      : dims[0] !== null && dims[1] !== null
        ? { label: "Space needed", value: `${dims[0]} ft × ${dims[1]} ft` }
        : null,
    r.allowed_surfaces?.length ? { label: "Surfaces", value: listOf(r.allowed_surfaces) } : null,
    r.anchoring_methods?.length ? { label: "Anchoring", value: listOf(r.anchoring_methods) } : null,
    r.power_outlets_required !== null && r.power_outlets_required > 0
      ? {
          label: "Power",
          value: `${r.power_outlets_required} outlet${r.power_outlets_required === 1 ? "" : "s"}${r.power_notes ? ` (${r.power_notes})` : ""}`,
        }
      : r.power_notes
        ? { label: "Power", value: r.power_notes }
        : null,
    yes(r.water_required) ? { label: "Water", value: "Garden hose access required" } : null,
    r.setup_requirements ? { label: "Setup", value: r.setup_requirements } : null,
  ]);

  push("Staffing", [
    yes(r.operator_required) ? { label: "Operator", value: "Operated by our staff" } : null,
    r.attendants_required !== null && r.attendants_required > 0
      ? {
          label: "Attendants",
          value: `${r.attendants_required} adult attendant${r.attendants_required === 1 ? "" : "s"} required`,
        }
      : null,
  ]);

  const extra =
    r.extra_specs && typeof r.extra_specs === "object" && !Array.isArray(r.extra_specs)
      ? Object.entries(r.extra_specs as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string" || typeof v === "number")
          .map(([k, v]) => ({ label: humanize(k), value: String(v) }))
      : [];
  push("Details", extra);
  return groups;
}

export interface WeatherNote {
  hazard: string;
  text: string;
}

/** Configured weather sensitivities ("May not operate in wind over 20 mph"). */
export function weatherNotes(product: Product): WeatherNote[] {
  const raw = product.row.weather_sensitivities;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((w: unknown) => {
    if (!w || typeof w !== "object") return [];
    const { hazard, threshold_value, threshold_unit } = w as Record<string, unknown>;
    if (typeof hazard !== "string") return [];
    const threshold =
      typeof threshold_value === "number" && typeof threshold_unit === "string"
        ? ` over ${threshold_value} ${threshold_unit}`
        : "";
    return [
      {
        hazard,
        text: `Weather-sensitive: may not operate in ${humanize(hazard).toLowerCase()}${threshold}.`,
      },
    ];
  });
}
