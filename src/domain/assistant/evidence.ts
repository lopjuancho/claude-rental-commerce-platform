import { z } from "zod";

/**
 * Typed transactional evidence (ADR 0017 §4). Every fact the assistant may assert — a price, an
 * availability result, a delivery decision, a quote, a booking hold — is recorded here BY THE
 * SERVER from a tool's typed result, never parsed from model text or from free-form strings.
 * Replies are checked against the CURRENT evidence (see grounding.ts): newer evidence for the same
 * subject replaces older, and evidence goes stale after a while.
 */

export const AMOUNT_ROLES = [
  "line",
  "delivery",
  "tax",
  "subtotal",
  "total",
  "starting_price",
  "discount",
] as const;
export type AmountRole = (typeof AMOUNT_ROLES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.strictObject({
  role: z.enum(AMOUNT_ROLES),
  cents: z.int(),
  label: z.string().max(160),
});
export type EvidenceAmount = z.infer<typeof amount>;
const at = z.string().max(40);
const name = z.string().max(200);

export const evidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("availability"),
    at,
    productSlug: z.string().max(120),
    productName: name,
    variantId: z.string().max(40),
    start: z.string().max(40),
    end: z.string().max(40),
    /** Local calendar dates the window touches (business time zone). */
    dates: z.array(isoDate).max(14),
    /** Local clock times of the window (business time zone), "HH:MM". */
    startLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    endLocal: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    quantity: z.int(),
    result: z.enum(["available", "unavailable", "manual_review"]),
  }),
  z.strictObject({
    kind: z.literal("price"),
    at,
    /** Canonical subject: items + window + fulfillment + address. */
    subject: z.string().max(400),
    products: z.array(name).max(10),
    dates: z.array(isoDate).max(14),
    currency: z.string().max(3),
    status: z.enum(["priced", "manual_review"]),
    delivery: z.enum(["none", "priced", "manual_review"]),
    amounts: z.array(amount).max(60),
  }),
  z.strictObject({
    kind: z.literal("catalog_price"),
    at,
    productSlug: z.string().max(120),
    productName: name,
    currency: z.string().max(3),
    amounts: z.array(amount).max(20),
  }),
  z.strictObject({
    kind: z.literal("service_area"),
    at,
    status: z.enum(["serviceable", "outside_service_area", "manual_review"]),
    currency: z.string().max(3),
    feeCents: z.int().nullable(),
  }),
  z.strictObject({
    kind: z.literal("quote"),
    at,
    quoteNumber: z.string().max(40),
    products: z.array(name).max(10),
    dates: z.array(isoDate).max(14),
    currency: z.string().max(3),
    priceIsFinal: z.boolean(),
    amounts: z.array(amount).max(60),
  }),
  z.strictObject({
    kind: z.literal("booking"),
    at,
    quoteNumber: z.string().max(40),
    status: z.enum(["hold_placed", "holding", "confirmed", "refused"]),
    holdExpiresAt: z.string().max(40).nullable(),
    /** The exact server-written message for this state (the only prose that bypasses checks). */
    message: z.string().max(400),
  }),
]);
export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceOf<K extends Evidence["kind"]> = Extract<Evidence, { kind: K }>;

export const MAX_EVIDENCE = 30;

/** Evidence with the same key is about the same subject: the newer one replaces the older. */
export function evidenceKey(e: Evidence): string {
  switch (e.kind) {
    case "availability":
      return `availability:${e.variantId}:${e.start}:${e.end}:${String(e.quantity)}`;
    case "price":
      return `price:${e.subject}`;
    case "catalog_price":
      return `catalog:${e.productSlug}`;
    case "service_area":
      return "service_area";
    case "quote":
      return `quote:${e.quoteNumber}`;
    case "booking":
      return `booking:${e.quoteNumber}`;
  }
}

export function addEvidence(list: Evidence[], added: Evidence[]): Evidence[] {
  let out = [...list];
  for (const e of added) {
    const key = evidenceKey(e);
    out = out.filter((x) => evidenceKey(x) !== key);
    out.push(e);
  }
  return out.slice(-MAX_EVIDENCE);
}

/** How long a result may back a claim. Availability and prices change; a hold ends. */
export const FRESH_MS: Record<Evidence["kind"], number> = {
  availability: 15 * 60_000,
  price: 30 * 60_000,
  catalog_price: 24 * 60 * 60_000,
  service_area: 30 * 60_000,
  quote: 30 * 60_000,
  booking: 30 * 60_000,
};

export function isFresh(e: Evidence, now: Date): boolean {
  const t = Date.parse(e.at);
  return Number.isFinite(t) && now.getTime() - t <= FRESH_MS[e.kind] && t <= now.getTime() + 60_000;
}

export const byNewest = (a: Evidence, b: Evidence) => Date.parse(b.at) - Date.parse(a.at);
