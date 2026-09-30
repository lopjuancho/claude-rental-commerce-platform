import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { type AssistantState, emptyState, type ToolContext } from "@/server/ai/context";
import { Deadline } from "@/server/ai/deadline";
import { directJournal } from "@/server/ai/journal";
import { executeTool, quoteRelation } from "@/server/ai/tools";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken } from "@/server/visitor";
import { makeProduct, rpc } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * M7 assistant tools through the real backend, without a model (ADR 0017 §3): every tool is an
 * adapter over the M3–M6 services, scoped to the server-resolved tenant.
 */
let a: TestOrg;
let b: TestOrg;
const fx = {} as {
  slide: { productId: string; variantId: string };
  castle: { productId: string; variantId: string };
  hidden: { productId: string; variantId: string };
  bProduct: { productId: string; variantId: string };
  slidesCategory: string;
};
const ADDRESS = { line1: "100 Main St", city: "Memphis", state: "TN", postalCode: "38127" };
const OUTSIDE = { line1: "1 Far Rd", city: "Nashville", state: "TN", postalCode: "37201" };
let day = 1;
/** A fresh future Saturday-ish date per call (no cross-test capacity interference). */
const nextDate = () => new Date(Date.UTC(2027, 5, day++ * 2)).toISOString().slice(0, 10);

const tenantOf = (org: TestOrg) =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: org.slug,
    timezone: "America/Chicago",
    currency: "USD",
    resolvedBy: "host",
  }) as unknown as ResolvedTenant;

function ctxFor(
  org: TestOrg,
  opts: { state?: AssistantState; visitorToken?: string | null; miles?: number | null } = {},
): ToolContext {
  const state = opts.state ?? emptyState();
  return {
    tenant: tenantOf(org),
    meta: {
      ip: "198.51.100.77",
      actor: "ai",
      ...(opts.visitorToken === null
        ? {}
        : { visitorToken: opts.visitorToken ?? generateVisitorToken() }),
    },
    state,
    deps: {
      gateway: pgGateway(),
      rateLimit: () => Promise.resolve(),
      provider: opts.miles === null ? null : fakeProvider(opts.miles ?? 3),
    },
    now: () => new Date(),
    deadline: Deadline.in(60_000),
    journal: directJournal(state),
  };
}
const run = (ctx: ToolContext, name: string, args: unknown) =>
  executeTool(name, JSON.stringify(args), ctx, (e) => {
    throw e;
  });

async function product(org: TestOrg, slug: string, fields: Record<string, unknown>, units = 1) {
  const p = await makeProduct(org, { units });
  const sets = Object.keys(fields).map((k, i) => `${k} = $${String(i + 2)}`);
  await admin(`update public.products set slug = '${slug}', ${sets.join(", ")} where id = $1`, [
    p.productId,
    ...Object.values(fields),
  ]);
  return p;
}

beforeAll(async () => {
  a = await createOrg("ai-a");
  b = await createOrg("ai-b");
  for (const org of [a, b]) {
    await admin(
      `update public.organization_settings set primary_depot_address_line1 = '1 Depot Rd', primary_depot_city = 'Memphis',
         primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
       where organization_id = $1`,
      [org.id],
    );
    // An ACTIVE tax jurisdiction for the event ZIP (test-status rules would always need review).
    const j = await admin<{ id: string }>(
      "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes, status) values ($1, 'Memphis', 'TN', '{38127}', 'active') returning id",
      [org.id],
    );
    await admin(
      "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'Sales tax', 1000)",
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
  }
  const cat = await admin<{ id: string }>(
    "insert into public.categories (organization_id, name, slug, included_duration_minutes) values ($1, 'Water Slides', 'water-slides', 240) returning id",
    [a.id],
  );
  fx.slidesCategory = cat.rows[0]!.id;
  fx.slide = await product(a, "mega-slide", {
    name: "Mega Slide",
    short_description: "A tall dual-lane slide.",
    base_price_cents: 30000,
    wet_allowed: true,
    dry_allowed: true,
    recommended_capacity: 40,
    ideal_event_types: "{school}",
    primary_category_id: fx.slidesCategory,
    internal_notes: "SECRET MARGIN NOTE",
  });
  await admin(
    "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
    [a.id, fx.slide.productId, fx.slidesCategory],
  );
  fx.castle = await product(a, "tiny-castle", {
    name: "Tiny Castle",
    base_price_cents: 15000,
    recommended_capacity: 6,
    included_duration_minutes: 240,
  });
  fx.hidden = await product(a, "secret-prototype", {
    name: "Secret Prototype",
    is_published: false,
  });
  fx.bProduct = await product(b, "b-slide", { name: "B Slide", base_price_cents: 99900 });
  // Weather sensitivity for the slide (a confirmed wind block makes it unavailable).
  await admin(
    "insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive, threshold_value, threshold_unit) values ($1, $2, 'wind', true, 20, 'mph')",
    [a.id, fx.slide.productId],
  );
  // A configured service area (ZIP 38127 only): other ZIPs are outside it.
  const area = await admin<{ id: string }>(
    "insert into public.service_areas (organization_id, name, pricing) values ($1, 'Memphis', 'mileage') returning id",
    [a.id],
  );
  await admin(
    "insert into public.service_area_rules (organization_id, service_area_id, rule_type, postal_code) values ($1, $2, 'postal_code', '38127')",
    [a.id, area.rows[0]!.id],
  );
}, 120_000);

const window = (date: string, startTime = "12:00", endTime = "16:00") => ({
  date,
  startTime,
  endTime,
});

describeRest("read-only tools", () => {
  it("search_products finds published products by words, category and structured needs", async () => {
    const ctx = ctxFor(a);
    const bySlide = await run(ctx, "search_products", { query: "water slides for a school" });
    expect(bySlide.status).toBe("ok");
    expect((bySlide.result.products as { slug: string }[]).map((p) => p.slug)).toEqual([
      "mega-slide",
    ]);
    expect(bySlide.blocks[0]).toMatchObject({
      type: "products",
      products: [
        { slug: "mega-slide", url: "/rentals/mega-slide", fromPrice: "From $300 per event" },
      ],
    });
    const big = await run(ctx, "search_products", { minCapacity: 30 });
    expect((big.result.products as { slug: string }[]).map((p) => p.slug)).toEqual(["mega-slide"]);
    const school = await run(ctx, "search_products", { eventType: "school" });
    expect((school.result.products as { slug: string }[]).map((p) => p.slug)).toEqual([
      "mega-slide",
    ]);
  });

  it("never returns unpublished products, other tenants' products or internal fields", async () => {
    const ctx = ctxFor(a);
    const all = await run(ctx, "search_products", { limit: 8 });
    const json = JSON.stringify(all);
    expect(json).not.toContain("secret-prototype");
    expect(json).not.toContain("b-slide");
    expect(json).not.toContain("SECRET MARGIN NOTE");
    expect(json).not.toContain("internal");
    expect(json).not.toContain(a.id);
  });

  it("free text cannot reach the query syntax (filter injection is just words)", async () => {
    const res = await run(ctxFor(a), "search_products", {
      query: `slide),organization_id.eq.${b.id},name.ilike.*`,
    });
    expect(res.status).toBe("ok");
    expect(JSON.stringify(res)).not.toContain("b-slide");
  });

  it("get_product_details returns configured facts and bookable options; foreign/unpublished → not found", async () => {
    const ok = await run(ctxFor(a), "get_product_details", { productSlug: "mega-slide" });
    expect(ok.result).toMatchObject({
      name: "Mega Slide",
      recommendedCapacity: 40,
      wetUse: true,
      options: [{ variantId: fx.slide.variantId, startingPrice: "$300.00" }],
    });
    expect(JSON.stringify(ok.result)).not.toContain("SECRET");
    for (const slug of ["secret-prototype", "b-slide", "does-not-exist"]) {
      const r = await run(ctxFor(a), "get_product_details", { productSlug: slug });
      expect(r).toMatchObject({ status: "rejected_validation", errorCode: "NOT_FOUND" });
    }
  });
});

describeRest("availability, pricing and service area", () => {
  it("check_availability: available, not enough units, bad times, forged variant", async () => {
    const date = nextDate();
    const ok = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      quantity: 1,
      ...window(date),
    });
    expect(ok.result).toMatchObject({ availability: "available", product: "Mega Slide" });
    expect(ok.blocks[0]).toMatchObject({ type: "availability", status: "available" });
    const tooMany = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      quantity: 5,
      ...window(date),
    });
    expect(tooMany.result).toMatchObject({ availability: "unavailable" });
    const past = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      quantity: 1,
      ...window("2020-01-04"),
    });
    expect(past.errorCode).toBe("PAST_DATE");
    // 02:30 does not exist on the spring-forward night in Chicago.
    const gap = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      quantity: 1,
      ...window("2027-03-14", "02:30", "05:00"),
    });
    expect(gap).toMatchObject({ status: "rejected_validation", errorCode: "INVALID_TIME" });
    const forged = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      variantId: fx.bProduct.variantId,
      quantity: 1,
      ...window(date),
    });
    expect(forged.errorCode).toBe("NOT_FOUND");
  });

  it("a confirmed weather block makes the item unavailable, with the weather reason", async () => {
    const date = nextDate();
    const id = await as(
      a.users.office,
      async (sql) =>
        (
          await sql<{ id: string }>(
            `insert into public.weather_blocks (organization_id, hazard, period, scope, reason, observed_value, observed_unit)
             values ($1, 'wind', tstzrange(($2::date)::timestamptz - interval '1 day', ($2::date)::timestamptz + interval '2 days'), 'all_sensitive', 'Forecast', 30, 'mph') returning id`,
            [a.id, date],
          )
        ).rows[0]!.id,
      { commit: true },
    );
    await rpc(a.users.office, "select public.confirm_weather_block($1)", [id]);
    const res = await run(ctxFor(a), "check_availability", {
      productSlug: "mega-slide",
      quantity: 1,
      ...window(date),
    });
    expect(res.result).toMatchObject({ availability: "unavailable" });
    expect(res.result.reasons).toContain(
      "A weather safety block is in effect for this item at that time.",
    );
    expect(res.result.weather).toMatch(/Do not promise/);
    await rpc(a.users.office, "select public.lift_weather_block($1)", [id]);
  });

  it("calculate_price returns the engine's breakdown (pickup and delivery)", async () => {
    const date = nextDate();
    const pickup = await run(ctxFor(a), "calculate_price", {
      items: [{ productSlug: "mega-slide", quantity: 1 }],
      ...window(date),
      fulfillment: "pickup",
    });
    // Pickup: tax uses the depot ZIP (38127, active 10%).
    expect(pickup.result).toMatchObject({
      pricing: "priced",
      subtotal: "$300.00",
      total: "$330.00",
    });
    const delivered = await run(ctxFor(a, { miles: 8.2 }), "calculate_price", {
      items: [{ productSlug: "mega-slide", quantity: 1 }],
      ...window(date),
      fulfillment: "delivery",
      address: ADDRESS,
    });
    expect(delivered.result).toMatchObject({ pricing: "priced" });
    expect(JSON.stringify(delivered.result.lines)).toMatch(/Delivery/);
  });

  it("unresolved configuration is manual review with NO amounts", async () => {
    const res = await run(ctxFor(a, { miles: null }), "calculate_price", {
      items: [{ productSlug: "mega-slide", quantity: 1 }],
      ...window(nextDate()),
      fulfillment: "delivery",
      address: ADDRESS,
    });
    expect(res.status).toBe("manual_review");
    expect(res.result).toMatchObject({ pricing: "manual_review" });
    expect(JSON.stringify(res.result)).not.toMatch(/\$\d/);
    expect(res.blocks[0]).toMatchObject({ type: "price", status: "manual_review", total: null });
  });

  it("calculate_price rejects foreign products and supplied prices", async () => {
    const foreign = await run(ctxFor(a), "calculate_price", {
      items: [{ productSlug: "b-slide", quantity: 1 }],
      ...window(nextDate()),
      fulfillment: "pickup",
    });
    expect(foreign.errorCode).toBe("NOT_FOUND");
    const priced = await run(ctxFor(a), "calculate_price", {
      items: [{ productSlug: "mega-slide", quantity: 1, priceCents: 1 }],
      ...window(nextDate()),
      fulfillment: "pickup",
    });
    expect(priced).toMatchObject({ status: "rejected_policy", errorCode: "FORBIDDEN_ARGUMENT" });
  });

  it("check_service_area: serviceable, outside the area, and unresolved", async () => {
    const inside = await run(ctxFor(a, { miles: 8.2 }), "check_service_area", { address: ADDRESS });
    expect(inside.result).toMatchObject({ serviceArea: "serviceable" });
    expect(inside.result.deliveryFee).toMatch(/^\$/);
    const outside = await run(ctxFor(a), "check_service_area", { address: OUTSIDE });
    expect(outside.result).toMatchObject({ serviceArea: "outside_service_area" });
    const unresolved = await run(ctxFor(a, { miles: null }), "check_service_area", {
      address: ADDRESS,
    });
    expect(unresolved.result).toMatchObject({ serviceArea: "manual_review" });
  });
});

describeRest("customer, event, quote and booking (the M5 public path)", () => {
  async function readyCtx(org: TestOrg, opts: Parameters<typeof ctxFor>[1] = {}) {
    const ctx = ctxFor(org, opts);
    expect(
      (
        await run(ctx, "create_customer", {
          firstName: "Ana",
          email: `ai-${randomUUID().slice(0, 8)}@example.test`,
        })
      ).status,
    ).toBe("ok");
    expect(
      (
        await run(ctx, "create_event", {
          ...window(nextDate()),
          fulfillment: "pickup",
          eventType: "school",
        })
      ).status,
    ).toBe("ok");
    return ctx;
  }

  it("create_customer and create_event validate and only stage (no database rows yet)", async () => {
    const ctx = ctxFor(a);
    const bad = await run(ctx, "create_customer", { firstName: "Ana" });
    expect(bad).toMatchObject({ status: "rejected_validation", errorCode: "INVALID_CONTACT" });
    const email = `stage-${randomUUID().slice(0, 8)}@example.test`;
    expect((await run(ctx, "create_customer", { email })).status).toBe("ok");
    expect((await admin("select 1 from public.customers where email = $1", [email])).rowCount).toBe(
      0,
    );
    const noAddress = await run(ctx, "create_event", {
      ...window(nextDate()),
      fulfillment: "delivery",
    });
    expect(noAddress.status).toBe("rejected_validation");
    const ambiguous = await run(ctx, "create_event", {
      ...window("2027-11-07", "01:30", "03:00"),
      fulfillment: "pickup",
    });
    expect(ambiguous.errorCode).toBe("AMBIGUOUS_TIME");
  });

  it("create_quote needs contact, event and items, then creates a real assistant quote", async () => {
    const empty = ctxFor(a);
    const missing = await run(empty, "create_quote", {});
    expect(missing).toMatchObject({ status: "rejected_validation", errorCode: "MISSING_DETAILS" });

    const ctx = await readyCtx(a);
    const res = await run(ctx, "create_quote", {
      items: [{ productSlug: "mega-slide", quantity: 1 }],
    });
    expect(res.status).toBe("ok");
    expect(res.result).toMatchObject({
      quote: "created",
      priceIsFinal: true,
      total: "$330.00",
      canRequestBooking: true,
    });
    const block = res.blocks[0] as { type: string; url: string; quoteNumber: string };
    expect(block).toMatchObject({ type: "quote", quoteNumber: res.result.quoteNumber });
    // The raw token reaches the customer's card only — never the model's result or the state.
    const token = block.url.replace("/q/", "");
    expect(JSON.stringify(res.result)).not.toContain(token);
    expect(JSON.stringify(ctx.state)).not.toContain(token);
    expect(ctx.state.quote?.tokenHash).toBe(await hashQuoteToken(token));
    const row = await admin<{ source: string; organization_id: string; total_cents: string }>(
      "select source, organization_id, total_cents::text from public.quotes where token_hash = $1",
      [ctx.state.quote!.tokenHash],
    );
    expect(row.rows[0]).toMatchObject({
      source: "assistant",
      organization_id: a.id,
      total_cents: "33000",
    });
    // Asking again with nothing changed returns the same quote; nothing new is created.
    const again = await run(ctx, "create_quote", {});
    expect(again.result).toMatchObject({ quote: "existing", quoteNumber: res.result.quoteNumber });
    const mine = await admin(
      "select 1 from public.quotes where organization_id = $1 and customer_id = (select customer_id from public.quotes where token_hash = $2)",
      [a.id, ctx.state.quote!.tokenHash],
    );
    expect(mine.rowCount).toBe(1);
  });

  it("customer duplicate protection: an existing customer is matched, never overwritten or disclosed", async () => {
    const email = `existing-${randomUUID().slice(0, 8)}@example.test`;
    await admin(
      "insert into public.customers (organization_id, first_name, last_name, email, source) values ($1, 'Real', 'Owner', $2, 'web')",
      [a.id, email],
    );
    const ctx = ctxFor(a);
    const staged = await run(ctx, "create_customer", {
      firstName: "Attacker",
      lastName: "Guess",
      email,
    });
    expect(JSON.stringify(staged.result)).not.toMatch(/Real|Owner|exist/);
    await run(ctx, "create_event", { ...window(nextDate()), fulfillment: "pickup" });
    const res = await run(ctx, "create_quote", {
      items: [{ productSlug: "tiny-castle", quantity: 1 }],
    });
    expect(JSON.stringify(res)).not.toMatch(/Real|Owner/);
    const c = await admin<{ first_name: string; last_name: string; n: number }>(
      "select first_name, last_name, (select count(*)::int from public.customers where organization_id = $1 and email = $2) n from public.customers where organization_id = $1 and email = $2",
      [a.id, email],
    );
    expect(c.rows[0]).toMatchObject({ first_name: "Real", last_name: "Owner", n: 1 });
  });

  it("add_quote_item stages before a quote and re-quotes after; refused once a booking was requested", async () => {
    const ctx = await readyCtx(a);
    const staged = await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 1 });
    expect(staged.result).toMatchObject({ staged: "added" });
    const first = await run(ctx, "create_quote", {});
    const firstNumber = first.result.quoteNumber as string;
    const replaced = await run(ctx, "add_quote_item", { productSlug: "mega-slide", quantity: 1 });
    expect(replaced.result).toMatchObject({ quote: "replaced", replaces: firstNumber });
    expect(replaced.result.quoteNumber).not.toBe(firstNumber);
    expect((replaced.result.items as unknown[]).length).toBe(2);
    const booked = await run(ctx, "request_booking", {});
    expect(booked.result).toMatchObject({ booking: "hold_placed" });
    const refused = await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 1 });
    expect(refused.errorCode).toBe("QUOTE_NOT_EDITABLE");
  });

  it("request_booking places the M5 hold (15 minutes) and the database agrees; never confirms", async () => {
    const ctx = await readyCtx(a);
    await run(ctx, "create_quote", { items: [{ productSlug: "tiny-castle", quantity: 1 }] });
    const res = await run(ctx, "request_booking", { message: "Please call me" });
    expect(res.status).toBe("ok");
    expect(res.result).toMatchObject({ booking: "hold_placed", holdMinutes: 15 });
    expect(res.result.message).toBe(
      "Your booking request has been submitted and the inventory is being held for 15 minutes.",
    );
    const db = await admin<{ br: string; source: string; res: string; quote: string }>(
      `select b.status::text br, b.source, r.status::text res, q.status::text quote
       from public.booking_requests b join public.reservations r on r.id = b.reservation_id
       join public.quotes q on q.id = b.quote_id where q.token_hash = $1`,
      [ctx.state.quote!.tokenHash],
    );
    // Held and pending — never accepted/confirmed by the assistant.
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ br: "pending", source: "assistant", res: "held" });
    expect(db.rows[0]!.quote).not.toBe("accepted");
    const again = await run(ctx, "request_booking", {});
    expect(again.result).toMatchObject({ booking: "holding" });
  });

  it("request_booking without a browser session, without a quote, and for manual-review prices", async () => {
    const noQuote = await run(ctxFor(a), "request_booking", {});
    expect(noQuote.errorCode).toBe("NO_QUOTE");
    const noVisitor = await readyCtx(a, { visitorToken: null });
    await run(noVisitor, "create_quote", { items: [{ productSlug: "tiny-castle", quantity: 1 }] });
    expect((await run(noVisitor, "request_booking", {})).result).toMatchObject({
      booking: "needs_page_reload",
    });
    // Delivery without a distance provider → manual review → cannot be requested yet.
    const review = ctxFor(a, { miles: null });
    await run(review, "create_customer", { email: `rev-${randomUUID().slice(0, 8)}@example.test` });
    await run(review, "create_event", {
      ...window(nextDate()),
      fulfillment: "delivery",
      address: ADDRESS,
    });
    const q = await run(review, "create_quote", {
      items: [{ productSlug: "tiny-castle", quantity: 1 }],
    });
    expect(q.status).toBe("manual_review");
    expect(q.result).not.toHaveProperty("total");
    // M5 allows the hold; the review gate applies when staff confirm. The assistant says so.
    const held = await run(review, "request_booking", {});
    expect(held.result).toMatchObject({ booking: "hold_placed", priceIsFinal: false });
    expect(held.result.message).toMatch(/price still needs the team's review/);
  });

  it("stale and expired quotes are re-quoted, not requested", async () => {
    const ctx = await readyCtx(a);
    await run(ctx, "create_quote", { items: [{ productSlug: "tiny-castle", quantity: 1 }] });
    const q = await admin<{ id: string; event_id: string }>(
      "select id, event_id from public.quotes where token_hash = $1",
      [ctx.state.quote!.tokenHash],
    );
    await as(
      a.users.office,
      (sql) =>
        sql("update public.events set end_time = '18:00' where id = $1", [q.rows[0]!.event_id]),
      { commit: true },
    );
    expect((await run(ctx, "request_booking", {})).result).toMatchObject({ booking: "stale" });

    const ctx2 = await readyCtx(a);
    await run(ctx2, "create_quote", { items: [{ productSlug: "tiny-castle", quantity: 1 }] });
    const q2 = await admin<{ id: string }>("select id from public.quotes where token_hash = $1", [
      ctx2.state.quote!.tokenHash,
    ]);
    await as(
      a.users.office,
      (sql) => sql("update public.quotes set status = 'sent' where id = $1", [q2.rows[0]!.id]),
      { commit: true },
    );
    await admin("update public.quotes set expires_at = now() - interval '1 minute' where id = $1", [
      q2.rows[0]!.id,
    ]);
    expect((await run(ctx2, "request_booking", {})).result).toMatchObject({ booking: "expired" });
  });

  it("the per-visitor hold cap still applies to the assistant", async () => {
    const visitor = generateVisitorToken();
    const outcomes: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      const ctx = await readyCtx(a, { visitorToken: visitor });
      await run(ctx, "create_quote", { items: [{ productSlug: "tiny-castle", quantity: 1 }] });
      outcomes.push((await run(ctx, "request_booking", {})).result.booking);
    }
    expect(outcomes).toEqual(["hold_placed", "hold_placed", "hold_limit"]);
  });
});

describeRest("tenant isolation", () => {
  it("a tenant's assistant cannot read or act on another tenant's quote, products or customers", async () => {
    // Tenant B's quote…
    const bCtx = ctxFor(b);
    await run(bCtx, "create_customer", { email: `b-${randomUUID().slice(0, 8)}@example.test` });
    await run(bCtx, "create_event", { ...window(nextDate()), fulfillment: "pickup" });
    await run(bCtx, "create_quote", { items: [{ productSlug: "b-slide", quantity: 1 }] });
    const bQuote = bCtx.state.quote!;
    // …planted into tenant A's conversation state (e.g. a forged session) is simply not found.
    const planted = { ...bQuote, basis: { contact: null, event: null, items: null } };
    const aCtx = ctxFor(a, {
      state: { ...emptyState(), quote: planted },
    });
    const res = await run(aCtx, "request_booking", {});
    expect(res.errorCode).toBe("NOT_FOUND");
    expect(
      (await admin("select 1 from public.booking_requests where quote_id = $1", [bQuote.quoteId]))
        .rowCount,
    ).toBe(0);
    const count = async () =>
      Number(
        (
          await admin<{ n: string }>(
            "select count(*)::text n from public.quotes where organization_id in ($1, $2)",
            [a.id, b.id],
          )
        ).rows[0]!.n,
      );
    const before = await count();
    const add = await run(aCtx, "add_quote_item", { productSlug: "mega-slide", quantity: 1 });
    expect(add.status).toMatch(/^rejected_/);
    expect(await count()).toBe(before);
    expect(JSON.stringify(await run(aCtx, "search_products", { query: "slide" }))).not.toContain(
      "B Slide",
    );
  });

  it("no tool argument can name an organization, a price, a status or a record id", async () => {
    const ctx = ctxFor(a);
    for (const [tool, args] of [
      ["search_products", { query: "slide", organizationId: b.id }],
      ["get_product_details", { productSlug: "b-slide", organization_id: b.id }],
      ["create_quote", { items: [{ productSlug: "mega-slide", quantity: 1 }], total: 1 }],
      ["request_booking", { status: "confirmed" }],
      ["create_event", { ...window(nextDate()), fulfillment: "pickup", tenant: b.slug }],
      ["check_service_area", { address: { ...ADDRESS, organizationId: b.id } }],
    ] as const) {
      const r = await run(ctx, tool, args);
      expect(r, tool).toMatchObject({ status: "rejected_policy", errorCode: "FORBIDDEN_ARGUMENT" });
    }
    const unknown = await run(ctx, "run_sql", { sql: "select * from customers" });
    expect(unknown.errorCode).toBe("UNKNOWN_TOOL");
    const extra = await run(ctx, "get_product_details", {
      productSlug: "mega-slide",
      includeInternalNotes: true,
    });
    expect(extra.status).toBe("rejected_validation");
    const injectedSlug = await run(ctx, "get_product_details", {
      productSlug: "x'; drop table products;--",
    });
    expect(injectedSlug.status).toBe("rejected_validation");
  });
});

describeRest("active quote reconciliation (H3)", () => {
  async function quoted(org: TestOrg, date = nextDate()) {
    const ctx = ctxFor(org);
    await run(ctx, "create_customer", {
      firstName: "Sam",
      email: `h3-${randomUUID().slice(0, 8)}@example.test`,
    });
    await run(ctx, "create_event", { ...window(date), fulfillment: "pickup" });
    const q = await run(ctx, "create_quote", {
      items: [{ productSlug: "tiny-castle", quantity: 1 }],
    });
    expect(q.result.quote).toBe("created");
    return { ctx, number: q.result.quoteNumber as string, date };
  }
  const bookings = async (tokenHash: string) =>
    (
      await admin(
        "select 1 from public.booking_requests b join public.quotes q on q.id = b.quote_id where q.token_hash = $1",
        [tokenHash],
      )
    ).rowCount;

  it("an event change after the quote makes it mismatched: booking refused until a new quote replaces it", async () => {
    const { ctx, number } = await quoted(a);
    const oldHash = ctx.state.quote!.tokenHash;
    const newDate = nextDate();
    const moved = await run(ctx, "create_event", { ...window(newDate), fulfillment: "pickup" });
    expect(moved.result).toMatchObject({ quoteStatus: "out_of_date" });
    expect(await quoteRelation(ctx.state)).toEqual({ status: "mismatched", changed: ["event"] });
    const refused = await run(ctx, "request_booking", {});
    expect(refused).toMatchObject({ status: "rejected_policy", errorCode: "DETAILS_CHANGED" });
    expect(await bookings(oldHash)).toBe(0);
    // The updated quote replaces it; the booking then targets the NEW quote and the new event.
    const updated = await run(ctx, "create_quote", {});
    expect(updated.result).toMatchObject({ quote: "replaced", replaces: number });
    const booked = await run(ctx, "request_booking", {});
    expect(booked.result).toMatchObject({
      booking: "hold_placed",
      quoteNumber: updated.result.quoteNumber,
    });
    const row = await admin<{ quote_number: string; start_date: string }>(
      `select q.quote_number, e.event_date::text start_date from public.booking_requests b
       join public.quotes q on q.id = b.quote_id join public.events e on e.id = q.event_id
       where q.token_hash = $1`,
      [ctx.state.quote!.tokenHash],
    );
    expect(row.rows[0]).toEqual({ quote_number: updated.result.quoteNumber, start_date: newDate });
    expect(await bookings(oldHash)).toBe(0);
  });

  it("contact, item and quantity changes after the quote are mismatches too", async () => {
    for (const change of ["contact", "items", "quantity"] as const) {
      const { ctx } = await quoted(a);
      if (change === "contact") {
        await run(ctx, "create_customer", {
          email: `other-${randomUUID().slice(0, 6)}@example.test`,
        });
      } else {
        // Staged directly (as a create_quote with new items would before re-quoting).
        ctx.state.items =
          change === "items"
            ? [...ctx.state.items, { ...ctx.state.items[0]!, variantId: fx.slide.variantId }]
            : ctx.state.items.map((i) => ({ ...i, quantity: i.quantity + 1 }));
      }
      const rel = await quoteRelation(ctx.state);
      expect(rel, change).toMatchObject({ status: "mismatched" });
      const refused = await run(ctx, "request_booking", {});
      expect(refused.errorCode, change).toBe("DETAILS_CHANGED");
      expect(await bookings(ctx.state.quote!.tokenHash)).toBe(0);
    }
  });

  it("a different quote being viewed is never booked silently: ambiguous → explicit choice", async () => {
    const A = await quoted(a);
    const B = await quoted(a);
    // The chat's quote is A; the customer is viewing B (validated by its link token this turn).
    A.ctx.pageQuote = { tokenHash: B.ctx.state.quote!.tokenHash, quoteNumber: B.number };
    const hashA = A.ctx.state.quote!.tokenHash;
    const ambiguous = await run(A.ctx, "request_booking", {});
    expect(ambiguous).toMatchObject({ errorCode: "AMBIGUOUS_QUOTE" });
    expect(await bookings(hashA)).toBe(0);
    const unknown = await run(A.ctx, "request_booking", { quoteNumber: "Q-999999" });
    expect(unknown.errorCode).toBe("UNKNOWN_QUOTE");
    // The customer picks B: B becomes the active quote and is the one requested.
    const chosen = await run(A.ctx, "request_booking", { quoteNumber: B.number });
    expect(chosen.result).toMatchObject({ booking: "hold_placed", quoteNumber: B.number });
    expect(await bookings(B.ctx.state.quote!.tokenHash)).toBe(1);
    expect(A.ctx.state.quote?.quoteNumber).toBe(B.number);
    expect(await bookings(hashA)).toBe(0);
  });

  it("choosing the chat's own quote while viewing another books the chat's quote", async () => {
    const A = await quoted(a);
    const B = await quoted(a);
    A.ctx.pageQuote = { tokenHash: B.ctx.state.quote!.tokenHash, quoteNumber: B.number };
    const hashA = A.ctx.state.quote!.tokenHash;
    const chosen = await run(A.ctx, "request_booking", { quoteNumber: A.number });
    expect(chosen.result).toMatchObject({ booking: "hold_placed", quoteNumber: A.number });
    expect(await bookings(hashA)).toBe(1);
    expect(await bookings(B.ctx.state.quote!.tokenHash)).toBe(0);
  });
});

describeRest("staged items are never silently changed (M2)", () => {
  it("aggregate quantity over the maximum is refused, not clamped", async () => {
    const ctx = ctxFor(a);
    expect(
      (await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 600 })).status,
    ).toBe("ok");
    const over = await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 600 });
    expect(over).toMatchObject({ status: "rejected_validation", errorCode: "QUANTITY_LIMIT" });
    expect(over.result.message).toMatch(/Nothing was changed/);
    expect(ctx.state.items).toEqual([expect.objectContaining({ quantity: 600 })]);
    const priced = await run(ctx, "calculate_price", {
      items: [
        { productSlug: "tiny-castle", quantity: 600 },
        { productSlug: "tiny-castle", quantity: 600 },
      ],
      ...window(nextDate()),
      fulfillment: "pickup",
    });
    expect(priced.errorCode).toBe("QUANTITY_LIMIT");
  });

  it("duplicates are combined; an 11th distinct item is refused, never dropped", async () => {
    const ctx = ctxFor(a);
    await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 2 });
    await run(ctx, "add_quote_item", { productSlug: "tiny-castle", quantity: 3 });
    expect(ctx.state.items).toEqual([expect.objectContaining({ quantity: 5 })]);
    // Ten distinct items staged (fabricated staging of existing variants is not needed: fill with
    // real products).
    const extra: string[] = [];
    for (let i = 0; i < 10; i++) {
      const slug = `m2-item-${randomUUID().slice(0, 6)}`;
      await product(a, slug, { name: `Item ${String(i)}`, base_price_cents: 1000 });
      extra.push(slug);
    }
    for (const slug of extra.slice(0, 9)) {
      expect((await run(ctx, "add_quote_item", { productSlug: slug, quantity: 1 })).status).toBe(
        "ok",
      );
    }
    expect(ctx.state.items).toHaveLength(10);
    const eleventh = await run(ctx, "add_quote_item", { productSlug: extra[9]!, quantity: 1 });
    expect(eleventh).toMatchObject({ status: "rejected_validation", errorCode: "TOO_MANY_ITEMS" });
    expect(ctx.state.items).toHaveLength(10);
    expect(ctx.state.items.map((i) => i.productSlug)).not.toContain(extra[9]);
  });
});
