import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { PostalAddress } from "@/domain/delivery/address";
import { METERS_PER_MILE } from "@/domain/delivery/mileage";
import type { DistanceCache, DistanceProvider } from "@/domain/delivery/provider";
import { quoteDelivery } from "@/domain/delivery/quote";
import {
  areaContextSchema,
  assemblePricingInput,
  deliveryConfig,
  type PriceRequest,
  priceRequestSchema,
  pricingContextSchema,
  taxContextSchema,
  taxLocation,
} from "@/domain/pricing/context";
import { calculatePrice, canonicalJson } from "@/domain/pricing/engine";
import type { PriceResult, PricingInput } from "@/domain/pricing/types";
import { june, makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { type Actor, admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";

/**
 * End-to-end pricing against the real database: the SQL context functions feed the same pure
 * pipeline the server uses (src/server/pricing/run.ts), minus PostgREST.
 */
const EVENT: PostalAddress = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
const DEPOT: PostalAddress = {
  line1: "2560 Overton Crossing St",
  city: "Memphis",
  state: "TN",
  postalCode: "38127",
};

function fakeProvider(miles: number): DistanceProvider & { calls: number } {
  const p = {
    id: "fake",
    version: "1",
    calls: 0,
    getRoadDistance: () => {
      p.calls++;
      return Promise.resolve({ ok: true as const, meters: miles * METERS_PER_MILE });
    },
  };
  return p;
}

/** DistanceCache over the real get/put_cached_distance functions, called as `actor`. */
function dbCache(actor: Actor, org: TestOrg): DistanceCache {
  return {
    get: async (k) =>
      (
        await rpc<{ m: number | null }>(
          actor,
          "select public.get_cached_distance($1, $2, $3, $4) as m",
          [org.id, k.provider, k.version, k.routeKey],
        )
      )[0]!.m,
    put: async (k, meters) => {
      await rpc(actor, "select public.put_cached_distance($1, $2, $3, $4, $5)", [
        org.id,
        k.provider,
        k.version,
        k.routeKey,
        Math.round(meters),
      ]);
    },
  };
}

async function price(
  actor: Actor,
  org: TestOrg,
  raw: unknown,
  opts: { provider?: DistanceProvider | null; channel?: "staff" | "public" } = {},
): Promise<{ input: PricingInput; output: PriceResult }> {
  const request: PriceRequest = priceRequestSchema.parse(raw);
  const [ctxRow] = await rpc<{ c: unknown }>(actor, "select public.pricing_context($1, $2) as c", [
    org.id,
    request.items.map((i) => i.variantId),
  ]);
  const context = pricingContextSchema.parse(ctxRow!.c);
  const area = request.eventAddress
    ? areaContextSchema.parse(
        (
          await rpc<{ a: unknown }>(
            actor,
            "select public.delivery_area_context($1, $2, $3, $4) as a",
            [
              org.id,
              request.eventAddress.city,
              request.eventAddress.state,
              request.eventAddress.postalCode,
            ],
          )
        )[0]!.a,
      )
    : { areasConfigured: false, match: null };
  const delivery = await quoteDelivery({
    destination: request.eventAddress,
    config: deliveryConfig(context),
    area,
    provider: opts.provider === undefined ? fakeProvider(8.2) : opts.provider,
    cache: dbCache(actor, org),
    currency: context.organization.currency,
  });
  const loc = taxLocation(context, request);
  const tax = loc
    ? taxContextSchema.parse(
        (
          await rpc<{ t: unknown }>(actor, "select public.tax_context($1, $2, $3, $4) as t", [
            org.id,
            loc.state,
            loc.postalCode,
            request.items[0]!.start.slice(0, 10),
          ])
        )[0]!.t,
      )
    : ({ status: "unresolved" } as const);
  const input = assemblePricingInput({
    context,
    request,
    delivery,
    tax,
    channel: opts.channel ?? "staff",
  });
  return { input, output: calculatePrice(input) };
}

async function sha256(text: string) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(text).digest("hex");
}

async function record(
  actor: Actor,
  org: TestOrg,
  input: PricingInput,
  output: PriceResult,
): Promise<string> {
  const [row] = await rpc<{ id: string }>(
    actor,
    "select public.record_pricing_calculation($1, $2, $3, $4, $5) as id",
    [
      org.id,
      output.engineVersion,
      JSON.stringify(input),
      JSON.stringify(output),
      await sha256(canonicalJson(input)),
    ],
  );
  return row!.id;
}

let org: TestOrg;
let slidesCategory: string;
let slide: { productId: string; variantId: string };
let castle: { productId: string; variantId: string };
let additionalDayRule: string;

const item = (variantId: string, start: string, end: string, quantity = 1) => ({
  variantId,
  quantity,
  start,
  end,
});

beforeAll(async () => {
  org = await createOrg("pricing");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = $2, primary_depot_city = $3, primary_depot_state = $4,
       primary_depot_postal_code = $5, free_delivery_miles = 5, per_mile_rate_cents = 400 where organization_id = $1`,
    [org.id, DEPOT.line1, DEPOT.city, DEPOT.state, DEPOT.postalCode],
  );
  const cat = await admin<{ id: string }>(
    "insert into public.categories (organization_id, name, slug, included_duration_minutes) values ($1, 'Water Slides', 'water-slides', 240) returning id",
    [org.id],
  );
  slidesCategory = cat.rows[0]!.id;
  slide = await makeProduct(org, { units: 2, categoryId: slidesCategory });
  await admin(
    "update public.products set base_price_cents = 45000, name = 'Tropical Slide' where id = $1",
    [slide.productId],
  );
  await admin(
    "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
    [org.id, slide.productId, slidesCategory],
  );
  castle = await makeProduct(org, { units: 1 });
  await admin(
    "update public.products set base_price_cents = 47500, name = 'Castle' where id = $1",
    [castle.productId],
  );
  const r = await admin<{ id: string }>(
    "insert into public.pricing_rules (organization_id, name, rule_type, params) values ($1, 'Additional day +25%', 'additional_day', '{\"percent_of_base_bps\": 2500}') returning id",
    [org.id],
  );
  additionalDayRule = r.rows[0]!.id;
  // Test-only tax configuration (status 'test' → always manual review).
  const j = await admin<{ id: string }>(
    "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes) values ($1, 'Test Germantown', 'TN', '{38138}') returning id",
    [org.id],
  );
  await admin(
    "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'Test combined rate', 925)",
    [org.id, j.rows[0]!.id],
  );
  for (const [component, taxable] of [
    ["rental", true],
    ["add_on", true],
    ["delivery", false],
    ["labor", true],
    ["fee", true],
    ["discount", true],
    ["adjustment", true],
  ] as const) {
    await admin(
      "insert into public.tax_component_rules (organization_id, jurisdiction_id, component, taxable) values ($1, $2, $3, $4)",
      [org.id, j.rows[0]!.id, component, taxable],
    );
  }
});

const staff = () => org.users.office;

describe("end-to-end pricing from database configuration", () => {
  it("4-hour water slide + 8.2-mile delivery ($16) + test tax, itemised", async () => {
    const { output } = await price(staff(), org, {
      items: [item(slide.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: EVENT,
    });
    expect(output.summary).toEqual({
      base: 45000,
      extra_hours: 0,
      overnight: 0,
      additional_days: 0,
      quantity: 1,
      add_ons: 0,
      labor: 0,
      fees: 0,
      delivery: 1600,
      discounts: 0,
      adjustments: 0,
      subtotal: 46600,
      taxable_subtotal: 45000, // delivery not taxable in this test configuration
      tax: 4163, // 45000 × 9.25 % = 4162.5 → 4163
      total: 50763,
      manual_review_required: true, // test tax configuration is never final
    });
    expect(output.reviewReasons).toEqual(["TAX_TEST_CONFIGURATION"]);
    expect(output.lines.map((l) => [l.kind, l.label, l.amountCents, l.taxable])).toEqual([
      ["base", "Tropical Slide", 45000, true],
      ["delivery", "Delivery (8.2 mi: 4 billable mi × $4.00)", 1600, false],
    ]);
  });

  it("the included duration comes from the category (4 h); a 5th hour without an extra-hour rate needs review", async () => {
    const { output } = await price(staff(), org, {
      items: [item(slide.variantId, june(19, "12:00"), june(19, "17:00"))],
      eventAddress: EVENT,
    });
    expect(output.reviewReasons).toContain("EXTRA_HOURS_PRICING_NOT_CONFIGURED:L1");
  });

  it("multi-day with quantity 2: +25 % of base per additional day per unit", async () => {
    const { output } = await price(staff(), org, {
      items: [item(slide.variantId, june(18, "17:00"), june(20, "12:00"), 2)],
      eventAddress: EVENT,
    });
    expect(output.summary).toMatchObject({ quantity: 2, base: 90000, additional_days: 22500 }); // 2 days → 1 extra × 11250 × 2
    expect(output.appliedRules).toEqual([
      { id: additionalDayRule, revision: 1, type: "additional_day", name: "Additional day +25%" },
    ]);
  });

  it("customer pickup: no delivery; tax falls back to the depot location (unconfigured → review)", async () => {
    const { output } = await price(staff(), org, {
      items: [item(castle.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: null,
    });
    expect(output.summary.delivery).toBe(0);
    expect(output.delivery).toEqual({ status: "not_requested" });
    expect(output.reviewReasons).toEqual(["TAX_JURISDICTION_UNRESOLVED"]); // 38127 has no jurisdiction configured
  });

  it("distance lookups are cached in the database per organization", async () => {
    const provider = fakeProvider(12.3);
    const req = {
      items: [item(slide.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: { ...EVENT, line1: "100 Cache Test Ln" },
    };
    await price(staff(), org, req, { provider });
    const second = await price(staff(), org, req, { provider });
    expect(provider.calls).toBe(1);
    expect(second.output.summary.delivery).toBe(3200); // ceil(12.3 − 5) = 8 × $4
  });

  it("provider failure → manual review, never a price", async () => {
    const failing: DistanceProvider = {
      id: "fake-failing",
      version: "1",
      getRoadDistance: () => Promise.resolve({ ok: false, reason: "ADDRESS_NOT_FOUND" }),
    };
    const { output } = await price(
      staff(),
      org,
      {
        items: [item(slide.variantId, june(19, "12:00"), june(19, "16:00"))],
        eventAddress: { ...EVENT, line1: "999 Nowhere" },
      },
      { provider: failing },
    );
    expect(output.summary.delivery).toBe(0);
    expect(output.reviewReasons).toContain("DELIVERY:ADDRESS_NOT_FOUND");
  });

  it("service areas: once configured, unmatched addresses need review; flat areas are used as configured", async () => {
    const areaOrg = await createOrg("pricing-areas");
    const p = await makeProduct(areaOrg, { units: 1 });
    const area = await admin<{ id: string }>(
      "insert into public.service_areas (organization_id, name, pricing, flat_fee_cents) values ($1, 'Germantown flat', 'flat', 3500) returning id",
      [areaOrg.id],
    );
    await admin(
      "insert into public.service_area_rules (organization_id, service_area_id, rule_type, postal_code) values ($1, $2, 'postal_code', '38138')",
      [areaOrg.id, area.rows[0]!.id],
    );
    const inArea = await price(areaOrg.users.office, areaOrg, {
      items: [item(p.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: EVENT,
    });
    expect(inArea.output.delivery).toMatchObject({
      status: "priced",
      method: "flat",
      feeCents: 3500,
      serviceAreaId: area.rows[0]!.id,
      serviceAreaRevision: 1,
    });
    const outside = await price(areaOrg.users.office, areaOrg, {
      items: [item(p.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: { ...EVENT, postalCode: "38017", city: "Collierville" },
    });
    expect(outside.output.reviewReasons).toContain("DELIVERY:OUTSIDE_SERVICE_AREA");
  });
});

describe("quote price stability (snapshots)", () => {
  it("a stored $475 price does not change when the product becomes $525 or rules are edited", async () => {
    const { input, output } = await price(staff(), org, {
      items: [item(castle.variantId, june(19, "12:00"), june(20, "18:00"))],
      eventAddress: EVENT,
    });
    expect(output.summary.base).toBe(47500);
    expect(output.summary.additional_days).toBe(11875); // 25 % of $475
    const id = await record(staff(), org, input, output);
    const before = await admin<{ output: PriceResult; total_cents: string }>(
      "select output, total_cents from public.pricing_calculations where id = $1",
      [id],
    );

    // The business changes its prices afterwards.
    await admin("update public.products set base_price_cents = 52500 where id = $1", [
      castle.productId,
    ]);
    await admin(
      "update public.pricing_rules set params = '{\"percent_of_base_bps\": 3000}' where id = $1",
      [additionalDayRule],
    );

    const after = await admin<{ output: PriceResult; total_cents: string }>(
      "select output, total_cents from public.pricing_calculations where id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]!.output.summary.base).toBe(47500);
    expect(after.rows[0]!.output.appliedRules).toEqual([
      { id: additionalDayRule, revision: 1, type: "additional_day", name: "Additional day +25%" },
    ]);

    // A NEW calculation uses the new price and the new rule revision.
    const fresh = await price(staff(), org, {
      items: [item(castle.variantId, june(19, "12:00"), june(20, "18:00"))],
      eventAddress: EVENT,
    });
    expect(fresh.output.summary).toMatchObject({ base: 52500, additional_days: 15750 });
    expect(fresh.output.appliedRules[0]).toMatchObject({ id: additionalDayRule, revision: 2 });

    // Reproducible: recomputing from the stored input yields the stored output exactly.
    const stored = await admin<{ input: PricingInput; output: PriceResult; input_hash: string }>(
      "select input, output, input_hash from public.pricing_calculations where id = $1",
      [id],
    );
    expect(canonicalJson(calculatePrice(stored.rows[0]!.input))).toBe(
      canonicalJson(stored.rows[0]!.output),
    );
    expect(await sha256(canonicalJson(stored.rows[0]!.input))).toBe(stored.rows[0]!.input_hash);

    await admin("update public.products set base_price_cents = 47500 where id = $1", [
      castle.productId,
    ]);
    await admin(
      "update public.pricing_rules set params = '{\"percent_of_base_bps\": 2500}' where id = $1",
      [additionalDayRule],
    );
  });

  it("stored calculations are immutable for everyone", async () => {
    const { input, output } = await price(staff(), org, {
      items: [item(castle.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: EVENT,
    });
    const id = await record(staff(), org, input, output);
    await expectDenied(
      admin("update public.pricing_calculations set total_cents = 1 where id = $1", [id]),
    );
    await expectDenied(admin("delete from public.pricing_calculations where id = $1", [id]));
    await expectDenied(
      as(org.users.owner, (sql) =>
        sql("update public.pricing_calculations set total_cents = 1 where id = $1", [id]),
      ),
    );
    await expectDenied(
      as(SYSTEM, (sql) =>
        sql("update public.pricing_calculations set total_cents = 1 where id = $1", [id]),
      ),
    );
  });

  it("rule revisions increase on real changes only", async () => {
    const r = await admin<{ id: string }>(
      'insert into public.pricing_rules (organization_id, name, rule_type, params) values ($1, $2, \'fee\', \'{"amount_cents": 500, "per": "order"}\') returning id',
      [org.id, `Fee ${randomUUID().slice(0, 6)}`],
    );
    const id = r.rows[0]!.id;
    await admin("update public.pricing_rules set priority = priority where id = $1", [id]);
    expect(
      (await admin("select revision from public.pricing_rules where id = $1", [id])).rows,
    ).toEqual([{ revision: 1 }]);
    await admin(
      'update public.pricing_rules set params = \'{"amount_cents": 700, "per": "order"}\' where id = $1',
      [id],
    );
    expect(
      (await admin("select revision from public.pricing_rules where id = $1", [id])).rows,
    ).toEqual([{ revision: 2 }]);
    // Revisions cannot be forged: a direct write is ignored by the trigger.
    await as(
      org.users.owner,
      (sql) => sql("update public.pricing_rules set revision = 99 where id = $1", [id]),
      { commit: true },
    );
    expect(
      (await admin("select revision from public.pricing_rules where id = $1", [id])).rows,
    ).toEqual([{ revision: 2 }]);
    await admin("delete from public.pricing_rules where id = $1", [id]);
  });
});

describe("configuration integrity", () => {
  it.each([
    ["extra_hour", "{}"],
    ["overnight", '{"amount_cents": 100, "percent_of_base_bps": 100}'],
    ["attendant_fee", '{"amount_cents": 100, "per": "week"}'],
  ])("rejects malformed %s parameters", async (type, params) => {
    await expectDenied(
      admin(
        "insert into public.pricing_rules (organization_id, name, rule_type, params) values ($1, $2, $3, $4)",
        [org.id, randomUUID(), type, params],
      ),
      ["23514"],
    );
  });

  it("discount codes only on discount rules; cross-tenant scopes rejected", async () => {
    await expectDenied(
      admin(
        "insert into public.pricing_rules (organization_id, name, rule_type, params, discount_code) values ($1, $2, 'fee', '{\"amount_cents\": 1, \"per\": \"order\"}', 'SAVE')",
        [org.id, randomUUID()],
      ),
      ["23514"],
    );
    const other = await createOrg("pricing-scope");
    await expectDenied(
      admin(
        "insert into public.pricing_rules (organization_id, name, rule_type, params, product_id) values ($1, 'x', 'extra_hour', '{\"amount_cents\": 1}', $2)",
        [other.id, slide.productId],
      ),
      ["23503"],
    );
  });

  it("tax: ZIP-specific jurisdictions beat statewide ones; boundary ZIPs are flagged; rates honour validity dates", async () => {
    const taxOrg = await createOrg("pricing-tax");
    const statewide = await admin<{ id: string }>(
      "insert into public.tax_jurisdictions (organization_id, name, state, status) values ($1, 'TN statewide', 'TN', 'active') returning id",
      [taxOrg.id],
    );
    const local = await admin<{ id: string }>(
      "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes, requires_review_postal_codes) values ($1, 'Germantown', 'TN', '{38138,38139}', '{38139}') returning id",
      [taxOrg.id],
    );
    await admin(
      "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps, valid_to) values ($1, $2, 'Old', 900, '2026-12-31'), ($1, $2, 'New', 950, null)",
      [taxOrg.id, local.rows[0]!.id],
    );
    const ctx = async (zip: string, on = "2027-06-19") =>
      (
        await rpc<{
          t: {
            status: string;
            jurisdiction?: { id: string; boundaryReview: boolean };
            rates?: { name: string }[];
          };
        }>(taxOrg.users.owner, "select public.tax_context($1, 'TN', $2, $3) as t", [
          taxOrg.id,
          zip,
          on,
        ])
      )[0]!.t;
    expect((await ctx("38138")).jurisdiction?.id).toBe(local.rows[0]!.id);
    expect((await ctx("38138")).rates?.map((r) => r.name)).toEqual(["New"]);
    expect((await ctx("38138", "2026-10-01")).rates?.map((r) => r.name)).toEqual(["New", "Old"]);
    expect((await ctx("38139")).jurisdiction?.boundaryReview).toBe(true);
    expect((await ctx("37201")).jurisdiction?.id).toBe(statewide.rows[0]!.id);
    const ms = await rpc<{ t: { status: string } }>(
      taxOrg.users.owner,
      "select public.tax_context($1, 'MS', '38654', '2027-06-19') as t",
      [taxOrg.id],
    );
    expect(ms[0]!.t).toEqual({ status: "unresolved" });
  });

  it("distance cache: TTL capped at 30 days; expired entries are ignored", async () => {
    expect(
      await outcome(
        rpc(
          staff(),
          "select public.put_cached_distance($1, 'fake', '1', repeat('c', 64), 100, 31)",
          [org.id],
        ),
      ),
    ).toBe("RA006");
    await admin(
      "insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, fetched_at, expires_at) values ($1, 'fake', '1', repeat('d', 64), 100, now() - interval '2 days', now() - interval '1 day')",
      [org.id],
    );
    expect(
      await rpc(
        staff(),
        "select public.get_cached_distance($1, 'fake', '1', repeat('d', 64)) as m",
        [org.id],
      ),
    ).toEqual([{ m: null }]);
  });
});

describe("tenant isolation and permissions", () => {
  let other: TestOrg;
  beforeAll(async () => {
    other = await createOrg("pricing-other");
  });

  it("another organization cannot read pricing context, tax, areas or the distance cache", async () => {
    for (const [sql, params] of [
      ["select public.pricing_context($1, $2)", [org.id, [slide.variantId]]],
      ["select public.tax_context($1, 'TN', '38138', '2027-06-19')", [org.id]],
      ["select public.delivery_area_context($1, 'Germantown', 'TN', '38138')", [org.id]],
      ["select public.get_cached_distance($1, 'fake', '1', repeat('a', 64))", [org.id]],
      ["select public.put_cached_distance($1, 'fake', '1', repeat('a', 64), 1)", [org.id]],
    ] as const) {
      expect(await outcome(rpc(other.users.owner, sql, [...params]))).toBe("RA005");
    }
  });

  it("another tenant's variant ids return nothing under your own organization id (→ NOT_FOUND in the pipeline)", async () => {
    const ctx = await rpc<{ c: { variants: unknown[] } }>(
      other.users.owner,
      "select public.pricing_context($1, $2) as c",
      [other.id, [slide.variantId]],
    );
    expect(ctx[0]!.c.variants).toEqual([]);
    await expect(
      price(other.users.owner, other, {
        items: [item(slide.variantId, june(19, "12:00"), june(19, "16:00"))],
        eventAddress: EVENT,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("saving calculations needs quotes.write in the same organization", async () => {
    const { input, output } = await price(staff(), org, {
      items: [item(castle.variantId, june(19, "12:00"), june(19, "16:00"))],
      eventAddress: EVENT,
    });
    expect(await outcome(record(org.users.staff, org, input, output))).toBe("RA005");
    expect(await outcome(record(other.users.owner, org, input, output))).toBe("RA005");
    expect(await outcome(record(SYSTEM, org, input, output))).toBe("ok");
    expect(await outcome(record({ kind: "anon" }, org, input, output))).toBe("42501");
  });

  it("only pricing.write (owner/admin) edits pricing, tax and delivery configuration", async () => {
    await expectDenied(
      as(org.users.office, (sql) =>
        sql(
          "insert into public.pricing_rules (organization_id, name, rule_type, params) values ($1, 'x', 'minimum_charge', '{\"amount_cents\": 1}')",
          [org.id],
        ),
      ),
    );
    await expectDenied(
      as(org.users.office, (sql) =>
        sql(
          "insert into public.tax_jurisdictions (organization_id, name, state) values ($1, 'x', 'TN')",
          [org.id],
        ),
      ),
    );
    const ok = await as(org.users.admin, (sql) =>
      sql("insert into public.service_areas (organization_id, name) values ($1, 'Admin area')", [
        org.id,
      ]),
    );
    expect(ok.rowCount).toBe(1);
  });

  it("the public channel cannot price unpublished products or add adjustments", async () => {
    const hidden = await makeProduct(org, { units: 1, published: false });
    await expect(
      price(
        SYSTEM,
        org,
        {
          items: [item(hidden.variantId, june(19, "12:00"), june(19, "16:00"))],
          eventAddress: EVENT,
        },
        { channel: "public" },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      price(
        SYSTEM,
        org,
        {
          items: [item(slide.variantId, june(19, "12:00"), june(19, "16:00"))],
          eventAddress: EVENT,
          adjustments: [{ label: "x", amountCents: -100 }],
        },
        { channel: "public" },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
