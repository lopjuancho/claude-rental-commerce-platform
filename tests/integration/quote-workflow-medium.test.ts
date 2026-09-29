import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cancelPublicBooking,
  renewPublicHold,
  requestPublicBooking,
  submitQuoteRequest,
} from "@/server/public/quotes";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct, outcome, rpc } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";

/**
 * Codex M5 hardening review (commit 0040188), MEDIUM findings M1–M3.
 */
let org: TestOrg;
const ADDRESS = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
const tenant = () =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: org.slug,
    timezone: "America/Chicago",
  }) as unknown as ResolvedTenant;
const meta = { ip: "198.51.100.11" };
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(8.2),
  rateLimit: () => Promise.resolve(),
});
let day = 0;
const nextDate = () => new Date(Date.UTC(2027, 11, 1 + day++)).toISOString().slice(0, 10);

beforeAll(async () => {
  org = await createOrg("medium");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
});

async function publicQuote(opts: { variantId?: string; date?: string; email?: string } = {}) {
  const variantId = opts.variantId ?? (await makeProduct(org, { units: 3 })).variantId;
  const { token } = await submitQuoteRequest(
    tenant(),
    {
      contact: { email: opts.email ?? `md-${randomUUID().slice(0, 8)}@example.test` },
      event: {
        date: opts.date ?? nextDate(),
        startTime: "12:00",
        endTime: "16:00",
        address: ADDRESS,
      },
      items: [{ variantId, quantity: 1 }],
    },
    meta,
    deps(),
  );
  const q = await admin<{ id: string }>("select id from public.quotes where token_hash = $1", [
    await hashQuoteToken(token),
  ]);
  return { token, quoteId: q.rows[0]!.id, variantId };
}
const hold = (token: string) => requestPublicBooking(tenant(), token, {}, meta, deps());
const latest = async (quoteId: string) =>
  (
    await admin<{ id: string; reservation_id: string }>(
      "select id, reservation_id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
      [quoteId],
    )
  ).rows[0]!;
const office = (sql: string, params: unknown[]) =>
  outcome(as(org.users.office, (q) => q(sql, params), { commit: true }));
const staff = (sql: string, params: unknown[]) => outcome(rpc(org.users.office, sql, params));

/** Everything a rejected operation must leave untouched. */
async function state(quoteId: string, reservationIds: string[]) {
  const r = await admin<{ s: unknown }>(
    `select jsonb_build_object(
       'reservations', (select jsonb_agg(to_jsonb(r) - 'updated_at' order by r.id) from public.reservations r where r.id = any($2::uuid[])),
       'allocations', (select jsonb_agg(to_jsonb(a) - 'updated_at' order by a.id) from public.reservation_allocations a where a.reservation_id = any($2::uuid[])),
       'requests', (select jsonb_agg(to_jsonb(b) - 'updated_at' order by b.id) from public.booking_requests b where b.quote_id = $1),
       'budget', (select jsonb_agg(to_jsonb(g) order by g.revision) from public.quote_hold_budgets g where g.quote_id = $1),
       'count', (select count(*) from public.reservations x where x.organization_id = $3)) s`,
    [quoteId, reservationIds, org.id],
  );
  return r.rows[0]!.s;
}
async function manualHold(variantId: string, date: string) {
  const [r] = await rpc<{ id: string }>(
    org.users.office,
    "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual') as id",
    [
      org.id,
      JSON.stringify([
        {
          variant_id: variantId,
          quantity: 1,
          start: `${date}T02:00:00Z`,
          end: `${date}T03:00:00Z`,
        },
      ]),
    ],
  );
  return r!.id;
}

// ═══════════════════════════════ M1 ═══════════════════════════════
describe("M1. generic replacement cannot detach or release a quote-managed hold", () => {
  it("replacing a managed hold through reserve_inventory is rejected atomically", async () => {
    const q = await publicQuote();
    await hold(q.token);
    const b = await latest(q.quoteId);
    const before = await state(q.quoteId, [b.reservation_id]);
    const item = (
      await admin<{ s: Date; e: Date }>(
        "select lower(rental_period) s, upper(rental_period) e from public.quote_items where quote_id = $1",
        [q.quoteId],
      )
    ).rows[0]!;
    expect(
      await staff("select public.reserve_inventory($1, $2::jsonb, 'held', 'manual', $3)", [
        org.id,
        JSON.stringify([
          {
            variant_id: q.variantId,
            quantity: 1,
            start: item.s.toISOString(),
            end: item.e.toISOString(),
          },
        ]),
        b.reservation_id,
      ]),
    ).toBe("RA010");
    // H, B, allocations and budget unchanged; no replacement reservation survived.
    expect(await state(q.quoteId, [b.reservation_id])).toEqual(before);
  });

  it("ordinary manual-hold replacement still works", async () => {
    const p = await makeProduct(org, { units: 2 });
    const date = nextDate();
    const h = await manualHold(p.variantId, date);
    const [r] = await rpc<{ id: string }>(
      org.users.office,
      "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual', $3) as id",
      [
        org.id,
        JSON.stringify([
          {
            variant_id: p.variantId,
            quantity: 2,
            start: `${date}T02:00:00Z`,
            end: `${date}T04:00:00Z`,
          },
        ]),
        h,
      ],
    );
    const old = await admin<{ status: string; replaced_by: string }>(
      "select status::text, replaced_by from public.reservations where id = $1",
      [h],
    );
    expect(old.rows[0]).toEqual({ status: "released", replaced_by: r!.id });
  });
});

// ═══════════════════════════════ M2 ═══════════════════════════════
describe("M2. every managed-hold operation verifies the reservation's reciprocal links", () => {
  /** Q/B/H normally, plus an unrelated same-tenant hold H2 that B is (corruptly) pointed at. */
  async function corrupted() {
    const q = await publicQuote();
    await hold(q.token);
    const b = await latest(q.quoteId);
    const h2 = await manualHold((await makeProduct(org, { units: 1 })).variantId, nextDate());
    await admin("update public.booking_requests set reservation_id = $2 where id = $1", [b.id, h2]);
    return { ...q, brId: b.id, h: b.reservation_id, h2 };
  }

  it("renewal rejects (RA013); neither hold changes and no budget is consumed", async () => {
    const c = await corrupted();
    const before = await state(c.quoteId, [c.h, c.h2]);
    expect(await staff("select public.renew_booking_hold($1)", [c.brId])).toBe("RA013");
    await expect(renewPublicHold(tenant(), c.token, meta, deps())).rejects.toMatchObject({
      code: "STALE_BOOKING_REQUEST",
    });
    expect(await state(c.quoteId, [c.h, c.h2])).toEqual(before);
  });

  it("cancellation and decline reject (RA013); neither hold changes", async () => {
    const c = await corrupted();
    const before = await state(c.quoteId, [c.h, c.h2]);
    expect(await staff("select public.close_booking_request($1, 'cancelled')", [c.brId])).toBe(
      "RA013",
    );
    expect(await staff("select public.close_booking_request($1, 'declined', 'x')", [c.brId])).toBe(
      "RA013",
    );
    await expect(cancelPublicBooking(tenant(), c.token, meta, deps())).rejects.toMatchObject({
      code: "STALE_BOOKING_REQUEST",
    });
    expect(await state(c.quoteId, [c.h, c.h2])).toEqual(before);
  });

  it("an automatic close (quote cancelled) releases only the hold linked back to the request", async () => {
    const c = await corrupted();
    const h2Before = await state(c.quoteId, [c.h2]);
    expect(
      await office("update public.quotes set status = 'cancelled' where id = $1", [c.quoteId]),
    ).toBe("ok");
    const after = await admin<{ id: string; status: string }>(
      "select id, status::text from public.reservations where id = any($1::uuid[])",
      [[c.h, c.h2]],
    );
    const byId = Object.fromEntries(after.rows.map((r) => [r.id, r.status]));
    expect(byId[c.h]).toBe("released"); // the request's own hold
    expect(byId[c.h2]).toBe("held"); // the unrelated hold is untouched
    const h2After = (await state(c.quoteId, [c.h2])) as { reservations: unknown };
    expect(h2After.reservations).toEqual((h2Before as { reservations: unknown }).reservations);
  });

  it("an automatic cap (quote expiry moved) never shortens an unrelated hold", async () => {
    const c = await corrupted();
    const exp = async (id: string) =>
      (
        await admin<{ e: Date }>(
          "select hold_expires_at e from public.reservations where id = $1",
          [id],
        )
      ).rows[0]!.e.getTime();
    const h2Before = await exp(c.h2);
    expect(
      await office(
        "update public.quotes set expires_at = now() + interval '1 minute' where id = $1",
        [c.quoteId],
      ),
    ).toBe("ok");
    expect(await exp(c.h2)).toBe(h2Before);
    const q = await admin<{ e: Date }>("select expires_at e from public.quotes where id = $1", [
      c.quoteId,
    ]);
    expect(await exp(c.h)).toBeLessThanOrEqual(q.rows[0]!.e.getTime());
  });

  it("correctly linked renewal and cancellation still succeed (regression)", async () => {
    const q = await publicQuote();
    await hold(q.token);
    const b = await latest(q.quoteId);
    expect(await staff("select public.renew_booking_hold($1)", [b.id])).toBe("ok");
    expect(await staff("select public.close_booking_request($1, 'cancelled')", [b.id])).toBe("ok");
    const r = await admin<{ s: string }>(
      "select status::text s from public.reservations where id = $1",
      [b.reservation_id],
    );
    expect(r.rows[0]!.s).toBe("released");
  });
});

// ═══════════════════════════════ M3 ═══════════════════════════════
describe("M3. the public hold budget is per quote revision (documented scope)", () => {
  it("a fresh quote for the same contact, product and window starts a fresh budget — cross-quote reacquisition is ALLOWED (per-quote scope; see ADR 0015 §13)", async () => {
    const p = await makeProduct(org, { units: 1 });
    const date = nextDate();
    const email = `same-${randomUUID().slice(0, 8)}@example.test`;
    const q1 = await publicQuote({ variantId: p.variantId, date, email });
    await hold(q1.token); // 1
    for (let i = 0; i < 3; i++) await renewPublicHold(tenant(), q1.token, meta, deps()); // 2–4
    await expect(renewPublicHold(tenant(), q1.token, meta, deps())).rejects.toMatchObject({
      code: "HOLD_RENEWAL_LIMIT",
    });
    await cancelPublicBooking(tenant(), q1.token, meta, deps());
    await expect(hold(q1.token)).rejects.toMatchObject({ code: "HOLD_RENEWAL_LIMIT" }); // same quote: exhausted
    const q2 = await publicQuote({ variantId: p.variantId, date, email });
    const h2 = await hold(q2.token);
    expect(typeof h2.holdExpiresAt).toBe("string");
    // The only cross-quote brake is the per-tenant, per-client write rate limit (enforced in the
    // server before any of this runs), not the database budget.
    const budgets = await admin<{ q: string; used: number }>(
      "select quote_id q, used from public.quote_hold_budgets where quote_id = any($1::uuid[])",
      [[q1.quoteId, q2.quoteId]],
    );
    expect(Object.fromEntries(budgets.rows.map((b) => [b.q, b.used]))).toEqual({
      [q1.quoteId]: 4,
      [q2.quoteId]: 1,
    });
  });
});
