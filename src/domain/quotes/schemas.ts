import { z } from "zod";
import { postalAddressSchema } from "@/domain/delivery/address";
import { contactInputSchema } from "@/domain/customers/contact";

export const EVENT_TYPES = [
  "birthday",
  "school",
  "church",
  "corporate",
  "community",
  "graduation",
  "festival",
  "wedding",
  "sports",
  "holiday",
  "other",
] as const;

export const SURFACE_TYPES = [
  "grass",
  "concrete",
  "asphalt",
  "indoor_floor",
  "dirt",
  "other",
] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");

/**
 * An event as described by the customer or staff: local date/times in the organization's time
 * zone (the database derives the instants), the event address, and optional planning details.
 */
export const eventInputSchema = z.strictObject({
  title: z.string().trim().max(200).optional(),
  eventType: z.enum(EVENT_TYPES).optional(),
  date: z.iso.date(),
  endDate: z.iso.date().optional(),
  startTime: time,
  endTime: time,
  /** Only for a time that happens twice (DST fall-back); otherwise such a time is rejected. */
  timeFold: z.enum(["earlier", "later"]).optional(),
  address: postalAddressSchema.nullable(),
  guestCount: z.int().min(0).max(100000).optional(),
  childrenCount: z.int().min(0).max(100000).optional(),
  surfaceType: z.enum(SURFACE_TYPES).optional(),
  powerAvailable: z.boolean().optional(),
  waterAvailable: z.boolean().optional(),
  notes: z.string().trim().max(4000).optional(),
});
export type EventInput = z.infer<typeof eventInputSchema>;

/** Item choice only. Prices, add-on status and every other pricing input come from the server. */
export const quoteLineSchema = z.strictObject({
  variantId: z.uuid(),
  quantity: z.int().min(1).max(1000),
});

/**
 * A public quote request (storefront; later the assistant). Items share the event's time window.
 * Delivery is priced to the event address unless the customer picks up.
 */
export const publicQuoteRequestSchema = z.strictObject({
  contact: contactInputSchema,
  event: eventInputSchema,
  items: z.array(quoteLineSchema).min(1).max(20),
  delivery: z.enum(["delivery", "pickup"]).default("delivery"),
  discountCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,40}$/)
    .optional(),
  message: z.string().trim().max(2000).optional(),
});
export type PublicQuoteRequest = z.infer<typeof publicQuoteRequestSchema>;

/** Staff quote: same shape plus manual adjustments and internal notes; customer is chosen or created. */
export const staffQuoteSchema = z.strictObject({
  customerId: z.uuid(),
  event: eventInputSchema,
  items: z.array(quoteLineSchema).min(1).max(50),
  delivery: z.enum(["delivery", "pickup"]).default("delivery"),
  discountCodes: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{2,40}$/),
    )
    .max(5)
    .default([]),
  adjustments: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(120),
        amountCents: z.int().min(-10_000_000).max(10_000_000),
        reason: z.string().trim().min(3).max(500),
      }),
    )
    .max(10)
    .default([]),
  customerNotes: z.string().trim().max(4000).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
});
export type StaffQuoteInput = z.infer<typeof staffQuoteSchema>;

/** Row values for public.events from an EventInput. */
export function eventRow(e: EventInput) {
  return {
    title: e.title ?? null,
    event_type: e.eventType ?? null,
    event_date: e.date,
    end_date: e.endDate ?? null,
    start_time: e.startTime,
    end_time: e.endTime,
    time_fold: e.timeFold ?? null,
    address_line1: e.address?.line1 ?? null,
    address_line2: e.address?.line2 ?? null,
    city: e.address?.city ?? null,
    state: e.address?.state ?? null,
    postal_code: e.address?.postalCode ?? null,
    guest_count: e.guestCount ?? null,
    children_count: e.childrenCount ?? null,
    surface_type: e.surfaceType ?? null,
    power_available: e.powerAvailable ?? null,
    water_available: e.waterAvailable ?? null,
    notes: e.notes ?? null,
  };
}

/**
 * The pricing request for a quote. Every item uses the event window (instants derived by the
 * database from local date/time); delivery goes to the event address unless picked up.
 */
export function quotePriceRequest(args: {
  items: z.infer<typeof quoteLineSchema>[];
  startsAt: string;
  endsAt: string;
  address: EventInput["address"];
  delivery: "delivery" | "pickup";
  discountCodes: string[];
  adjustments?: { label: string; amountCents: number; reason: string }[];
}) {
  return {
    items: args.items.map((i) => ({
      variantId: i.variantId,
      quantity: i.quantity,
      start: args.startsAt,
      end: args.endsAt,
    })),
    eventAddress: args.delivery === "pickup" ? null : args.address,
    discountCodes: args.discountCodes,
    adjustments: args.adjustments ?? [],
  };
}
