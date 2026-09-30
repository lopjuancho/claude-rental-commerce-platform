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
  }),
} as const;

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
