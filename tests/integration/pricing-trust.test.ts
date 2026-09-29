import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canonicalJson } from "@/domain/pricing/engine";
import type { PriceResult } from "@/domain/pricing/types";
import { priceForTenant } from "@/server/public/pricing";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { june, makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway, price, sha256 } from "./support/pricing";

/**
 * Hardening H2 (pricing trust boundary), H3 (distance cache) and H5 (service-role boundary).
 * Stored calculations, cached distances and public pricing all flow through code the server
 * controls; a signed-in user or a visitor can only choose items, times, address and codes.
 */
const EVENT = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
let org: TestOrg;
let other: TestOrg;
let slide: { productId: string; variantId: string };
let otherSlide: { productId: string; variantId: string };

const item = (variantId: string) => ({
  variantId,
  quantity: 1,
  start: june(19, "12:00"),
  end: june(19, "16:00"),
});

const tenantOf = (o: TestOrg) =>
  ({
    organizationId: o.id,
    slug: o.slug,
    name: o.slug,
    timezone: "America/Chicago",
  }) as unknown as ResolvedTenant;

const calcCount = async (o: TestOrg) =>
  Number(
    (
      await admin<{ n: string }>(
        "select count(*) as n from public.pricing_calculations where organization_id = $1",
        [o.id],
      )
    ).rows[0]!.n,
  );

beforeAll(async () => {
  org = await createOrg("trust");
  other = await createOrg("trust-other");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
  slide = await makeProduct(org, { units: 1 });
  await admin("update public.products set base_price_cents = 50000 where id = $1", [
    slide.productId,
  ]);
  otherSlide = await makeProduct(other, { units: 1 });
});

describe("H2: a caller cannot forge a $500 calculation into $5", () => {
  const forged = async () => {
    const { input, output } = await price(org.users.office, org, {
      items: [item(slide.variantId)],
      eventAddress: null,
    });
    expect(output.summary.total).toBe(50000);
    const cheap: PriceResult = {
      ...output,
      summary: { ...output.summary, base: 500, subtotal: 500, total: 500 },
      lines: output.lines.map((l) => ({ ...l, amountCents: 500 })),
    };
    return { input, cheap };
  };

  it("no signed-in role can call the calculation writer, whatever it sends", async () => {
    const { input, cheap } = await forged();
    const before = await calcCount(org);
    for (const actor of [org.users.owner, org.users.admin, org.users.office, org.users.staff]) {
      expect(
        await outcome(
          rpc(actor, "select public.record_pricing_calculation($1, $2, $3, $4, $5, 'user', $6)", [
            org.id,
            cheap.engineVersion,
            JSON.stringify(input),
            JSON.stringify(cheap),
            await sha256(canonicalJson(input)),
            actor.id,
          ]),
        ),
      ).toBe("42501");
    }
    expect(
      await outcome(
        rpc(
          { kind: "anon" },
          "select public.record_pricing_calculation($1, 'x', '{}', '{}', repeat('a', 64), 'public')",
          [org.id],
        ),
      ),
    ).toBe("42501");
    expect(await calcCount(org)).toBe(before);
  });

  it("no signed-in role can insert or change calculation rows directly", async () => {
    const { input, cheap } = await forged();
    for (const actor of [org.users.owner, org.users.office]) {
      await expectDenied(
        as(actor, (sql) =>
          sql(
            `insert into public.pricing_calculations (organization_id, engine_version, input, output, input_hash, currency, total_cents, manual_review_required, created_by_type)
             values ($1, $2, $3, $4, repeat('a', 64), 'USD', 500, false, 'user')`,
            [org.id, cheap.engineVersion, JSON.stringify(input), JSON.stringify(cheap)],
          ),
        ),
      );
    }
  });

  it("the pricing request rejects any price, total, engine version or organization it carries", async () => {
    for (const extra of [
      { total: 500 },
      { summary: { total: 500 } },
      { engineVersion: "fake" },
      { organizationId: other.id },
      { inputHash: "a".repeat(64) },
    ]) {
      await expect(
        price(org.users.office, org, {
          items: [item(slide.variantId)],
          eventAddress: null,
          ...extra,
        }),
      ).rejects.toBeInstanceOf(ZodError);
    }
    await expect(
      price(org.users.office, org, {
        items: [{ ...item(slide.variantId), basePriceCents: 500 }],
        eventAddress: null,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      price(org.users.office, org, {
        items: [item(slide.variantId)],
        eventAddress: { ...EVENT, deliveryCents: 0 },
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("what gets stored is what the server computed from the database ($500), attributed to the session user", async () => {
    const { calculationId } = await price(
      org.users.office,
      org,
      { items: [item(slide.variantId)], eventAddress: null },
      { save: true },
    );
    const row = await admin<{ total_cents: string; created_by: string; created_by_type: string }>(
      "select total_cents, created_by, created_by_type from public.pricing_calculations where id = $1",
      [calculationId],
    );
    expect(row.rows[0]).toEqual({
      total_cents: "50000",
      created_by: org.users.office.id,
      created_by_type: "user",
    });
  });

  it("even the server cannot store an internally inconsistent calculation or a non-member actor", async () => {
    const { input, output } = await price(org.users.office, org, {
      items: [item(slide.variantId)],
      eventAddress: null,
    });
    const store = (out: unknown, ver: string, type = "system", by: string | null = null) =>
      outcome(
        rpc(SYSTEM, "select public.record_pricing_calculation($1, $2, $3, $4, $5, $6, $7)", [
          org.id,
          ver,
          JSON.stringify(input),
          JSON.stringify(out),
          "a".repeat(64),
          type,
          by,
        ]),
      );
    const badTotal = { ...output, summary: { ...output.summary, total: 500 } };
    expect(await store(badTotal, output.engineVersion)).toBe("RA006");
    expect(await store(output, "some-other-engine")).toBe("RA006");
    expect(await store({ ...output, currency: "EUR" }, output.engineVersion)).toBe("RA006");
    expect(await store(output, output.engineVersion, "user", other.users.owner.id)).toBe("RA006");
    expect(await store(output, output.engineVersion, "user", null)).toBe("RA006");
    expect(await store(output, output.engineVersion)).toBe("ok");
  });

  it("manual adjustments need a reason, are stamped with the verified staff member, and are audited", async () => {
    await expect(
      price(org.users.office, org, {
        items: [item(slide.variantId)],
        eventAddress: null,
        adjustments: [{ label: "Goodwill", amountCents: -2500 }],
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const { input, output, calculationId } = await price(
      org.users.office,
      org,
      {
        items: [item(slide.variantId)],
        eventAddress: null,
        adjustments: [{ label: "Goodwill", amountCents: -2500, reason: "Late delivery last time" }],
      },
      { save: true },
    );
    expect(input.adjustments).toEqual([
      {
        label: "Goodwill",
        amountCents: -2500,
        reason: "Late delivery last time",
        authorizedBy: org.users.office.id,
      },
    ]);
    expect(output.summary.total).toBe(47500); // the engine re-ran with the adjustment
    const audit = await admin<{ actor_type: string; actor_user_id: string; changes: unknown }>(
      "select actor_type, actor_user_id, changes from public.audit_logs where organization_id = $1 and action = 'pricing.adjusted' and entity_id = $2",
      [org.id, calculationId],
    );
    expect(audit.rows).toEqual([
      {
        actor_type: "user",
        actor_user_id: org.users.office.id,
        changes: {
          adjustments: [
            { label: "Goodwill", amountCents: -2500, reason: "Late delivery last time" },
          ],
          totalCents: 47500,
        },
      },
    ]);
  });

  it("adjustments without a verified staff member are refused (system/public contexts)", async () => {
    await expect(
      price(SYSTEM, org, {
        items: [item(slide.variantId)],
        eventAddress: null,
        adjustments: [{ label: "x", amountCents: -100, reason: "because" }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("H3: only trusted server code writes the distance cache", () => {
  const put = "select public.put_cached_distance($1, 'fake', '1', repeat('e', 64), 1609)";

  it("read-only staff (and every other member) cannot write through the function", async () => {
    for (const actor of [org.users.staff, org.users.office, org.users.admin, org.users.owner]) {
      expect(await outcome(rpc(actor, put, [org.id]))).toBe("42501");
    }
    expect(await outcome(rpc({ kind: "anon" }, put, [org.id]))).toBe("42501");
  });

  it("read-only staff cannot insert, modify or delete cached distances directly", async () => {
    await admin(
      "insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, expires_at) values ($1, 'fake', '1', repeat('f', 64), 1000, now() + interval '1 day')",
      [org.id],
    );
    const s = org.users.staff;
    await expectDenied(
      as(s, (sql) =>
        sql(
          "insert into public.delivery_distance_cache (organization_id, provider, provider_version, route_key, meters, expires_at) values ($1, 'fake', '1', repeat('9', 64), 1, now() + interval '1 day')",
          [org.id],
        ),
      ),
    );
    await expectDenied(
      as(s, (sql) =>
        sql("update public.delivery_distance_cache set meters = 1 where organization_id = $1", [
          org.id,
        ]),
      ),
    );
    await expectDenied(
      as(s, (sql) =>
        sql("delete from public.delivery_distance_cache where organization_id = $1", [org.id]),
      ),
    );
    const stillThere = await admin<{ meters: number }>(
      "select meters from public.delivery_distance_cache where organization_id = $1 and route_key = repeat('f', 64)",
      [org.id],
    );
    expect(stillThere.rows).toEqual([{ meters: 1000 }]);
  });

  it("members can still read their own organization's cache; the server can write it", async () => {
    expect(await outcome(rpc(SYSTEM, put, [org.id]))).toBe("ok");
    expect(
      await rpc(
        org.users.staff,
        "select public.get_cached_distance($1, 'fake', '1', repeat('e', 64)) as m",
        [org.id],
      ),
    ).toEqual([{ m: 1609 }]);
  });

  it("pricing as a staff member caches through the trusted gateway, not the staff session", async () => {
    const gateway = pgGateway();
    await price(
      org.users.staff,
      org,
      { items: [item(slide.variantId)], eventAddress: { ...EVENT, line1: "77 Cache Test Rd" } },
      { gateway, provider: fakeProvider(7) },
    );
    expect(gateway.calls).toContain("put_cached_distance");
  });
});

describe("H5: public pricing is pinned to the server-resolved tenant", () => {
  const deps = (keys: string[] = []) => {
    const gateway = pgGateway();
    return {
      gateway,
      keys,
      rateLimit: (policy: string, key: string) => {
        keys.push(`${policy}:${key}`);
        return Promise.resolve();
      },
      provider: fakeProvider(3),
    };
  };
  const meta = { ip: "203.0.113.7", requestId: "req-1" };

  it("another tenant's product is NOT_FOUND through this tenant's storefront", async () => {
    const d = deps();
    await expect(
      priceForTenant(
        tenantOf(org),
        { items: [item(otherSlide.variantId)], eventAddress: null },
        meta,
        {},
        d,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("an organization id (or any unknown key) in the body is rejected, not honoured", async () => {
    const d = deps();
    await expect(
      priceForTenant(
        tenantOf(org),
        { organizationId: other.id, items: [item(otherSlide.variantId)], eventAddress: null },
        meta,
        {},
        d,
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(d.gateway.calls).toEqual([]);
  });

  it("visitors cannot send adjustments", async () => {
    await expect(
      priceForTenant(
        tenantOf(org),
        {
          items: [item(slide.variantId)],
          eventAddress: null,
          adjustments: [{ label: "x", amountCents: -49000, reason: "please" }],
        },
        meta,
        {},
        deps(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("is rate limited per tenant + client before touching the database", async () => {
    const d = deps();
    const blocked = {
      ...d,
      rateLimit: () =>
        Promise.reject(Object.assign(new Error("RATE_LIMITED"), { code: "RATE_LIMITED" })),
    };
    await expect(
      priceForTenant(
        tenantOf(org),
        { items: [item(slide.variantId)], eventAddress: null },
        meta,
        {},
        blocked,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(d.gateway.calls).toEqual([]);

    await priceForTenant(
      tenantOf(org),
      { items: [item(slide.variantId)], eventAddress: null },
      meta,
      {},
      d,
    );
    expect(d.keys).toEqual([`publicQuery:${org.id}:203.0.113.7`]);
  });

  it("a saved public calculation belongs to the tenant, is attributed to 'public', and is audited", async () => {
    const d = deps();
    const run = await priceForTenant(
      tenantOf(org),
      { items: [item(slide.variantId)], eventAddress: null },
      meta,
      { save: true },
      d,
    );
    const row = await admin<{
      organization_id: string;
      created_by_type: string;
      total_cents: string;
    }>(
      "select organization_id, created_by_type, total_cents from public.pricing_calculations where id = $1",
      [run.calculationId],
    );
    expect(row.rows[0]).toEqual({
      organization_id: org.id,
      created_by_type: "public",
      total_cents: "50000",
    });
    const audit = await admin<{ actor_type: string; ip_address: string; request_id: string }>(
      "select actor_type, host(ip_address) as ip_address, request_id from public.audit_logs where entity_id = $1 and action = 'pricing.calculated'",
      [run.calculationId],
    );
    expect(audit.rows).toEqual([
      { actor_type: "public", ip_address: "203.0.113.7", request_id: "req-1" },
    ]);
    // Only the explicit gateway operations were used.
    expect(new Set(d.gateway.calls)).toEqual(
      new Set(["pricing_context", "tax_context", "record_pricing_calculation", "audit"]),
    );
  });

  it("the public channel never prices unpublished products", async () => {
    const hidden = await makeProduct(org, { units: 1, published: false });
    await expect(
      priceForTenant(
        tenantOf(org),
        { items: [item(hidden.variantId)], eventAddress: null },
        meta,
        {},
        deps(),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("availability paths used by public flows refuse another tenant's variant", async () => {
    // Anonymous storefront check (anon role, no service key involved).
    expect(
      await outcome(
        rpc({ kind: "anon" }, "select * from public.check_public_availability($1, $2, $3, $4, 1)", [
          org.id,
          otherSlide.variantId,
          june(19, "12:00"),
          june(19, "16:00"),
        ]),
      ),
    ).toBe("RA005");
    // A hold made by the server for a visitor of this tenant.
    expect(
      await outcome(
        rpc(SYSTEM, "select public.reserve_inventory($1, $2::jsonb)", [
          org.id,
          JSON.stringify([
            {
              variant_id: otherSlide.variantId,
              quantity: 1,
              start: june(19, "12:00"),
              end: june(19, "16:00"),
            },
          ]),
        ]),
      ),
    ).toBe("RA005");
    // The system context may only create holds, never confirmed bookings.
    expect(
      await outcome(
        rpc(SYSTEM, "select public.reserve_inventory($1, $2::jsonb, 'confirmed')", [
          org.id,
          JSON.stringify([
            {
              variant_id: slide.variantId,
              quantity: 1,
              start: june(19, "12:00"),
              end: june(19, "16:00"),
            },
          ]),
        ]),
      ),
    ).toBe("RA006");
  });
});

describe("Codex re-review blocker 3: pricing inputs are client-chosen or server-authoritative, never both", () => {
  // CLIENT-PROVIDED: variant ids, quantities, times, event address (or pickup), discount codes.
  // SERVER-AUTHORITATIVE: everything else — loaded from the database after tenant resolution.
  let addonOrg: TestOrg;
  let castle: { productId: string; variantId: string };
  let generator: { productId: string; variantId: string };

  beforeAll(async () => {
    addonOrg = await createOrg("authority");
    await admin(
      `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
         primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
       where organization_id = $1`,
      [addonOrg.id],
    );
    castle = await makeProduct(addonOrg, { units: 1 });
    generator = await makeProduct(addonOrg, { units: 1 });
    await admin("update public.products set base_price_cents = 30000 where id = $1", [
      castle.productId,
    ]);
    await admin("update public.products set base_price_cents = 5000 where id = $1", [
      generator.productId,
    ]);
    // The catalog says: the generator is an add-on of the castle.
    await admin(
      "insert into public.product_relations (organization_id, product_id, related_product_id, relation_type) values ($1, $2, $3, 'addon')",
      [addonOrg.id, castle.productId, generator.productId],
    );
    // A (test) jurisdiction where rentals are taxable but add-ons are not.
    const j = await admin<{ id: string }>(
      "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes) values ($1, 'Test', 'TN', '{38127}') returning id",
      [addonOrg.id],
    );
    await admin(
      "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'Test rate', 1000)",
      [addonOrg.id, j.rows[0]!.id],
    );
    await admin(
      "insert into public.tax_component_rules (organization_id, jurisdiction_id, component, taxable) select $1, $2, c, c <> 'add_on' from unnest(enum_range(null::public.tax_component)) c",
      [addonOrg.id, j.rows[0]!.id],
    );
  });

  const it1 = (variantId: string, extra: Record<string, unknown> = {}) => ({
    ...item(variantId),
    ...extra,
  });

  it("a caller cannot relabel a rental as an 'add-on' to change its tax treatment", async () => {
    await expect(
      price(addonOrg.users.office, addonOrg, {
        items: [it1(castle.variantId, { kind: "add_on" })],
        eventAddress: null,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      priceForTenant(
        tenantOf(addonOrg),
        { items: [it1(castle.variantId, { kind: "add_on" })], eventAddress: null },
        { ip: "203.0.113.9" },
        {},
        { gateway: pgGateway(), rateLimit: () => Promise.resolve(), provider: null },
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("add-on status comes from the catalog: the generator is an add-on only alongside the castle", async () => {
    const both = await price(addonOrg.users.office, addonOrg, {
      items: [item(castle.variantId), item(generator.variantId)],
      eventAddress: null,
    });
    expect(both.input.items.map((i) => i.kind)).toEqual(["rental", "add_on"]);
    expect(both.output.summary).toMatchObject({
      base: 30000,
      add_ons: 5000,
      taxable_subtotal: 30000,
      tax: 3000,
    });

    const alone = await price(addonOrg.users.office, addonOrg, {
      items: [item(generator.variantId)],
      eventAddress: null,
    });
    expect(alone.input.items.map((i) => i.kind)).toEqual(["rental"]);
    expect(alone.output.summary).toMatchObject({ taxable_subtotal: 5000, tax: 500 });
  });

  const REJECTED: [string, Record<string, unknown>, Record<string, unknown>?][] = [
    ["change the base price", {}, { basePriceCents: 1 }],
    ["change the base price (top level)", { basePriceCents: 1 }],
    ["change the delivery rate", { delivery: { perMileRateCents: 0 } }],
    ["change free miles", { freeDeliveryMiles: 1000 }],
    ["pass a delivery result", { deliveryCents: 0 }],
    ["change the tax rate", { tax: { status: "resolved", rates: [{ rateBps: 0 }] } }],
    ["change taxability", { taxability: { rental: false } }],
    ["substitute another organization", { organizationId: "00000000-0000-0000-0000-000000000000" }],
    [
      "substitute another organization (in an item)",
      {},
      { organizationId: "00000000-0000-0000-0000-000000000000" },
    ],
    [
      "inject a pricing rule",
      { rules: [{ type: "discount_percent", params: { percent_bps: 10000 } }] },
    ],
    ["set the engine version", { engineVersion: "0.0.0" }],
    ["set rule revisions", { appliedRules: [] }],
    ["alter the included duration", {}, { includedDurationMinutes: 100000 }],
    ["allow overnight", {}, { overnightAllowed: true }],
    ["remove attendants", {}, { attendantsRequired: 0 }],
    ["rename the product", {}, { name: "Free castle" }],
    ["set the currency", { currency: "JPY" }],
    ["set the time zone", { timeZone: "Pacific/Kiritimati" }],
    ["choose the multi-day strategy", { multiDayBilling: "rolling_24h" }],
    ["send a geocoded distance with the address", {}, undefined],
  ];

  it.each(REJECTED)("a caller cannot %s", async (_what, top, inItem) => {
    const request =
      _what === "send a geocoded distance with the address"
        ? { items: [item(castle.variantId)], eventAddress: { ...EVENT, distanceMiles: 0 } }
        : { items: [it1(castle.variantId, inItem ?? {})], eventAddress: null, ...top };
    await expect(price(addonOrg.users.office, addonOrg, request)).rejects.toBeInstanceOf(ZodError);
    const gateway = pgGateway();
    await expect(
      priceForTenant(
        tenantOf(addonOrg),
        request,
        { ip: "203.0.113.9" },
        {},
        {
          gateway,
          rateLimit: () => Promise.resolve(),
          provider: null,
        },
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(gateway.calls).toEqual([]); // rejected before any trusted data was read
  });

  it("every server-authoritative value in the stored input equals the database, not the request", async () => {
    const { input } = await price(addonOrg.users.office, addonOrg, {
      items: [item(castle.variantId)],
      eventAddress: null,
    });
    const db = await admin<{ price: string; tz: string; cur: string }>(
      `select p.base_price_cents as price, o.timezone as tz, o.currency as cur
       from public.products p join public.organizations o on o.id = p.organization_id where p.id = $1`,
      [castle.productId],
    );
    expect(input.items[0]).toMatchObject({ basePriceCents: Number(db.rows[0]!.price) });
    expect(input.timeZone).toBe(db.rows[0]!.tz);
    expect(input.currency).toBe(db.rows[0]!.cur);
  });
});
