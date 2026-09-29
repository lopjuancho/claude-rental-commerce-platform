import { describe, expect, it } from "vitest";
import { divideRoundHalfUp, percentOf } from "@/domain/money";
import { calculatePrice, canonicalJson } from "@/domain/pricing/engine";
import type { PricingInput, PricingItem, PricingRule, TaxContext } from "@/domain/pricing/types";

// ── builders ──────────────────────────────────────────────────────────────
const TZ = "America/Chicago";
const at = (day: number, hhmm: string) =>
  `2027-06-${String(day).padStart(2, "0")}T${hhmm}:00-05:00`; // CDT

let seq = 0;
const rule = (
  type: PricingRule["type"],
  params: Record<string, unknown>,
  patch: Partial<PricingRule> = {},
): PricingRule => ({
  id: `rule-${String(++seq).padStart(3, "0")}`,
  revision: 1,
  name: `${type} rule`,
  type,
  categoryId: null,
  productId: null,
  variantId: null,
  params,
  priority: 0,
  discountCode: null,
  validFrom: null,
  validTo: null,
  ...patch,
});

const slide = (patch: Partial<PricingItem> = {}): PricingItem => ({
  lineId: "L1",
  variantId: "v-slide",
  productId: "p-slide",
  name: "Water Slide",
  primaryCategoryId: "c-slides",
  categoryIds: ["c-slides"],
  kind: "rental",
  quantity: 1,
  basePriceCents: 45000,
  includedDurationMinutes: 240, // "base price covers up to 4 hours"
  overnightAllowed: false,
  attendantsRequired: 0,
  active: true,
  start: at(19, "12:00"),
  end: at(19, "16:00"),
  ...patch,
});

const taxAll = (
  taxability: TaxContext extends infer T ? (T extends { taxability: infer X } ? X : never) : never,
  status: "test" | "active" = "active",
  rateBps = 975,
): TaxContext => ({
  status: "resolved",
  jurisdiction: {
    id: "tj-1",
    revision: 1,
    name: "Test jurisdiction",
    status,
    boundaryReview: false,
  },
  rates: [{ id: "tr-1", name: "Combined", rateBps }],
  taxability,
});

const FULL_TAXABILITY = {
  rental: true,
  add_on: true,
  delivery: false,
  labor: true,
  fee: true,
  discount: true,
  adjustment: true,
} as const;

const input = (patch: Partial<PricingInput> = {}): PricingInput => ({
  currency: "USD",
  timeZone: TZ,
  items: [slide()],
  rules: [],
  discountCodes: [],
  delivery: { status: "not_requested" },
  tax: taxAll(FULL_TAXABILITY),
  adjustments: [],
  ...patch,
});

const tikyAdditionalDay = rule(
  "additional_day",
  { percent_of_base_bps: 2500 },
  { name: "Additional day +25%" },
);

// ── money ────────────────────────────────────────────────────────────────
describe("money rounding", () => {
  it("rounds half away from zero on integers", () => {
    expect(divideRoundHalfUp(5, 2)).toBe(3);
    expect(divideRoundHalfUp(-5, 2)).toBe(-3);
    expect(divideRoundHalfUp(4, 3)).toBe(1);
    expect(percentOf(45000, 2500)).toBe(11250);
    expect(percentOf(333, 975)).toBe(32); // 32.4675 → 32
    expect(percentOf(338, 975)).toBe(33); // 32.955 → 33
    expect(() => divideRoundHalfUp(1.5, 2)).toThrow();
  });
});

// ── duration: included / extra hours / overnight / days ─────────────────
describe("duration pricing", () => {
  it("4-hour water slide: base covers up to 4 hours exactly", () => {
    const r = calculatePrice(input());
    expect(r.summary).toMatchObject({
      base: 45000,
      extra_hours: 0,
      subtotal: 45000,
      manual_review_required: false,
    });
    expect(r.lines.map((l) => l.kind)).toEqual(["base"]);
  });

  it("beyond the included duration without an extra-hour rate → manual review (never $0)", () => {
    const r = calculatePrice(input({ items: [slide({ end: at(19, "17:30") })] }));
    expect(r.manualReviewRequired).toBe(true);
    expect(r.reviewReasons).toContain("EXTRA_HOURS_PRICING_NOT_CONFIGURED:L1");
    expect(r.summary.extra_hours).toBe(0);
  });

  it("extra-hour pricing charges each started hour beyond the included duration", () => {
    const extra = rule("extra_hour", { amount_cents: 5000 }, { categoryId: "c-slides" });
    const r = calculatePrice(input({ items: [slide({ end: at(19, "17:30") })], rules: [extra] })); // 5.5 h → 2 extra hours
    expect(r.summary).toMatchObject({
      extra_hours: 10000,
      subtotal: 55000,
      manual_review_required: false,
    });
    expect(r.lines[1]).toMatchObject({
      kind: "extra_hours",
      label: "Water Slide: 2 extra hours",
      ruleId: extra.id,
      ruleRevision: 1,
    });
  });

  it("extra time in 30-minute increments", () => {
    const extra = rule("extra_hour", { amount_cents: 2500, increment_minutes: 30 });
    const r = calculatePrice(input({ items: [slide({ end: at(19, "17:10") })], rules: [extra] })); // 70 min → 3 × 30
    expect(r.summary.extra_hours).toBe(7500);
  });

  it("overnight: single-day rental across local midnight uses the overnight rule (no extra hours)", () => {
    const overnight = rule("overnight", { amount_cents: 7500 });
    const extra = rule("extra_hour", { amount_cents: 5000 });
    const r = calculatePrice(
      input({
        items: [slide({ overnightAllowed: true, start: at(19, "18:00"), end: at(20, "10:00") })],
        rules: [overnight, extra],
      }),
    );
    expect(r.summary).toMatchObject({
      overnight: 7500,
      extra_hours: 0,
      additional_days: 0,
      subtotal: 52500,
      manual_review_required: false,
    });
  });

  it("overnight as a percentage of base", () => {
    const r = calculatePrice(
      input({
        items: [slide({ overnightAllowed: true, start: at(19, "18:00"), end: at(20, "10:00") })],
        rules: [rule("overnight", { percent_of_base_bps: 2000 })],
      }),
    );
    expect(r.summary.overnight).toBe(9000);
  });

  it("overnight with no configured charge → manual review (Tiky Jumps has none yet)", () => {
    const r = calculatePrice(
      input({
        items: [slide({ overnightAllowed: true, start: at(19, "18:00"), end: at(20, "10:00") })],
      }),
    );
    expect(r.reviewReasons).toEqual(["OVERNIGHT_PRICING_NOT_CONFIGURED:L1"]);
  });

  it("overnight where it is not permitted → manual review even if a charge exists", () => {
    const r = calculatePrice(
      input({
        items: [slide({ overnightAllowed: false, start: at(19, "18:00"), end: at(20, "10:00") })],
        rules: [rule("overnight", { amount_cents: 7500 })],
      }),
    );
    expect(r.reviewReasons).toContain("OVERNIGHT_NOT_PERMITTED:L1");
  });

  it("+25 % of base per additional day (2 days)", () => {
    const r = calculatePrice(
      input({
        items: [slide({ start: at(19, "10:00"), end: at(20, "18:00") })],
        rules: [tikyAdditionalDay],
      }),
    ); // 32 h → 2 days
    expect(r.summary).toMatchObject({
      base: 45000,
      additional_days: 11250,
      subtotal: 56250,
      manual_review_required: false,
    });
    expect(r.lines[1]?.label).toBe("Water Slide: 1 additional day");
  });

  it("multiple-day rentals: 3 days = base + 2 × 25 %", () => {
    const r = calculatePrice(
      input({
        items: [slide({ start: at(18, "17:00"), end: at(21, "12:00") })],
        rules: [tikyAdditionalDay],
      }),
    ); // 67 h
    expect(r.summary.additional_days).toBe(22500);
    expect(r.summary.subtotal).toBe(67500);
  });

  it("multi-day without an additional-day rule → manual review", () => {
    const r = calculatePrice(
      input({ items: [slide({ start: at(19, "10:00"), end: at(21, "10:00") })] }),
    );
    expect(r.reviewReasons).toContain("ADDITIONAL_DAY_PRICING_NOT_CONFIGURED:L1");
  });

  it("a DST-crossing overnight is still one billable day", () => {
    const r = calculatePrice(
      input({
        items: [
          slide({
            overnightAllowed: true,
            start: "2026-10-31T18:00:00-05:00",
            end: "2026-11-01T10:00:00-06:00",
          }),
        ],
        rules: [rule("overnight", { amount_cents: 1000 })],
      }),
    );
    expect(r.summary).toMatchObject({ overnight: 1000, additional_days: 0 });
  });
});

// ── quantity, add-ons, labor, fees ──────────────────────────────────────
describe("quantities, add-ons, labor, fees", () => {
  it("quantity > 1 multiplies every per-item charge", () => {
    const r = calculatePrice(
      input({
        items: [slide({ quantity: 3, start: at(19, "10:00"), end: at(20, "18:00") })],
        rules: [tikyAdditionalDay],
      }),
    );
    expect(r.summary).toMatchObject({
      quantity: 3,
      base: 135000,
      additional_days: 33750,
      subtotal: 168750,
    });
  });

  it("add-ons are priced like rentals but reported and taxed separately", () => {
    const generator = slide({
      lineId: "L2",
      variantId: "v-gen",
      productId: "p-gen",
      name: "Generator",
      kind: "add_on",
      basePriceCents: 7500,
      primaryCategoryId: null,
      categoryIds: [],
    });
    const r = calculatePrice(
      input({ items: [slide(), generator], tax: taxAll({ ...FULL_TAXABILITY, add_on: false }) }),
    );
    expect(r.summary).toMatchObject({
      base: 45000,
      add_ons: 7500,
      quantity: 1,
      subtotal: 52500,
      taxable_subtotal: 45000,
    });
  });

  it("required attendants need a configured rate (or manual review)", () => {
    const item = slide({ attendantsRequired: 1 });
    expect(calculatePrice(input({ items: [item] })).reviewReasons).toContain(
      "ATTENDANT_PRICING_NOT_CONFIGURED:L1",
    );
    const perHour = calculatePrice(
      input({ items: [item], rules: [rule("attendant_fee", { amount_cents: 2500, per: "hour" })] }),
    );
    expect(perHour.summary.labor).toBe(10000); // 4 h × $25
    const included = calculatePrice(
      input({ items: [item], rules: [rule("attendant_fee", { amount_cents: 0, per: "event" })] }),
    );
    expect(included.summary).toMatchObject({ labor: 0, manual_review_required: false });
  });

  it("per-unit and per-order fees", () => {
    const r = calculatePrice(
      input({
        items: [slide({ quantity: 2 })],
        rules: [
          rule("fee", { amount_cents: 1500, per: "unit", label: "Cleaning" }),
          rule("fee", { amount_cents: 2000, per: "order", label: "Fuel" }),
        ],
      }),
    );
    expect(r.summary.fees).toBe(1500 * 2 + 2000);
  });
});

// ── discounts ────────────────────────────────────────────────────────────
describe("discounts", () => {
  it("automatic percentage discount on rental charges", () => {
    const r = calculatePrice(
      input({ rules: [rule("discount_percent", { percent_bps: 1000 }, { name: "10% off" })] }),
    );
    expect(r.summary).toMatchObject({ discounts: -4500, subtotal: 40500 });
  });

  it("code-only discounts apply only with the code (case-insensitive); unknown codes warn", () => {
    const coded = rule("discount_fixed", { amount_cents: 2500 }, { discountCode: "SUMMER25" });
    expect(calculatePrice(input({ rules: [coded] })).summary.discounts).toBe(0);
    expect(
      calculatePrice(input({ rules: [coded], discountCodes: ["summer25"] })).summary.discounts,
    ).toBe(-2500);
    expect(calculatePrice(input({ rules: [coded], discountCodes: ["NOPE"] })).warnings).toEqual([
      "DISCOUNT_CODE_NOT_APPLICABLE:NOPE",
    ]);
  });

  it("minimum-quantity discounts", () => {
    const multi = rule("discount_percent", { percent_bps: 500, min_quantity: 3 });
    expect(
      calculatePrice(input({ items: [slide({ quantity: 2 })], rules: [multi] })).summary.discounts,
    ).toBe(0);
    expect(
      calculatePrice(input({ items: [slide({ quantity: 3 })], rules: [multi] })).summary.discounts,
    ).toBe(-6750);
  });

  it("scoped discounts only touch in-scope items; totals never go below zero", () => {
    const other = slide({
      lineId: "L2",
      variantId: "v-c",
      productId: "p-castle",
      name: "Castle",
      basePriceCents: 20000,
      primaryCategoryId: "c-bounce",
      categoryIds: ["c-bounce"],
    });
    const r = calculatePrice(
      input({
        items: [slide(), other],
        rules: [rule("discount_percent", { percent_bps: 5000 }, { categoryId: "c-bounce" })],
      }),
    );
    expect(r.summary.discounts).toBe(-10000);
    const huge = calculatePrice(
      input({ rules: [rule("discount_fixed", { amount_cents: 999999 })] }),
    );
    expect(huge.summary.subtotal).toBe(0);
  });

  it("discounts do not reduce delivery, and a minimum charge tops up the rental after discounts", () => {
    const r = calculatePrice(
      input({
        rules: [
          rule("discount_percent", { percent_bps: 5000 }),
          rule("minimum_charge", { amount_cents: 30000 }, { name: "Minimum order" }),
        ],
        delivery: {
          status: "priced",
          method: "flat",
          feeCents: 3500,
          label: "Delivery",
          distanceMiles: null,
          billableMiles: null,
          serviceAreaId: null,
          serviceAreaRevision: null,
          provider: null,
        },
      }),
    );
    expect(r.summary).toMatchObject({
      discounts: -22500,
      fees: 7500,
      delivery: 3500,
      subtotal: 45000 - 22500 + 7500 + 3500,
    });
  });
});

// ── precedence and validity ──────────────────────────────────────────────
describe("rule precedence (variant > product > category > organization)", () => {
  const o = rule("extra_hour", { amount_cents: 1000 });
  const c = rule("extra_hour", { amount_cents: 2000 }, { categoryId: "c-slides" });
  const p = rule("extra_hour", { amount_cents: 3000 }, { productId: "p-slide" });
  const v = rule("extra_hour", { amount_cents: 4000 }, { variantId: "v-slide" });
  const oneExtra = [slide({ end: at(19, "17:00") })];

  it.each([
    [[o], 1000],
    [[o, c], 2000],
    [[o, c, p], 3000],
    [[o, c, p, v], 4000],
    [[v, p, c, o], 4000], // input order does not matter
  ])("most specific rule wins (%#)", (rules, expected) => {
    expect(calculatePrice(input({ items: oneExtra, rules })).summary.extra_hours).toBe(expected);
  });

  it("higher priority wins at equal specificity; rules for other products are ignored", () => {
    const low = rule("extra_hour", { amount_cents: 1000 }, { priority: 0 });
    const high = rule("extra_hour", { amount_cents: 1500 }, { priority: 5 });
    const elsewhere = rule("extra_hour", { amount_cents: 9999 }, { productId: "p-other" });
    expect(
      calculatePrice(input({ items: oneExtra, rules: [low, high, elsewhere] })).summary.extra_hours,
    ).toBe(1500);
  });

  it("validity dates are checked against the event's local date", () => {
    const seasonal = rule(
      "discount_percent",
      { percent_bps: 1000 },
      { validFrom: "2027-06-01", validTo: "2027-06-15" },
    );
    expect(calculatePrice(input({ rules: [seasonal] })).summary.discounts).toBe(0); // event on 06-19
    expect(
      calculatePrice(
        input({
          items: [slide({ start: at(10, "12:00"), end: at(10, "16:00") })],
          rules: [seasonal],
        }),
      ).summary.discounts,
    ).toBe(-4500);
  });

  it("invalid rule parameters force review instead of being guessed", () => {
    const broken = rule("extra_hour", { amount_cents: -5 });
    expect(calculatePrice(input({ items: oneExtra, rules: [broken] })).reviewReasons).toContain(
      `RULE_INVALID:${broken.id}`,
    );
  });
});

// ── tax ──────────────────────────────────────────────────────────────────
describe("tax", () => {
  const delivery = {
    status: "priced" as const,
    method: "mileage" as const,
    feeCents: 1600,
    label: "Delivery",
    distanceMiles: 8.2,
    billableMiles: 4,
    serviceAreaId: null,
    serviceAreaRevision: null,
    provider: "fake",
  };

  it("taxable vs non-taxable components (delivery not taxable here)", () => {
    const r = calculatePrice(input({ delivery }));
    expect(r.summary).toMatchObject({
      subtotal: 46600,
      taxable_subtotal: 45000,
      tax: 4388,
      total: 50988,
    }); // 45000 × 9.75 % = 4387.5 → 4388
    expect(r.lines.find((l) => l.kind === "delivery")?.taxable).toBe(false);
  });

  it("taxable discounts reduce the taxable base; non-taxable discounts do not", () => {
    const d = rule("discount_fixed", { amount_cents: 5000 });
    expect(calculatePrice(input({ rules: [d] })).summary.taxable_subtotal).toBe(40000);
    expect(
      calculatePrice(input({ rules: [d], tax: taxAll({ ...FULL_TAXABILITY, discount: false }) }))
        .summary.taxable_subtotal,
    ).toBe(45000);
  });

  it("multiple rate components are rounded individually and summed", () => {
    const r = calculatePrice(
      input({
        tax: {
          ...taxAll(FULL_TAXABILITY),
          rates: [
            { id: "a", name: "State", rateBps: 700 },
            { id: "b", name: "Local", rateBps: 275 },
          ],
        } as TaxContext,
      }),
    );
    expect(r.taxLines.map((t) => t.amountCents)).toEqual([3150, 1238]);
    expect(r.summary.tax).toBe(4388);
  });

  it("unresolved jurisdiction → manual review, no tax invented", () => {
    const r = calculatePrice(input({ tax: { status: "unresolved" } }));
    expect(r.summary.tax).toBe(0);
    expect(r.reviewReasons).toEqual(["TAX_JURISDICTION_UNRESOLVED"]);
  });

  it("test configurations compute tax but always require review", () => {
    const r = calculatePrice(input({ tax: taxAll(FULL_TAXABILITY, "test") }));
    expect(r.summary.tax).toBe(4388);
    expect(r.reviewReasons).toContain("TAX_TEST_CONFIGURATION");
  });

  it("a component without configured taxability → manual review", () => {
    const r = calculatePrice(input({ delivery, tax: taxAll({ rental: true }) }));
    expect(r.reviewReasons).toEqual(["TAX_TAXABILITY_NOT_CONFIGURED:delivery"]);
  });

  it("manual adjustments follow the adjustment taxability", () => {
    const r = calculatePrice(
      input({ adjustments: [{ label: "Goodwill credit", amountCents: -2000 }] }),
    );
    expect(r.summary).toMatchObject({ adjustments: -2000, taxable_subtotal: 43000 });
  });
});

// ── delivery review + determinism ────────────────────────────────────────
describe("delivery review and determinism", () => {
  it("delivery needing review propagates to the whole price", () => {
    const r = calculatePrice(
      input({ delivery: { status: "manual_review", reason: "PROVIDER_ERROR" } }),
    );
    expect(r.reviewReasons).toEqual(["DELIVERY:PROVIDER_ERROR"]);
    expect(r.summary.delivery).toBe(0);
  });

  it("is deterministic and independent of rule order", () => {
    const rules = [
      tikyAdditionalDay,
      rule("discount_percent", { percent_bps: 1000 }),
      rule("fee", { amount_cents: 500, per: "order" }),
    ];
    const base = input({
      items: [slide({ quantity: 2, start: at(19, "10:00"), end: at(21, "10:00") })],
      rules,
    });
    const a = calculatePrice(base);
    const b = calculatePrice({ ...base, rules: [...rules].reverse() });
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(calculatePrice(structuredClone(base)))).toBe(canonicalJson(a));
  });

  it("records exactly which rules and revisions produced the price", () => {
    const r = calculatePrice(
      input({
        items: [slide({ start: at(19, "10:00"), end: at(20, "18:00") })],
        rules: [{ ...tikyAdditionalDay, revision: 3 }],
      }),
    );
    expect(r.appliedRules).toEqual([
      {
        id: tikyAdditionalDay.id,
        revision: 3,
        type: "additional_day",
        name: "Additional day +25%",
      },
    ]);
  });

  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  it("invalid items are flagged, not priced", () => {
    const r = calculatePrice(
      input({ items: [slide({ quantity: 0 }), slide({ lineId: "L9", end: at(19, "11:00") })] }),
    );
    expect(r.reviewReasons).toEqual(["INVALID_ITEM:L1", "INVALID_ITEM:L9"]);
  });
});
