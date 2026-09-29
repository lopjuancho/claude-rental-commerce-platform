import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { QUOTE_STATUSES, canTransition } from "@/domain/quotes/state-machine";
import {
  cancelPublicBooking,
  getPublicQuote,
  renewPublicHold,
  requestPublicBooking,
  submitQuoteRequest,
} from "@/server/public/quotes";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { hashQuoteToken } from "@/server/quotes/token";
import { june, makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway, price } from "./support/pricing";

/**
 * M5: customers, events, quotes, booking requests (ADR 0015) — database invariants, the staff
 * workflow, and the public flow run through the REAL public services with the trusted gateway
 * executed as service_role against this database.
 */
let org: TestOrg;
let other: TestOrg;
let castle: { productId: string; variantId: string };
let chairs: { productId: string; variantId: string };

const EVENT = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
const tenantOf = (o: TestOrg) =>
  ({
    organizationId: o.id,
    slug: o.slug,
    name: o.slug,
    timezone: "America/Chicago",
  }) as unknown as ResolvedTenant;
const meta = { ip: "198.51.100.4", requestId: "req-m5" };
const deps = (keys: string[] = []) => {
  const gateway = pgGateway();
  return {
    gateway,
    keys,
    provider: fakeProvider(8.2),
    rateLimit: (policy: string, key: string) => {
      keys.push(`${policy}:${key}`);
      return Promise.resolve();
    },
  };
};
const email = () => `c-${randomUUID().slice(0, 8)}@example.test`;
const publicRequest = (variantId: string, extra: Record<string, unknown> = {}) => ({
  contact: { firstName: "Ana", lastName: "Diaz", email: email(), phone: "(901) 555-0142" },
  event: { date: "2027-06-19", startTime: "12:00", endTime: "16:00", address: EVENT },
  items: [{ variantId, quantity: 1 }],
  ...extra,
});

async function configureOrg(o: TestOrg) {
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400,
       quote_number_prefix = 'TQ-' where organization_id = $1`,
    [o.id],
  );
}

beforeAll(async () => {
  org = await createOrg("quotes");
  other = await createOrg("quotes-other");
  await configureOrg(org);
  await configureOrg(other);
  castle = await makeProduct(org, { units: 1 });
  await admin(
    "update public.products set base_price_cents = 30000, name = 'Castle' where id = $1",
    [castle.productId],
  );
  chairs = await makeProduct(org, { pooled: 10 });
  await admin("update public.products set base_price_cents = 250, name = 'Chair' where id = $1", [
    chairs.productId,
  ]);
});

// ── staff helpers (same SQL functions the staff service calls, as the signed-in user) ──
async function staffCustomer(o: TestOrg, contact: Record<string, unknown> = { email: email() }) {
  const [row] = await rpc<{ id: string }>(
    o.users.office,
    "select public.match_or_create_customer($1, $2) as id",
    [o.id, JSON.stringify(contact)],
  );
  return row!.id;
}

async function staffQuote(
  o: TestOrg,
  items: { variantId: string; quantity: number }[],
  opts: { date?: string; start?: string; end?: string; adjustments?: unknown[] } = {},
) {
  const customerId = await staffCustomer(o);
  const [ev] = await rpc<{ event_id: string; starts_at: Date; ends_at: Date }>(
    o.users.office,
    "select * from public.create_event($1, $2, $3)",
    [
      o.id,
      customerId,
      JSON.stringify({
        event_date: opts.date ?? "2027-06-19",
        start_time: opts.start ?? "12:00",
        end_time: opts.end ?? "16:00",
        address_line1: EVENT.line1,
        city: EVENT.city,
        state: EVENT.state,
        postal_code: EVENT.postalCode,
      }),
    ],
  );
  const request = {
    items: items.map((i) => ({
      ...i,
      start: ev!.starts_at.toISOString(),
      end: ev!.ends_at.toISOString(),
    })),
    eventAddress: EVENT,
    adjustments: opts.adjustments ?? [],
  };
  const run = await price(o.users.office, o, request, { save: true });
  const [q] = await rpc<{ quote_id: string; quote_number: string }>(
    o.users.office,
    "select * from public.create_quote($1, $2, $3, $4, $5, 'admin')",
    [o.id, customerId, ev!.event_id, run.calculationId, JSON.stringify(request)],
  );
  return { id: q!.quote_id, number: q!.quote_number, run, customerId, eventId: ev!.event_id };
}

const quoteRow = async (id: string) =>
  (
    await admin<{
      status: string;
      total_cents: string;
      subtotal_cents: string;
      tax_cents: string;
      delivery_cents: string;
      manual_review_required: boolean;
      review_approved_at: Date | null;
      pricing_calculation_id: string;
      expires_at: Date | null;
      created_by_type: string;
    }>("select * from public.quotes where id = $1", [id])
  ).rows[0]!;

const setStatus = (id: string, status: string, actor = org.users.office) =>
  outcome(
    as(actor, (sql) => sql("update public.quotes set status = $2 where id = $1", [id, status]), {
      commit: true,
    }),
  );

describe("quote totals come only from the immutable engine snapshot", () => {
  it("stored totals and items equal the engine output", async () => {
    const q = await staffQuote(org, [
      { variantId: castle.variantId, quantity: 1 },
      { variantId: chairs.variantId, quantity: 20 },
    ]);
    const row = await quoteRow(q.id);
    const s = q.run.output.summary;
    expect(row).toMatchObject({
      subtotal_cents: String(s.subtotal),
      tax_cents: String(s.tax),
      total_cents: String(s.total),
      delivery_cents: String(s.delivery),
      manual_review_required: q.run.output.manualReviewRequired,
      pricing_calculation_id: q.run.calculationId,
    });
    expect(Number(row.total_cents)).toBe(30000 + 5000 + 1600); // castle + 20 chairs + 8.2 mi delivery
    const items = await admin<{ product_name: string; quantity: number; line_total_cents: string }>(
      "select product_name, quantity, line_total_cents from public.quote_items where quote_id = $1 order by sort_order",
      [q.id],
    );
    expect(items.rows).toEqual([
      { product_name: "Castle", quantity: 1, line_total_cents: "30000" },
      { product_name: "Chair", quantity: 20, line_total_cents: "5000" },
    ]);
  });

  it("nobody can write a total directly: the trigger re-derives it from the snapshot", async () => {
    const q = await staffQuote(org, [{ variantId: castle.variantId, quantity: 1 }]);
    const before = await quoteRow(q.id);
    await as(
      org.users.owner,
      (sql) =>
        sql(
          "update public.quotes set total_cents = 1, subtotal_cents = 1, tax_cents = 0 where id = $1",
          [q.id],
        ),
      { commit: true },
    );
    expect((await quoteRow(q.id)).total_cents).toBe(before.total_cents);
    await expectDenied(
      as(org.users.owner, (sql) =>
        sql(
          "insert into public.quote_items (organization_id, quote_id, line_id, variant_id, product_id, kind, quantity, rental_period, product_name, unit_price_cents, line_total_cents, sort_order) values ($1, $2, 'X', $3, $4, 'rental', 1, tstzrange(now(), now() + interval '1 hour'), 'x', 1, 1, 9)",
          [org.id, q.id, castle.variantId, castle.productId],
        ),
      ),
    );
  });

  it("a quote cannot point at another organization's calculation", async () => {
    const theirs = await staffQuote(other, [
      { variantId: (await makeProduct(other, { units: 1 })).variantId, quantity: 1 },
    ]);
    const mine = await staffQuote(org, [{ variantId: castle.variantId, quantity: 1 }]);
    expect(
      await outcome(
        as(
          org.users.owner,
          (sql) =>
            sql("update public.quotes set pricing_calculation_id = $2 where id = $1", [
              mine.id,
              theirs.run.calculationId,
            ]),
          { commit: true },
        ),
      ),
    ).toMatch(/23503|RA005/);
  });

  it("re-pricing a draft creates a new snapshot; the old one is untouched", async () => {
    const q = await staffQuote(org, [{ variantId: castle.variantId, quantity: 1 }]);
    await admin("update public.products set base_price_cents = 32000 where id = $1", [
      castle.productId,
    ]);
    const req = (
      await admin<{ price_request: unknown }>(
        "select price_request from public.quotes where id = $1",
        [q.id],
      )
    ).rows[0]!.price_request;
    const rerun = await price(org.users.office, org, req, { save: true });
    await as(
      org.users.office,
      (sql) =>
        sql("update public.quotes set pricing_calculation_id = $2 where id = $1", [
          q.id,
          rerun.calculationId,
        ]),
      { commit: true },
    );
    expect(Number((await quoteRow(q.id)).total_cents)).toBe(32000 + 1600);
    const old = await admin<{ total_cents: string }>(
      "select total_cents from public.pricing_calculations where id = $1",
      [q.run.calculationId],
    );
    expect(old.rows[0]!.total_cents).toBe(String(30000 + 1600));
    await admin("update public.products set base_price_cents = 30000 where id = $1", [
      castle.productId,
    ]);
  });
});

describe("quote lifecycle", () => {
  it("the SQL transition table matches the domain state machine", async () => {
    for (const from of QUOTE_STATUSES) {
      for (const to of QUOTE_STATUSES) {
        const r = await admin<{ ok: boolean }>(
          "select app.quote_transition_allowed($1, $2) as ok",
          [from, to],
        );
        expect([from, to, r.rows[0]!.ok]).toEqual([from, to, canTransition(from, to)]);
      }
    }
  });

  it("illegal transitions are rejected (RA010)", async () => {
    const q = await staffQuote(org, [{ variantId: chairs.variantId, quantity: 1 }]);
    await admin("update public.quotes set review_approved_at = null where id = $1", [q.id]);
    expect(await setStatus(q.id, "viewed")).toBe("RA010");
    expect(await setStatus(q.id, "declined")).toBe("RA010");
    expect(await setStatus(q.id, "cancelled")).toBe("ok");
    expect(await setStatus(q.id, "draft")).toBe("RA010");
    expect(await setStatus(q.id, "sent")).toBe("RA010");
  });

  it("a price needing review cannot be sent or accepted until staff approve it; re-pricing resets approval", async () => {
    const q = await staffQuote(org, [{ variantId: chairs.variantId, quantity: 2 }]);
    expect((await quoteRow(q.id)).manual_review_required).toBe(true); // no tax configured
    expect(await setStatus(q.id, "sent")).toBe("RA008");
    expect(await setStatus(q.id, "accepted")).toBe("RA008");
    // The system context cannot approve reviews.
    expect(
      await outcome(
        as(
          SYSTEM,
          (sql) => sql("update public.quotes set review_approved_at = now() where id = $1", [q.id]),
          { commit: true },
        ),
      ),
    ).toBe("RA005");
    await as(
      org.users.office,
      (sql) =>
        sql(
          "update public.quotes set review_approved_at = now(), review_note = 'Tax checked by hand' where id = $1",
          [q.id],
        ),
      { commit: true },
    );
    expect((await quoteRow(q.id)).review_approved_at).not.toBeNull();
    // Re-pricing the draft clears the approval.
    const req = (
      await admin<{ price_request: unknown }>(
        "select price_request from public.quotes where id = $1",
        [q.id],
      )
    ).rows[0]!.price_request;
    const rerun = await price(org.users.office, org, req, { save: true });
    await as(
      org.users.office,
      (sql) =>
        sql("update public.quotes set pricing_calculation_id = $2 where id = $1", [
          q.id,
          rerun.calculationId,
        ]),
      { commit: true },
    );
    expect((await quoteRow(q.id)).review_approved_at).toBeNull();
    await as(
      org.users.office,
      (sql) => sql("update public.quotes set review_approved_at = now() where id = $1", [q.id]),
      { commit: true },
    );
    expect(await setStatus(q.id, "sent")).toBe("ok");
    const sent = await quoteRow(q.id);
    expect(sent.expires_at).not.toBeNull(); // quote_valid_days
    // Sent quotes are fixed documents: no re-pricing.
    expect(
      await outcome(
        as(
          org.users.office,
          (sql) =>
            sql("update public.quotes set pricing_calculation_id = $2 where id = $1", [
              q.id,
              q.run.calculationId,
            ]),
          { commit: true },
        ),
      ),
    ).toBe("RA010");
    expect(await setStatus(q.id, "draft")).toBe("ok"); // revise
  });

  it("an expired quote cannot be accepted; the sweeper marks it expired", async () => {
    const q = await staffQuote(org, [{ variantId: chairs.variantId, quantity: 1 }]);
    await as(
      org.users.office,
      (sql) => sql("update public.quotes set review_approved_at = now() where id = $1", [q.id]),
      { commit: true },
    );
    expect(await setStatus(q.id, "sent")).toBe("ok");
    await admin("update public.quotes set expires_at = now() - interval '1 minute' where id = $1", [
      q.id,
    ]);
    expect(await setStatus(q.id, "accepted")).toBe("RA009");
    expect(await outcome(rpc(SYSTEM, "select public.expire_quotes()", []))).toBe("ok");
    expect((await quoteRow(q.id)).status).toBe("expired");
  });

  it("quote numbers are per organization, prefixed, sequential and unique under concurrency", async () => {
    const numbers = await Promise.all(
      Array.from({ length: 6 }, () =>
        staffQuote(org, [{ variantId: chairs.variantId, quantity: 1 }]).then((q) => q.number),
      ),
    );
    expect(new Set(numbers).size).toBe(6);
    for (const n of numbers) expect(n).toMatch(/^TQ-\d+$/);
    const theirs = await admin<{ n: string }>(
      "select quote_number as n from public.quotes where organization_id = $1 order by created_at limit 1",
      [other.id],
    );
    expect(theirs.rows[0]!.n).toBe("TQ-1001");
  });

  it("the read-only staff role cannot create or edit quotes; office can", async () => {
    const q = await staffQuote(org, [{ variantId: chairs.variantId, quantity: 1 }]);
    const r = await as(
      org.users.staff,
      (sql) => sql("update public.quotes set customer_notes = 'x' where id = $1", [q.id]),
      { commit: true },
    );
    expect(r.rowCount).toBe(0);
    expect(
      await outcome(
        rpc(org.users.staff, "select * from public.create_quote($1, $2, $3, $4, '{}', 'admin')", [
          org.id,
          q.customerId,
          q.eventId,
          q.run.calculationId,
        ]),
      ),
    ).toBe("RA005");
    const seen = await as(org.users.staff, (sql) =>
      sql("select 1 from public.quotes where id = $1", [q.id]),
    );
    expect(seen.rowCount).toBe(1); // but can read (crew needs event details)
  });

  it("other organizations cannot read or touch the quote", async () => {
    const q = await staffQuote(org, [{ variantId: chairs.variantId, quantity: 1 }]);
    const seen = await as(other.users.owner, (sql) =>
      sql("select 1 from public.quotes where id = $1", [q.id]),
    );
    expect(seen.rowCount).toBe(0);
    const upd = await as(
      other.users.owner,
      (sql) => sql("update public.quotes set status = 'cancelled' where id = $1", [q.id]),
      { commit: true },
    );
    expect(upd.rowCount).toBe(0);
    expect(
      await outcome(
        rpc(other.users.owner, "select * from public.request_booking($1, 'admin')", [q.id]),
      ),
    ).toBe("RA005");
  });
});

describe("customers and events", () => {
  it("customers are deduplicated by email (case-insensitive) then phone; existing data is never overwritten", async () => {
    const e = email();
    const a = await staffCustomer(org, { email: e, firstName: "Ana" });
    const b = await staffCustomer(org, {
      email: e.toUpperCase(),
      firstName: "Mallory",
      phone: "+19015550100",
    });
    expect(b).toBe(a);
    const c = await staffCustomer(org, { phone: "+19015550100", lastName: "Diaz" });
    expect(c).toBe(a);
    const row = await admin<{ first_name: string; last_name: string; phone_e164: string }>(
      "select first_name, last_name, phone_e164 from public.customers where id = $1",
      [a],
    );
    expect(row.rows[0]).toEqual({
      first_name: "Ana",
      last_name: "Diaz",
      phone_e164: "+19015550100",
    });
    // The same email in another organization is a different customer.
    expect(await staffCustomer(other, { email: e })).not.toBe(a);
  });

  it("concurrent public submissions with the same email create one customer", async () => {
    const e = email();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        rpc<{ id: string }>(SYSTEM, "select public.match_or_create_customer($1, $2) as id", [
          org.id,
          JSON.stringify({ email: e }),
        ]),
      ),
    );
    expect(new Set(ids.map((r) => r[0]!.id)).size).toBe(1);
  });

  it("event times use the organization's zone; nonexistent times are rejected; ambiguous ones need a fold", async () => {
    const cust = await staffCustomer(org);
    const create = (event: Record<string, unknown>) =>
      rpc<{ starts_at: Date; ends_at: Date }>(
        org.users.office,
        "select * from public.create_event($1, $2, $3)",
        [org.id, cust, JSON.stringify(event)],
      );
    const [overnight] = await create({
      event_date: "2027-06-19",
      start_time: "18:00",
      end_time: "10:00",
    });
    expect(overnight!.starts_at.toISOString()).toBe("2027-06-19T23:00:00.000Z");
    expect(overnight!.ends_at.toISOString()).toBe("2027-06-20T15:00:00.000Z");
    expect(
      await outcome(create({ event_date: "2027-03-14", start_time: "02:30", end_time: "06:00" })),
    ).toBe("RA012");
    expect(
      await outcome(create({ event_date: "2027-11-07", start_time: "01:30", end_time: "06:00" })),
    ).toBe("RA012");
    const [later] = await create({
      event_date: "2027-11-07",
      start_time: "01:30",
      end_time: "06:00",
      time_fold: "later",
    });
    expect(later!.starts_at.toISOString()).toBe("2027-11-07T07:30:00.000Z");
  });
});

describe("public quote request (real public services, tenant from host)", () => {
  it("creates customer, event, priced snapshot and a draft quote; the view shows exactly the engine output", async () => {
    const d = deps();
    const { token, quoteNumber } = await submitQuoteRequest(
      tenantOf(org),
      publicRequest(castle.variantId),
      meta,
      d,
    );
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await admin<{
      id: string;
      created_by_type: string;
      source: string;
      token_hash: string;
      organization_id: string;
    }>(
      "select id, created_by_type, source, token_hash, organization_id from public.quotes where quote_number = $1 and organization_id = $2",
      [quoteNumber, org.id],
    );
    expect(row.rows[0]).toMatchObject({
      created_by_type: "public",
      source: "web",
      token_hash: await hashQuoteToken(token),
    });
    const view = await getPublicQuote(tenantOf(org), token, deps());
    expect(view).toMatchObject({
      quoteNumber,
      status: "draft",
      totalCents: 30000 + 1600,
      priceIsFinal: false,
      canRequestBooking: true,
    });
    expect(view!.lines.map((l) => l.label)).toEqual([
      "Castle",
      "Delivery (8.2 mi: 4 billable mi × $4.00)",
    ]);
    // Rate limited per tenant + client, audited as public, only explicit gateway operations used.
    expect(d.keys).toEqual([`publicWrite:${org.id}:198.51.100.4`]);
    const ALLOWED = new Set([
      "match_or_create_customer",
      "create_event",
      "pricing_context",
      "delivery_area_context",
      "get_cached_distance",
      "put_cached_distance", // only on a cache miss
      "tax_context",
      "record_pricing_calculation",
      "create_quote",
      "audit",
    ]);
    for (const call of d.gateway.calls) expect(ALLOWED).toContain(call);
    for (const needed of [
      "match_or_create_customer",
      "create_event",
      "record_pricing_calculation",
      "create_quote",
      "audit",
    ])
      expect(d.gateway.calls).toContain(needed);
    const audit = await admin<{ actor_type: string; action: string }>(
      "select actor_type, action from public.audit_logs where organization_id = $1 and entity_id = $2 and action = 'quote.requested'",
      [org.id, row.rows[0]!.id],
    );
    expect(audit.rows).toEqual([{ actor_type: "public", action: "quote.requested" }]);
  });

  it("strict input: organization ids, prices, add-on flags or unknown keys are rejected before any database work", async () => {
    for (const bad of [
      publicRequest(castle.variantId, { organizationId: other.id }),
      publicRequest(castle.variantId, { totalCents: 1 }),
      {
        ...publicRequest(castle.variantId),
        items: [{ variantId: castle.variantId, quantity: 1, kind: "add_on" }],
      },
      {
        ...publicRequest(castle.variantId),
        items: [{ variantId: castle.variantId, quantity: 1, basePriceCents: 1 }],
      },
      { ...publicRequest(castle.variantId), contact: { email: email(), role: "owner" } },
    ]) {
      const d = deps();
      await expect(submitQuoteRequest(tenantOf(org), bad, meta, d)).rejects.toBeInstanceOf(
        ZodError,
      );
      expect(d.gateway.calls).toEqual([]);
    }
  });

  it("another tenant's product cannot be quoted through this tenant's site (and nothing is left half-written as a quote)", async () => {
    const theirs = await makeProduct(other, { units: 1 });
    await expect(
      submitQuoteRequest(tenantOf(org), publicRequest(theirs.variantId), meta, deps()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("unpublished products cannot be quoted publicly", async () => {
    const hidden = await makeProduct(org, { units: 1, published: false });
    await expect(
      submitQuoteRequest(tenantOf(org), publicRequest(hidden.variantId), meta, deps()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a nonexistent local event time is rejected with a clear error", async () => {
    const req = publicRequest(castle.variantId);
    req.event = { ...req.event, date: "2027-03-14", startTime: "02:30", endTime: "06:00" };
    await expect(submitQuoteRequest(tenantOf(org), req, meta, deps())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("tokens are scoped to their tenant; malformed or unknown tokens show nothing", async () => {
    const { token } = await submitQuoteRequest(
      tenantOf(org),
      publicRequest(chairs.variantId),
      meta,
      deps(),
    );
    expect(await getPublicQuote(tenantOf(other), token, deps())).toBeNull();
    expect(await getPublicQuote(tenantOf(org), "not-a-token", deps())).toBeNull();
    expect(await getPublicQuote(tenantOf(org), "A".repeat(43), deps())).toBeNull();
    await expect(
      requestPublicBooking(tenantOf(other), token, {}, meta, deps()),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the public functions are service-role only: no signed-in or anonymous caller can use them", async () => {
    const hash = "a".repeat(64);
    for (const actor of [{ kind: "anon" } as const, org.users.owner]) {
      expect(
        await outcome(rpc(actor, "select public.public_quote_view($1, $2)", [org.id, hash])),
      ).toBe("42501");
      expect(
        await outcome(
          rpc(actor, "select * from public.request_booking_by_token($1, $2, 'web')", [
            org.id,
            hash,
          ]),
        ),
      ).toBe("42501");
      expect(
        await outcome(rpc(actor, "select public.cancel_booking_by_token($1, $2)", [org.id, hash])),
      ).toBe("42501");
    }
    expect(
      await outcome(
        rpc({ kind: "anon" }, 'select public.match_or_create_customer($1, \'{"email":"x@y.z"}\')', [
          org.id,
        ]),
      ),
    ).toBe("42501");
    expect(
      await outcome(
        rpc({ kind: "anon" }, "select * from public.create_event($1, null, '{}')", [org.id]),
      ),
    ).toBe("42501");
    // The system context cannot create staff ('admin') quotes or set internal notes.
    expect(
      await outcome(
        rpc(
          SYSTEM,
          "select * from public.create_quote($1, null, null, gen_random_uuid(), '{}', 'admin')",
          [org.id],
        ),
      ),
    ).toBe("RA006");
  });
});

describe("booking requests: 15-minute holds, renewal, cancellation, staff confirmation", () => {
  async function publicQuote(variantId: string, qty = 1, date = "2027-06-19") {
    const req = publicRequest(variantId);
    req.items = [{ variantId, quantity: qty }];
    req.event = { ...req.event, date };
    const { token } = await submitQuoteRequest(tenantOf(org), req, meta, deps());
    const q = await admin<{ id: string }>("select id from public.quotes where token_hash = $1", [
      await hashQuoteToken(token),
    ]);
    return { token, quoteId: q.rows[0]!.id };
  }
  const pending = async (quoteId: string) =>
    (
      await admin<{ id: string; status: string; reservation_id: string }>(
        "select id, status::text, reservation_id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
        [quoteId],
      )
    ).rows[0]!;
  const reservation = async (id: string) =>
    (
      await admin<{ status: string; hold_expires_at: Date | null }>(
        "select status::text, hold_expires_at from public.reservations where id = $1",
        [id],
      )
    ).rows[0]!;

  it("a booking request holds the items for the organization's hold duration (15 min), idempotently", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const { token, quoteId } = await publicQuote(serial.variantId, 1, "2027-07-03");
    const d = deps();
    const first = await requestPublicBooking(
      tenantOf(org),
      token,
      { message: "Back yard" },
      meta,
      d,
    );
    const minutes = (Date.parse(first.holdExpiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    const again = await requestPublicBooking(tenantOf(org), token, {}, meta, deps());
    expect(again.holdExpiresAt).toBe(first.holdExpiresAt);
    const br = await pending(quoteId);
    expect(br.status).toBe("pending");
    expect((await reservation(br.reservation_id)).status).toBe("held");
    const view = await getPublicQuote(tenantOf(org), token, deps());
    expect(view!.booking).toMatchObject({ status: "pending", holdActive: true });
    const audit = await admin(
      "select 1 from public.audit_logs where entity_id = $1 and action = 'booking.requested' and actor_type = 'public'",
      [br.id],
    );
    expect(audit.rowCount).toBe(2); // each request is audited, the idempotent repeat too
  });

  it("a booking request for unavailable items fails cleanly and holds nothing", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const a = await publicQuote(serial.variantId, 1, "2027-07-04");
    const b = await publicQuote(serial.variantId, 1, "2027-07-04");
    await requestPublicBooking(tenantOf(org), a.token, {}, meta, deps());
    await expect(
      requestPublicBooking(tenantOf(org), b.token, {}, meta, deps()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_AVAILABILITY" });
    const none = await admin("select 1 from public.booking_requests where quote_id = $1", [
      b.quoteId,
    ]);
    expect(none.rowCount).toBe(0);
  });

  it("two simultaneous booking requests for the last unit: exactly one hold", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const qs = await Promise.all(
      [1, 2, 3, 4].map(() => publicQuote(serial.variantId, 1, "2027-07-05")),
    );
    const results = await Promise.all(
      qs.map((q) => outcome(requestPublicBooking(tenantOf(org), q.token, {}, meta, deps()))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "INSUFFICIENT_AVAILABILITY")).toHaveLength(3);
  });

  it("holds can be renewed up to the limit; cancelling releases the items", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const q = await publicQuote(serial.variantId, 1, "2027-07-06");
    await requestPublicBooking(tenantOf(org), q.token, {}, meta, deps());
    for (let i = 0; i < 3; i++) await renewPublicHold(tenantOf(org), q.token, meta, deps());
    await expect(renewPublicHold(tenantOf(org), q.token, meta, deps())).rejects.toMatchObject({
      code: "HOLD_RENEWAL_LIMIT",
    });
    await cancelPublicBooking(tenantOf(org), q.token, meta, deps());
    const br = await pending(q.quoteId);
    expect(br.status).toBe("cancelled");
    expect((await reservation(br.reservation_id)).status).toBe("released");
    const q2 = await publicQuote(serial.variantId, 1, "2027-07-06");
    await expect(
      requestPublicBooking(tenantOf(org), q2.token, {}, meta, deps()),
    ).resolves.toBeTruthy();
  });

  it("an expired hold no longer blocks others and can no longer be renewed", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const q = await publicQuote(serial.variantId, 1, "2027-07-07");
    await requestPublicBooking(tenantOf(org), q.token, {}, meta, deps());
    const br = await pending(q.quoteId);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
      [br.reservation_id],
    );
    await expect(renewPublicHold(tenantOf(org), q.token, meta, deps())).rejects.toMatchObject({
      code: "HOLD_EXPIRED",
    });
    const other2 = await publicQuote(serial.variantId, 1, "2027-07-07");
    await expect(
      requestPublicBooking(tenantOf(org), other2.token, {}, meta, deps()),
    ).resolves.toBeTruthy();
  });

  it("staff confirmation: needs review sign-off, then confirms the reservation and accepts the quote", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const q = await publicQuote(serial.variantId, 1, "2027-07-08");
    await requestPublicBooking(tenantOf(org), q.token, {}, meta, deps());
    const br = await pending(q.quoteId);
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [br.id])),
    ).toBe("RA008");
    // The server's system context can never confirm a booking.
    expect(await outcome(rpc(SYSTEM, "select public.confirm_booking_request($1)", [br.id]))).toBe(
      "42501",
    );
    await as(
      org.users.office,
      (sql) =>
        sql(
          "update public.quotes set review_approved_at = now(), review_note = 'Tax verified' where id = $1",
          [q.quoteId],
        ),
      { commit: true },
    );
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [br.id])),
    ).toBe("ok");
    const after = await pending(q.quoteId);
    expect(after.status).toBe("confirmed");
    expect((await reservation(after.reservation_id)).status).toBe("confirmed");
    expect((await quoteRow(q.quoteId)).status).toBe("accepted");
    const view = await getPublicQuote(tenantOf(org), q.token, deps());
    expect(view).toMatchObject({
      status: "accepted",
      canRequestBooking: false,
      booking: { status: "confirmed" },
    });
  });

  it("confirmation re-validates: a maintenance block after the hold makes it fail; the hold stays", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const q = await publicQuote(serial.variantId, 1, "2027-07-09");
    await requestPublicBooking(tenantOf(org), q.token, {}, meta, deps());
    await as(
      org.users.office,
      (sql) =>
        sql("update public.quotes set review_approved_at = now() where id = $1", [q.quoteId]),
      { commit: true },
    );
    await admin(
      "insert into public.availability_blocks (organization_id, product_id, period, reason) values ($1, $2, tstzrange($3, $4), 'maintenance')",
      [
        org.id,
        serial.productId,
        june(30, "00:00").replace("06-30", "07-09"),
        june(30, "23:00").replace("06-30", "07-09"),
      ],
    );
    const br = await pending(q.quoteId);
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [br.id])),
    ).toBe("RA002");
    expect((await pending(q.quoteId)).status).toBe("pending");
    expect((await quoteRow(q.quoteId)).status).toBe("draft");
  });

  it("an expired hold is re-reserved at confirmation only if the stock is still free", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const a = await publicQuote(serial.variantId, 1, "2027-07-10");
    await requestPublicBooking(tenantOf(org), a.token, {}, meta, deps());
    await as(
      org.users.office,
      (sql) =>
        sql("update public.quotes set review_approved_at = now() where id = $1", [a.quoteId]),
      { commit: true },
    );
    const brA = await pending(a.quoteId);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
      [brA.reservation_id],
    );
    // Someone else takes the unit meanwhile.
    const b = await publicQuote(serial.variantId, 1, "2027-07-10");
    await requestPublicBooking(tenantOf(org), b.token, {}, meta, deps());
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [brA.id])),
    ).toBe("RA001");
    // After B's hold is cancelled, A can be confirmed with a fresh firm reservation.
    await cancelPublicBooking(tenantOf(org), b.token, meta, deps());
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [brA.id])),
    ).toBe("ok");
    expect((await pending(a.quoteId)).status).toBe("confirmed");
  });

  it("declining releases the hold; only staff can decline", async () => {
    const serial = await makeProduct(org, { units: 1 });
    const q = await publicQuote(serial.variantId, 1, "2027-07-11");
    await requestPublicBooking(tenantOf(org), q.token, {}, meta, deps());
    const br = await pending(q.quoteId);
    expect(
      await outcome(rpc(SYSTEM, "select public.close_booking_request($1, 'declined')", [br.id])),
    ).toBe("RA006");
    expect(
      await outcome(
        rpc(
          org.users.office,
          "select public.close_booking_request($1, 'declined', 'Not available that day')",
          [br.id],
        ),
      ),
    ).toBe("ok");
    expect((await reservation(br.reservation_id)).status).toBe("released");
  });

  it("a cancelled or expired quote cannot request a booking", async () => {
    const q = await publicQuote(chairs.variantId, 1, "2027-07-12");
    await admin("update public.quotes set status = 'cancelled' where id = $1", [q.quoteId]);
    await expect(
      requestPublicBooking(tenantOf(org), q.token, {}, meta, deps()),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
