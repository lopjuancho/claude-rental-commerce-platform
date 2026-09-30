import { z } from "zod";
import { postalAddressSchema } from "@/domain/delivery/address";
import { EVENT_TYPES, SURFACE_TYPES } from "@/domain/quotes/schemas";

/**
 * The assistant's tool contract (ADR 0017 §1, §3). Every argument object is STRICT: an unknown
 * key — an organization id, a price, a total, a status — is rejected, never ignored. Nothing here
 * can name a tenant: the tenant is the server-resolved request host. Record references are
 * product slugs and variant ids that tools themselves returned; anything else resolves to
 * "not found" inside the tenant.
 */

const slug = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "Use the product slug returned by search_products.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");
const quantity = z.int().min(1).max(1000);
const fulfillment = z.enum(["delivery", "pickup"]);
const address = postalAddressSchema.strict();

/** A local event window in the business's time zone. */
const windowShape = {
  date: z.iso.date().describe("Event date, YYYY-MM-DD (business time zone)."),
  startTime: time.describe("Start time, 24-hour HH:MM."),
  endTime: time.describe("End time, 24-hour HH:MM. Earlier than the start means the next day."),
  endDate: z.iso.date().optional().describe("Only for multi-day rentals."),
  timeFold: z
    .enum(["earlier", "later"])
    .optional()
    .describe("Only when the customer chose between the two occurrences of a repeated time."),
};

const itemRef = z.strictObject({
  productSlug: slug,
  variantId: z.uuid().optional().describe("Only a variantId returned by get_product_details."),
  quantity,
});

export const toolSchemas = {
  search_products: z.strictObject({
    query: z.string().trim().max(100).optional().describe("Customer's words, e.g. 'water slide'."),
    categorySlug: slug.optional(),
    eventType: z.enum(EVENT_TYPES).optional(),
    minCapacity: z.int().min(1).max(10000).optional().describe("Riders at a time, if stated."),
    wet: z.boolean().optional().describe("true = must allow water use; false = must allow dry."),
    limit: z.int().min(1).max(8).default(6),
  }),
  get_product_details: z.strictObject({ productSlug: slug }),
  check_availability: z.strictObject({
    productSlug: slug,
    variantId: z.uuid().optional(),
    quantity,
    ...windowShape,
  }),
  calculate_price: z
    .strictObject({
      items: z.array(itemRef).min(1).max(10),
      ...windowShape,
      fulfillment,
      address: address.optional().describe("Required for delivery."),
    })
    .refine((v) => v.fulfillment === "pickup" || v.address !== undefined, {
      message: "An event address is required for delivery.",
      path: ["address"],
    }),
  check_service_area: z.strictObject({ address }),
  create_customer: z.strictObject({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    email: z.string().trim().max(254).optional(),
    phone: z.string().trim().max(40).optional(),
    emailOptIn: z.boolean().optional(),
    smsOptIn: z.boolean().optional(),
  }),
  create_event: z
    .strictObject({
      ...windowShape,
      fulfillment,
      address: address.optional().describe("Required for delivery."),
      eventType: z.enum(EVENT_TYPES).optional(),
      title: z.string().trim().max(200).optional(),
      guestCount: z.int().min(0).max(100000).optional(),
      childrenCount: z.int().min(0).max(100000).optional(),
      surfaceType: z.enum(SURFACE_TYPES).optional(),
      powerAvailable: z.boolean().optional(),
      waterAvailable: z.boolean().optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .refine((v) => v.fulfillment === "pickup" || v.address !== undefined, {
      message: "An event address is required for delivery.",
      path: ["address"],
    }),
  create_quote: z.strictObject({
    items: z.array(itemRef).min(1).max(10).optional().describe("Omit to use the staged items."),
    message: z.string().trim().max(500).optional().describe("Customer's note for the team."),
  }),
  add_quote_item: itemRef,
  request_booking: z.strictObject({
    message: z.string().trim().max(500).optional().describe("Customer's note for the team."),
    quoteNumber: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{1,40}$/)
      .optional()
      .describe(
        "Only when the customer chose between the quote they are viewing and this chat's quote: that quote's number.",
      ),
  }),
} as const;

/** Tools that create business records (quotes, booking requests): journaled, never cut off. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "create_quote",
  "add_quote_item",
  "request_booking",
]);

export type ToolName = keyof typeof toolSchemas;
export const TOOL_NAMES = Object.keys(toolSchemas) as ToolName[];
export type ToolArgs<N extends ToolName> = z.infer<(typeof toolSchemas)[N]>;

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  search_products:
    "Find published rentals of this business by the customer's words and structured needs. Returns slugs, names and configured facts only.",
  get_product_details:
    "Configured facts for one product (specs, space, capacity, ages, wet/dry, staffing, weather notes, bookable variants and starting prices).",
  check_availability:
    "Authoritative availability of one product for a date/time window and quantity. Required before saying something is available.",
  calculate_price:
    "Authoritative price breakdown for items, a date/time window and pickup or delivery to an address. Required before stating any price for an event.",
  check_service_area:
    "Whether the business delivers to an address and the delivery charge, from its configured service areas and mileage rules.",
  create_customer:
    "Save the customer's contact details for their quote (an email or phone is required). Call only with details the customer gave.",
  create_event:
    "Save the event date/time and pickup or delivery address for the quote. Call only with details the customer gave.",
  create_quote:
    "Create the customer's quote (needs saved contact details, a saved event and at least one item). Prices are computed by the system.",
  add_quote_item:
    "Add a product to the customer's quote (before a quote exists it is staged; after, an updated quote is created).",
  request_booking:
    "Request the booking for the customer's current quote. Places a temporary hold; it never confirms a booking.",
};

/** JSON Schema for the provider (the server validates with the Zod schema regardless). */
export function toolJsonSchema(name: ToolName): Record<string, unknown> {
  const schema = z.toJSONSchema(toolSchemas[name], { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return stripDatePatterns(schema) as Record<string, unknown>;
}

/** Keywords OpenAI strict function schemas accept (others are dropped; Zod still enforces them). */
const STRICT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "description",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
]);
const STRICT_FORMATS = new Set(["date", "date-time", "time", "email", "uuid"]);

/**
 * The strict variant (L1): every object closed and every property required, optional ones as
 * `null`-able — the provider then generates arguments that parse. The server removes the nulls
 * (stripNulls) and validates with the Zod schema as before: strictness at the provider is a
 * convenience, never the authority.
 */
export function strictToolJsonSchema(name: ToolName): Record<string, unknown> {
  return toStrict(toolJsonSchema(name), true) as Record<string, unknown>;
}

function toStrict(node: unknown, required: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => toStrict(n, true));
  if (!node || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (!STRICT_KEYWORDS.has(k)) continue;
    if (k === "format" && !STRICT_FORMATS.has(String(v))) continue;
    if (k === "properties" && v && typeof v === "object") {
      const req = new Set((src.required as string[] | undefined) ?? []);
      out.properties = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([p, s]) => [p, toStrict(s, req.has(p))]),
      );
      out.required = Object.keys(v);
      out.additionalProperties = false;
      continue;
    }
    if (k === "required" || k === "additionalProperties") continue;
    out[k] = k === "items" || k === "anyOf" ? toStrict(v, true) : v;
  }
  if (out.type === "object" && !("properties" in out)) {
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  if (required) return out;
  const { description, ...rest } = out;
  return {
    anyOf: [rest, { type: "null" }],
    ...(description !== undefined ? { description } : {}),
  };
}

/** Removes `null` object values (strict-mode placeholders for omitted optional arguments). */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, stripNulls(v)]),
  );
}

function stripDatePatterns(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDatePatterns);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = stripDatePatterns(v);
  if (out.format === "date" || out.format === "uuid") delete out.pattern;
  return out;
}

/** Keys that are never accepted anywhere in tool arguments, whatever the tool. */
export const FORBIDDEN_ARGUMENT_KEYS = [
  "organizationId",
  "organization_id",
  "orgId",
  "tenant",
  "tenantId",
  "price",
  "priceCents",
  "total",
  "totalCents",
  "status",
  "customerId",
  "quoteId",
  "token",
] as const;
