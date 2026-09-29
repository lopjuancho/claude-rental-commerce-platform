import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { requestPublicBooking, submitQuoteRequest } from "@/server/public/quotes";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken, hashVisitorToken } from "@/server/visitor";
import { addUnits, makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { openTx, settle, waitUntilBlocked, type Tx } from "./support/tx";

/**
 * Codex final review of 610acf0 (M5 hardening round 4): H1, M1, M2. Deterministic: every race is
 * staged step by step and the actual PostgreSQL waits are asserted (pg_locks), not inferred.
 */
let org: TestOrg;
let orgCap: TestOrg;
const ADDRESS = {
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
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(8.2),
  rateLimit: () => Promise.resolve(),
});
let day = 0;
const nextDate = () => new Date(Date.UTC(2028, 3, 1 + day++)).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(o: TestOrg) {
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [o.id],
  );
}
beforeAll(async () => {
  org = await createOrg("round4");
  orgCap = await createOrg("round4-cap");
  await setup(org);
  await setup(orgCap);
});

/** What a waiting backend is waiting for (null when it is not waiting on a lock). */
async function waitingOn(pid: number) {
  const r = await admin<{ locktype: string }>(
    "select locktype from pg_locks where pid = $1 and not granted",
    [pid],
  );
  return r.rows.map((x) => x.locktype);
}
/** True when some other session can lock the row right now (nobody holds it). */
async function rowIsFree(table: string, id: string) {
  return (
    (await outcome(
      admin(`select 1 from public.${table} where id = $1 for update nowait`, [id]),
    )) === "ok"
  );
}

// ═══════════════════════════════ H1 ═══════════════════════════════
describe("H1. the organization gate is taken before any row lock of a capacity mutation", () => {
  /**
   * A takes the gate (first statement) and holds it; B's statement on another row must wait on the
   * gate WITHOUT holding its row; A then updates B's row too. Before the fix B held its row and
   * waited on the gate inside a BEFORE ROW trigger: A → B's row, B → gate = deadlock.
   */
  async function stage(
    table: string,
    first: (tx: Tx) => Promise<unknown>,
    second: (tx: Tx) => Promise<unknown>,
    secondRowIds: string[],
    thenA: (tx: Tx) => Promise<unknown>,
  ) {
    const a = await openTx(org.users.office);
    await first(a);
    const b = await openTx(org.users.office);
    const bResult = settle(second(b));
    await waitUntilBlocked(b.pid);
    expect(await waitingOn(b.pid)).toEqual(["advisory"]); // B waits on the gate…
    for (const id of secondRowIds) expect(await rowIsFree(table, id)).toBe(true); // …holding none of its rows
    expect(await outcome(thenA(a))).toBe("ok"); // A proceeds through B's rows: no deadlock
    await a.commit();
    expect(await bResult).toBe("ok");
    await b.commit();
  }

  it("products", async () => {
    const p1 = await makeProduct(org);
    const p2 = await makeProduct(org);
    await stage(
      "products",
      (a) => a.q("update public.products set name = name where id = $1", [p1.productId]),
      (b) => b.q("update public.products set name = name where id = $1", [p2.productId]),
      [p2.productId],
      (a) => a.q("update public.products set name = name where id = $1", [p2.productId]),
    );
  });

  it("variants", async () => {
    const p1 = await makeProduct(org);
    const p2 = await makeProduct(org);
    await stage(
      "product_variants",
      (a) => a.q("update public.product_variants set name = name where id = $1", [p1.variantId]),
      (b) => b.q("update public.product_variants set name = name where id = $1", [p2.variantId]),
      [p2.variantId],
      (a) => a.q("update public.product_variants set name = name where id = $1", [p2.variantId]),
    );
  });

  it("inventory units", async () => {
    const p = await makeProduct(org, { units: 0 });
    const [u1, u2] = await addUnits(org, p.variantId, 2);
    await stage(
      "inventory_units",
      (a) => a.q("update public.inventory_units set label = label where id = $1", [u1]),
      (b) => b.q("update public.inventory_units set label = label where id = $1", [u2]),
      [u2!],
      (a) => a.q("update public.inventory_units set label = label where id = $1", [u2]),
    );
  });

  it("availability blocks", async () => {
    const p = await makeProduct(org);
    const blocks = await admin<{ id: string }>(
      `insert into public.availability_blocks (organization_id, variant_id, period, reason)
       select $1, $2, tstzrange(d, d + interval '1 hour'), 'maintenance'
       from unnest(array[$3::timestamptz, $4::timestamptz]) d returning id`,
      [org.id, p.variantId, `${nextDate()}T00:00:00Z`, `${nextDate()}T00:00:00Z`],
    );
    const [b1, b2] = blocks.rows.map((r) => r.id);
    await stage(
      "availability_blocks",
      (a) => a.q("update public.availability_blocks set notes = 'a' where id = $1", [b1]),
      (b) => b.q("update public.availability_blocks set notes = 'b' where id = $1", [b2]),
      [b2!],
      (a) => a.q("update public.availability_blocks set notes = 'a2' where id = $1", [b2]),
    );
  });

  it("weather blocks (staff-editable period/scope once confirmed)", async () => {
    const w = await admin<{ id: string }>(
      `insert into public.weather_blocks (organization_id, hazard, period, status, scope, reason)
       select $1, 'wind', tstzrange(d, d + interval '1 day'), 'confirmed', 'all_sensitive', 'Gusts'
       from unnest(array[$2::timestamptz, $3::timestamptz]) d returning id`,
      [org.id, `${nextDate()}T00:00:00Z`, `${nextDate()}T00:00:00Z`],
    );
    const [w1, w2] = w.rows.map((r) => r.id);
    await stage(
      "weather_blocks",
      (a) => a.q("update public.weather_blocks set reason = 'a' where id = $1", [w1]),
      (b) => b.q("update public.weather_blocks set reason = 'b' where id = $1", [w2]),
      [w2!],
      (a) => a.q("update public.weather_blocks set reason = 'a2' where id = $1", [w2]),
    );
  });

  it("a multi-row (bulk) statement waits on the gate before locking any of its rows", async () => {
    const [p1, p2, p3] = [await makeProduct(org), await makeProduct(org), await makeProduct(org)];
    await stage(
      "products",
      (a) => a.q("update public.products set name = name where id = $1", [p1.productId]),
      (b) =>
        b.q("update public.products set name = name where id = any($1::uuid[])", [
          [p2.productId, p3.productId],
        ]),
      [p2.productId, p3.productId],
      (a) =>
        a.q("update public.products set name = name where id = any($1::uuid[])", [
          [p3.productId, p2.productId],
        ]),
    );
  });

  it("a context without a user (script / service) never waits on the gate while holding a row", async () => {
    const p = await makeProduct(org, { units: 0 });
    const a = await openTx(org.users.office);
    await a.q("update public.products set name = name where id = $1", [p.productId]); // A holds the gate
    // A superuser write (import script / tests) of a unit needs the gate while holding its new row.
    const insert = outcome(
      admin(
        "insert into public.inventory_units (organization_id, variant_id, label) values ($1, $2, 'U-x')",
        [org.id, p.variantId],
      ),
    );
    const early = await Promise.race([insert, sleep(1000).then(() => "still waiting")]);
    await a.commit();
    await insert;
    // It fails fast with a retryable "lock not available" instead of waiting (which could deadlock).
    expect(early).toBe("55P03");
  });
});

// ═══════════════════════════════ public quotes (M1, M2) ═══════════════════════════════
async function quote(o: TestOrg = org) {
  const p = await makeProduct(o, { units: 2 });
  const { token } = await submitQuoteRequest(
    tenantOf(o),
    {
      contact: { email: `r4-${randomUUID().slice(0, 8)}@example.test` },
      event: { date: nextDate(), startTime: "12:00", endTime: "16:00", address: ADDRESS },
      items: [{ variantId: p.variantId, quantity: 1 }],
    },
    { ip: "198.51.100.14" },
    deps(),
  );
  const q = await admin<{ id: string; event_id: string; customer_id: string }>(
    "select id, event_id, customer_id from public.quotes where token_hash = $1",
    [await hashQuoteToken(token)],
  );
  return {
    token,
    org: o,
    quoteId: q.rows[0]!.id,
    eventId: q.rows[0]!.event_id,
    customerId: q.rows[0]!.customer_id,
  };
}
type Q = Awaited<ReturnType<typeof quote>>;
const hold = (q: Q, visitor: string) =>
  requestPublicBooking(
    tenantOf(q.org),
    q.token,
    {},
    { ip: "198.51.100.14", visitorToken: visitor },
    deps(),
  );
const request = async (q: Q) =>
  (
    await admin<{ id: string; reservation_id: string; status: string }>(
      "select id, reservation_id, status::text from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
      [q.quoteId],
    )
  ).rows[0]!;
async function live(o: TestOrg, visitor: string) {
  const r = await admin<{ n: number }>(
    `select count(*)::int n from public.reservations where organization_id = $1 and public_visitor_hash = $2
       and status = 'held' and hold_expires_at > clock_timestamp()`,
    [o.id, await hashVisitorToken(visitor)],
  );
  return r.rows[0]!.n;
}
async function holdState(q: Q) {
  const b = await request(q);
  const r = await admin<{ e: Date; n: number; used: number | null }>(
    `select r.hold_expires_at e, r.hold_renewals n,
            (select sum(used)::int from public.quote_hold_budgets g where g.quote_id = $2) used
     from public.reservations r where r.id = $1`,
    [b.reservation_id, q.quoteId],
  );
  return r.rows[0]!;
}
const approve = (q: Q) =>
  outcome(
    as(
      org.users.office,
      (sql) =>
        sql(
          "update public.quotes set review_approved_at = now(), review_note = 'ok' where id = $1 and manual_review_required",
          [q.quoteId],
        ),
      { commit: true },
    ),
  );

// ═══════════════════════════════ M1 ═══════════════════════════════
describe("M1. renewal joins the per-visitor serialization of hold creation", () => {
  async function twoHolds() {
    const v = generateVisitorToken();
    const h1 = await quote();
    const h2 = await quote();
    const h3 = await quote(); // disjoint variant
    await hold(h1, v);
    await hold(h2, v);
    // H1 is about to expire.
    await admin(
      "update public.reservations set hold_expires_at = clock_timestamp() + interval '1500 milliseconds' where id = $1",
      [(await request(h1)).reservation_id],
    );
    return { v, vh: await hashVisitorToken(v), h1, h2, h3 };
  }
  const requestH3 = async (tx: Tx, s: Awaited<ReturnType<typeof twoHolds>>) =>
    tx.q("select * from public.request_booking_by_token($1, $2, 'web', null, $3)", [
      org.id,
      await hashQuoteToken(s.h3.token),
      s.vh,
    ]);

  for (const who of ["public", "staff"] as const) {
    it(`order 1 (${who} renews): uncommitted renewal of H1, then a new hold after H1's old expiry → refused`, async () => {
      const s = await twoHolds();
      const br1 = (await request(s.h1)).id;
      const a = await openTx(who === "staff" ? org.users.office : SYSTEM);
      await a.q("select public.renew_booking_hold($1)", [br1]); // valid renewal, not committed
      await sleep(1800); // H1's committed expiry has passed
      const b = await openTx(SYSTEM);
      const created = settle(requestH3(b, s));
      await waitUntilBlocked(b.pid); // B waits for the visitor lock held by the renewal
      expect(await waitingOn(b.pid)).toEqual(["advisory"]);
      await a.commit();
      expect(await created).toBe("RA015");
      await b.rollback();
      expect(await live(org, s.v)).toBe(2);
    });
  }

  it("order 2: a new hold after H1 expired, then a waiting renewal of H1 → refused; budget and expiry unchanged", async () => {
    const s = await twoHolds();
    await sleep(1800);
    const before = await holdState(s.h1);
    const b = await openTx(SYSTEM);
    await requestH3(b, s); // creates H3, not committed
    const a = await openTx(SYSTEM);
    const renewed = settle(a.q("select public.renew_booking_hold($1)", [(await request(s.h1)).id]));
    await waitUntilBlocked(a.pid);
    expect(await waitingOn(a.pid)).toEqual(["advisory"]);
    await b.commit();
    expect(await renewed).toBe("RA004");
    await a.rollback();
    expect(await holdState(s.h1)).toEqual(before);
    expect(await live(org, s.v)).toBe(2);
  });

  it("a renewal that would keep the visitor above the cap is refused without touching budget or expiry", async () => {
    const v = generateVisitorToken();
    const h1 = await quote(orgCap);
    const h2 = await quote(orgCap);
    await hold(h1, v);
    await hold(h2, v);
    await admin(
      "update public.organization_settings set max_public_holds_per_visitor = 1 where organization_id = $1",
      [orgCap.id],
    );
    const before = await holdState(h1);
    for (const actor of [SYSTEM, orgCap.users.office]) {
      expect(
        await outcome(rpc(actor, "select public.renew_booking_hold($1)", [(await request(h1)).id])),
      ).toBe("RA015");
    }
    expect(await holdState(h1)).toEqual(before);
    await admin(
      "update public.organization_settings set max_public_holds_per_visitor = 2 where organization_id = $1",
      [orgCap.id],
    );
  });

  it("manual staff holds carry no visitor identity and stay outside the public cap (regression)", async () => {
    const q = await quote();
    expect(
      await outcome(
        rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
      ),
    ).toBe("ok");
    expect(
      await outcome(
        rpc(org.users.office, "select public.renew_booking_hold($1)", [(await request(q)).id]),
      ),
    ).toBe("ok");
  });
});

// ═══════════════════════════════ M2 ═══════════════════════════════
describe("M2. a confirmed event's customer association is frozen", () => {
  async function confirmed() {
    const q = await quote();
    await approve(q);
    await hold(q, generateVisitorToken());
    const b = await request(q);
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [b.id])),
    ).toBe("ok");
    return { ...q, brId: b.id, reservationId: b.reservation_id };
  }
  const setEventCustomer = (eventId: string, customerId: string | null) =>
    outcome(
      as(
        org.users.office,
        (sql) =>
          sql("update public.events set customer_id = $2 where id = $1", [eventId, customerId]),
        { commit: true },
      ),
    );
  async function association(q: { quoteId: string; eventId: string }) {
    const r = await admin<{
      q: string;
      e: string | null;
      b: string | null;
      qs: string;
      bs: string | null;
    }>(
      `select q.customer_id q, e.customer_id e, q.status::text qs,
              (select b.customer_id from public.booking_requests b where b.quote_id = q.id order by b.created_at desc limit 1) b,
              (select b.status::text from public.booking_requests b where b.quote_id = q.id order by b.created_at desc limit 1) bs
       from public.quotes q join public.events e on e.id = q.event_id where q.id = $1`,
      [q.quoteId],
    );
    return r.rows[0]!;
  }

  it("customer A → B is refused; quote, request and reservation unchanged", async () => {
    const c = await confirmed();
    const other = await quote();
    const before = await association(c);
    expect(await setEventCustomer(c.eventId, other.customerId)).toBe("RA010");
    expect(await association(c)).toEqual(before);
    expect(before.e).toBe(before.q);
  });

  it("customer → NULL is refused", async () => {
    const c = await confirmed();
    const before = await association(c);
    expect(await setEventCustomer(c.eventId, null)).toBe("RA010");
    expect(await association(c)).toEqual(before);
  });

  it("race: a reassignment that waited behind the confirmation is refused after it commits", async () => {
    const q = await quote();
    const other = await quote();
    await approve(q);
    await hold(q, generateVisitorToken());
    const b = await request(q);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_booking_request($1)", [b.id]);
    const e = await openTx(org.users.office);
    const change = settle(
      e.q("update public.events set customer_id = $2 where id = $1", [q.eventId, other.customerId]),
    );
    await waitUntilBlocked(e.pid);
    await a.commit();
    expect(await change).toBe("RA010");
    await e.rollback();
    const s = await association(q);
    expect(s).toMatchObject({ qs: "accepted", bs: "confirmed" });
    expect(new Set([s.q, s.e, s.b]).size).toBe(1);
  });

  it("race: a reassignment first invalidates the pending booking; the waiting confirmation is refused", async () => {
    const q = await quote();
    const other = await quote();
    await approve(q);
    await hold(q, generateVisitorToken());
    const b = await request(q);
    const e = await openTx(org.users.office);
    await e.q("update public.events set customer_id = $2 where id = $1", [
      q.eventId,
      other.customerId,
    ]);
    const a = await openTx(org.users.office);
    const confirming = settle(a.q("select public.confirm_booking_request($1)", [b.id]));
    await waitUntilBlocked(a.pid);
    await e.commit();
    expect(await confirming).toBe("RA010");
    await a.rollback();
    const s = await association(q);
    expect(s.qs).not.toBe("accepted");
    expect(s.bs).toBe("cancelled");
    // The quote now disagrees with its event: it cannot be booked until reconciled.
    expect(
      await outcome(
        rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
      ),
    ).toBe("RA013");
  });
});
