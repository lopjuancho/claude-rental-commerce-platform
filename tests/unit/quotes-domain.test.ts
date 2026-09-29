import { describe, expect, it } from "vitest";
import {
  contactInputSchema,
  displayName,
  normalizeEmail,
  normalizePhone,
} from "@/domain/customers/contact";
import {
  canTransition,
  isEditable,
  QUOTE_TRANSITIONS,
  reviewBlocks,
} from "@/domain/quotes/state-machine";
import {
  eventInputSchema,
  eventRow,
  publicQuoteRequestSchema,
  quotePriceRequest,
  staffQuoteSchema,
} from "@/domain/quotes/schemas";

describe("contact normalization", () => {
  it("emails are trimmed and lower-cased", () => {
    expect(normalizeEmail("  Ana.Diaz@Example.COM ")).toBe("ana.diaz@example.com");
    expect(normalizeEmail("  ")).toBeNull();
  });
  it("North American phones become E.164; others must already be +E.164", () => {
    expect(normalizePhone("(901) 300-0417")).toBe("+19013000417");
    expect(normalizePhone("1-901-300-0417")).toBe("+19013000417");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(() => normalizePhone("123")).toThrow();
    expect(() => normalizePhone("(101) 300-0417")).toThrow(); // invalid area code
  });
  it("requires an email or a phone and rejects unknown fields", () => {
    expect(contactInputSchema.safeParse({ firstName: "Ana" }).success).toBe(false);
    expect(contactInputSchema.safeParse({ email: "a@b.co", role: "owner" }).success).toBe(false);
    expect(contactInputSchema.parse({ phone: "901 300 0417" }).phone).toBe("+19013000417");
  });
  it("display name falls back sensibly", () => {
    expect(displayName({ first_name: null, last_name: null, email: "a@b.co" })).toBe("a@b.co");
    expect(displayName({ first_name: "Ana", last_name: "Diaz" })).toBe("Ana Diaz");
  });
});

describe("quote state machine", () => {
  it("accepted, declined and cancelled are final", () => {
    for (const s of ["accepted", "declined", "cancelled"] as const)
      expect(QUOTE_TRANSITIONS[s]).toEqual([]);
  });
  it("only drafts are editable; sent/viewed can be revised back to draft", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("sent")).toBe(false);
    expect(canTransition("sent", "draft")).toBe(true);
    expect(canTransition("accepted", "cancelled")).toBe(false);
    expect(canTransition("draft", "viewed")).toBe(false);
  });
  it("a price needing review blocks until approved", () => {
    expect(reviewBlocks({ manualReviewRequired: true, reviewApprovedAt: null })).toBe(true);
    expect(reviewBlocks({ manualReviewRequired: true, reviewApprovedAt: "2027-01-01" })).toBe(
      false,
    );
    expect(reviewBlocks({ manualReviewRequired: false, reviewApprovedAt: null })).toBe(false);
  });
});

describe("quote request schemas", () => {
  const event = { date: "2027-06-19", startTime: "12:00", endTime: "16:00", address: null };
  it("items carry only a variant and a quantity: prices and add-on flags are rejected", () => {
    const base = {
      contact: { email: "a@b.co" },
      event,
      items: [{ variantId: "3f2b8b3e-6a1d-4c5e-9b7a-2d1e0f9c8a71", quantity: 2 }],
    };
    expect(publicQuoteRequestSchema.safeParse(base).success).toBe(true);
    for (const extra of [{ kind: "add_on" }, { basePriceCents: 1 }, { unitPriceCents: 1 }]) {
      expect(
        publicQuoteRequestSchema.safeParse({ ...base, items: [{ ...base.items[0], ...extra }] })
          .success,
      ).toBe(false);
    }
    expect(publicQuoteRequestSchema.safeParse({ ...base, organizationId: "x" }).success).toBe(
      false,
    );
    expect(publicQuoteRequestSchema.safeParse({ ...base, adjustments: [] }).success).toBe(false);
  });
  it("staff adjustments need a reason", () => {
    const base = {
      customerId: "3f2b8b3e-6a1d-4c5e-9b7a-2d1e0f9c8a71",
      event,
      items: [{ variantId: "3f2b8b3e-6a1d-4c5e-9b7a-2d1e0f9c8a71", quantity: 1 }],
    };
    expect(
      staffQuoteSchema.safeParse({ ...base, adjustments: [{ label: "x", amountCents: -100 }] })
        .success,
    ).toBe(false);
    expect(
      staffQuoteSchema.safeParse({
        ...base,
        adjustments: [{ label: "x", amountCents: -100, reason: "goodwill" }],
      }).success,
    ).toBe(true);
  });
  it("events carry an explicit DST fold only when given", () => {
    expect(eventRow(eventInputSchema.parse(event)).time_fold).toBeNull();
    expect(eventRow(eventInputSchema.parse({ ...event, timeFold: "later" })).time_fold).toBe(
      "later",
    );
    expect(eventInputSchema.safeParse({ ...event, timeFold: "sideways" }).success).toBe(false);
    expect(eventInputSchema.safeParse({ ...event, startTime: "25:00" }).success).toBe(false);
  });
  it("pickup sends no delivery address; every item uses the event window", () => {
    const r = quotePriceRequest({
      items: [{ variantId: "v1", quantity: 2 }],
      startsAt: "2027-06-19T17:00:00.000Z",
      endsAt: "2027-06-19T21:00:00.000Z",
      address: { line1: "1 Main St", city: "Memphis", state: "TN", postalCode: "38127" },
      delivery: "pickup",
      discountCodes: [],
    });
    expect(r).toEqual({
      items: [
        {
          variantId: "v1",
          quantity: 2,
          start: "2027-06-19T17:00:00.000Z",
          end: "2027-06-19T21:00:00.000Z",
        },
      ],
      eventAddress: null,
      discountCodes: [],
      adjustments: [],
    });
  });
});
