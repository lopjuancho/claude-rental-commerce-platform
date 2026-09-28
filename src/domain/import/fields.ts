/**
 * Canonical import fields: what a source column can be mapped TO. These are product-model
 * concepts, never source-system column names (ADR 0011).
 */
export const IMPORT_FIELDS = {
  external_ref: { label: "Source ID", kind: "text" },
  name: { label: "Name", kind: "text", required: true },
  slug: { label: "URL slug", kind: "text" },
  short_description: { label: "Short description", kind: "text" },
  description: { label: "Description", kind: "text" },
  base_price: { label: "Base price", kind: "money", required: true },
  included_hours: { label: "Included rental hours", kind: "decimal" },
  category: { label: "Category (use ; for several)", kind: "list" },
  quantity: { label: "Quantity owned", kind: "integer" },
  tracking_mode: { label: "Inventory type (serialized/pooled)", kind: "text" },
  is_published: { label: "Published / active", kind: "boolean" },
  wet_allowed: { label: "Can be used wet", kind: "boolean" },
  dry_allowed: { label: "Can be used dry", kind: "boolean" },
  minimum_age: { label: "Minimum age", kind: "integer" },
  maximum_age: { label: "Maximum age", kind: "integer" },
  recommended_capacity: { label: "Capacity (riders at once)", kind: "integer" },
  max_rider_weight_lbs: { label: "Max rider weight (lbs)", kind: "integer" },
  dimensions: { label: "Dimensions (L x W x H ft)", kind: "text" },
  space_length_ft: { label: "Length (ft)", kind: "decimal" },
  space_width_ft: { label: "Width (ft)", kind: "decimal" },
  space_height_ft: { label: "Height (ft)", kind: "decimal" },
  power_outlets_required: { label: "Outlets required", kind: "integer" },
  power_notes: { label: "Power notes", kind: "text" },
  water_required: { label: "Water hookup required", kind: "boolean" },
  operator_required: { label: "Operator required", kind: "boolean" },
  attendants_required: { label: "Attendants required", kind: "integer" },
  setup_minutes: { label: "Setup time (minutes)", kind: "integer" },
  teardown_minutes: { label: "Teardown time (minutes)", kind: "integer" },
  setup_requirements: { label: "Setup requirements", kind: "text" },
  indoor_allowed: { label: "Indoor OK", kind: "boolean" },
  outdoor_allowed: { label: "Outdoor OK", kind: "boolean" },
  wind_sensitive: { label: "Wind sensitive", kind: "boolean" },
  event_types: { label: "Event types", kind: "list" },
  tags: { label: "Tags", kind: "list" },
  internal_notes: { label: "Internal notes (never public)", kind: "text" },
} as const satisfies Record<string, { label: string; kind: FieldKind; required?: boolean }>;

export type FieldKind = "text" | "money" | "integer" | "decimal" | "boolean" | "list";
export type ImportFieldKey = keyof typeof IMPORT_FIELDS;
export const IMPORT_FIELD_KEYS = Object.keys(IMPORT_FIELDS) as ImportFieldKey[];

/** Canonical field → source column header. */
export type FieldMapping = Partial<Record<ImportFieldKey, string>>;
