import { slugify } from "@/domain/catalog/slug";
import { EVENT_TYPES, type EventType } from "@/domain/catalog/vocabulary";
import { IMPORT_FIELDS, IMPORT_FIELD_KEYS, type FieldMapping, type ImportFieldKey } from "./fields";
import {
  blank,
  CellError,
  toBoolean,
  toCents,
  toDecimal,
  toDimensions,
  toInteger,
  toList,
} from "./transforms";

/**
 * Canonical product row as written by the database function commit_product_import.
 * Keys are product column names; only fields present in the source are included, so a
 * re-import never clears values that the file doesn't mention.
 */
export interface MappedProduct {
  external_ref?: string;
  name: string;
  slug: string;
  short_description?: string;
  description?: string;
  base_price_cents: number;
  included_duration_minutes?: number;
  categories?: { slug: string; name: string }[];
  quantity?: number;
  tracking_mode?: "serialized" | "pooled";
  is_published?: boolean;
  wet_allowed?: boolean;
  dry_allowed?: boolean;
  minimum_age?: number;
  maximum_age?: number;
  recommended_capacity?: number;
  max_rider_weight_lbs?: number;
  space_length_ft?: number;
  space_width_ft?: number;
  space_height_ft?: number;
  power_outlets_required?: number;
  power_notes?: string;
  water_required?: boolean;
  operator_required?: boolean;
  attendants_required?: number;
  setup_minutes?: number;
  teardown_minutes?: number;
  setup_requirements?: string;
  indoor_allowed?: boolean;
  outdoor_allowed?: boolean;
  wind_sensitive?: boolean;
  ideal_event_types?: EventType[];
  tags?: string[];
  internal_notes?: string;
}

export interface RowIssue {
  field: ImportFieldKey | "row";
  message: string;
}

export interface ValidatedRow {
  rowNumber: number;
  mapped: MappedProduct | null;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export function missingRequiredFields(mapping: FieldMapping): ImportFieldKey[] {
  return IMPORT_FIELD_KEYS.filter((k) => "required" in IMPORT_FIELDS[k] && !mapping[k]);
}

const TEXT_LIMITS: Partial<Record<ImportFieldKey, number>> = {
  external_ref: 200,
  name: 200,
  short_description: 300,
  description: 20000,
  power_notes: 500,
  setup_requirements: 2000,
  internal_notes: 5000,
};

function matchEventType(label: string): EventType | null {
  const v = label.toLowerCase();
  return EVENT_TYPES.find((t) => v === t || v.startsWith(t) || v.includes(t)) ?? null;
}

/** Converts one source row into a canonical product using the mapping. Pure. */
export function validateRow(
  headers: readonly string[],
  cells: readonly string[],
  mapping: FieldMapping,
  rowNumber: number,
): ValidatedRow {
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const column = new Map(headers.map((h, i) => [h, i]));
  const cell = (field: ImportFieldKey): string | undefined => {
    const header = mapping[field];
    if (!header) return undefined;
    const idx = column.get(header);
    return idx === undefined ? undefined : cells[idx];
  };
  const out: Partial<MappedProduct> = {};

  const read = <T>(field: ImportFieldKey, parse: (v: string | undefined) => T | null): T | null => {
    try {
      return parse(cell(field));
    } catch (e) {
      errors.push({ field, message: e instanceof CellError ? e.message : "Invalid value." });
      return null;
    }
  };
  const text = (field: ImportFieldKey): string | null => {
    const v = cell(field);
    if (blank(v)) return null;
    const max = TEXT_LIMITS[field] ?? 2000;
    if (v.length > max) {
      errors.push({ field, message: `Longer than ${max} characters.` });
      return null;
    }
    return v.trim();
  };
  const set = <K extends keyof MappedProduct>(key: K, value: MappedProduct[K] | null) => {
    if (value !== null && value !== undefined) out[key] = value;
  };
  const range = (field: ImportFieldKey, value: number | null, min: number, max: number) => {
    if (value === null) return null;
    if (value < min || value > max) {
      errors.push({ field, message: `Must be between ${min} and ${max}.` });
      return null;
    }
    return value;
  };

  const name = text("name");
  if (!name) errors.push({ field: "name", message: "Name is required." });
  const price = read("base_price", toCents);
  if (price === null && !errors.some((e) => e.field === "base_price")) {
    errors.push({ field: "base_price", message: "Price is required." });
  }

  const explicitSlug = text("slug");
  const slug = explicitSlug ? slugify(explicitSlug) : name ? slugify(name) : "";
  if (name && !slug)
    errors.push({ field: "slug", message: "Could not derive a URL slug from the name." });

  set("external_ref", text("external_ref"));
  set("short_description", text("short_description"));
  set("description", text("description"));
  set("power_notes", text("power_notes"));
  set("setup_requirements", text("setup_requirements"));
  set("internal_notes", text("internal_notes"));

  const hours = range("included_hours", read("included_hours", toDecimal), 0.25, 336);
  if (hours !== null) set("included_duration_minutes", Math.round(hours * 60));

  const categories = read("category", toList);
  if (categories) {
    const cats = categories
      .map((c) => ({ name: c.slice(0, 120), slug: slugify(c) }))
      .filter((c) => c.slug.length > 0);
    set("categories", cats.slice(0, 20));
  }

  set("quantity", range("quantity", read("quantity", toInteger), 0, 1_000_000));
  const tracking = text("tracking_mode")?.toLowerCase();
  if (tracking) {
    if (tracking === "serialized" || tracking === "pooled") set("tracking_mode", tracking);
    else errors.push({ field: "tracking_mode", message: 'Use "serialized" or "pooled".' });
  }

  for (const f of [
    "is_published",
    "wet_allowed",
    "dry_allowed",
    "water_required",
    "operator_required",
    "indoor_allowed",
    "outdoor_allowed",
    "wind_sensitive",
  ] as const) {
    set(f, read(f, toBoolean));
  }

  set("minimum_age", range("minimum_age", read("minimum_age", toInteger), 0, 120));
  set("maximum_age", range("maximum_age", read("maximum_age", toInteger), 0, 120));
  set(
    "recommended_capacity",
    range("recommended_capacity", read("recommended_capacity", toInteger), 1, 10000),
  );
  set(
    "max_rider_weight_lbs",
    range("max_rider_weight_lbs", read("max_rider_weight_lbs", toInteger), 1, 2000),
  );
  set(
    "power_outlets_required",
    range("power_outlets_required", read("power_outlets_required", toInteger), 0, 50),
  );
  set(
    "attendants_required",
    range("attendants_required", read("attendants_required", toInteger), 0, 20),
  );
  set("setup_minutes", range("setup_minutes", read("setup_minutes", toInteger), 0, 1440));
  set("teardown_minutes", range("teardown_minutes", read("teardown_minutes", toInteger), 0, 1440));

  const dims = read("dimensions", toDimensions);
  if (dims) {
    set("space_length_ft", dims.length);
    set("space_width_ft", dims.width);
    set("space_height_ft", dims.height);
  }
  // Explicit columns win over a combined "dimensions" column.
  set("space_length_ft", range("space_length_ft", read("space_length_ft", toDecimal), 0.1, 9999));
  set("space_width_ft", range("space_width_ft", read("space_width_ft", toDecimal), 0.1, 9999));
  set("space_height_ft", range("space_height_ft", read("space_height_ft", toDecimal), 0.1, 9999));

  const eventLabels = read("event_types", toList);
  if (eventLabels) {
    const types = new Set<EventType>();
    for (const label of eventLabels) {
      const t = matchEventType(label);
      if (t) types.add(t);
      else
        warnings.push({
          field: "event_types",
          message: `Unknown event type "${label}" was ignored.`,
        });
    }
    set("ideal_event_types", [...types]);
  }
  const tags = read("tags", toList);
  if (tags) set("tags", [...new Set(tags.map((t) => t.toLowerCase().slice(0, 40)))].slice(0, 30));

  // Cross-field rules (checked when the file provides both sides).
  if (
    out.minimum_age !== undefined &&
    out.maximum_age !== undefined &&
    out.maximum_age < out.minimum_age
  ) {
    errors.push({ field: "maximum_age", message: "Maximum age is below the minimum age." });
  }
  if (out.wet_allowed === false && out.dry_allowed === false) {
    errors.push({ field: "dry_allowed", message: "A product must allow wet or dry use." });
  }
  if (out.indoor_allowed === false && out.outdoor_allowed === false) {
    errors.push({
      field: "outdoor_allowed",
      message: "A product must allow indoor or outdoor use.",
    });
  }
  if (out.tracking_mode === "pooled" && out.quantity === undefined) {
    warnings.push({
      field: "quantity",
      message: "Pooled item without a quantity; it will start at 0.",
    });
  }

  if (errors.length > 0 || !name || price === null)
    return { rowNumber, mapped: null, errors, warnings };
  return {
    rowNumber,
    mapped: { ...out, name, slug, base_price_cents: price },
    errors,
    warnings,
  };
}
