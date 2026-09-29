import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { renewPublicHold, requestPublicBooking, submitQuoteRequest } from "@/server/public/quotes";
import { generateVisitorToken } from "@/server/visitor";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { openTx, settle, waitUntilBlocked } from "./support/tx";

/**
 * Codex review of 0040188: four HIGH findings at the quote / booking / inventory boundary.
 * Each block reproduces one finding; tests marked "(regression)" already passed before the fix
 * and pin behaviour the fix must keep.
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
const meta = { ip: "198.51.100.10" };
/** Each hold request comes from its own anonymous visitor (the per-visitor cap is tested separately). */
const visitorMeta = () => ({ ...meta, visitorToken: generateVisitorToken() });
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(8.2),
  rateLimit: () => Promise.resolve(),
});
let day = 0;
const nextDate = () => new Date(Date.UTC(2027, 9, 1 + day++)).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  org = await createOrg("round3");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
});

interface Q {
  token: string;
  quoteId: string;
  eventId: string;
  customerId: string;
}
async function publicQuote(
  opts: { variants?: string[]; units?: number; date?: string } = {},
): Promise<Q> {
  const variants = opts.variants ?? [
    (await makeProduct(org, { units: opts.units ?? 1 })).variantId,
  ];
  const { token } = await submitQuoteRequest(
    tenant(),
    {
      contact: { email: `r3-${randomUUID().slice(0, 8)}@example.test` },
      event: {
        date: opts.date ?? nextDate(),
        startTime: "12:00",
        endTime: "16:00",
        address: ADDRESS,
      },
      items: variants.map((variantId) => ({ variantId, quantity: 1 })),
    },
    meta,
    deps(),
  );
  const q = await admin<{ id: string; event_id: string; customer_id: string }>(
    "select id, event_id, customer_id from public.quotes where token_hash = $1",
    [await hashQuoteToken(token)],
  );
  return {
    token,
    quoteId: q.rows[0]!.id,
    eventId: q.rows[0]!.event_id,
    customerId: q.rows[0]!.customer_id,
  };
}
const hold = (token: string) => requestPublicBooking(tenant(), token, {}, visitorMeta(), deps());
const latest = async (quoteId: string) =>
  (
    await admin<{ id: string; status: string; reservation_id: string }>(
      "select id, status::text, reservation_id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
      [quoteId],
    )
  ).rows[0]!;
const one = async <T>(sql: string, params: unknown[]) =>
  (await admin<T & Record<string, unknown>>(sql, params)).rows[0]!;
const office = (sql: string, params: unknown[]) =>
  outcome(as(org.users.office, (q) => q(sql, params), { commit: true }));
const approve = (quoteId: string) =>
  office(
    "update public.quotes set review_approved_at = now(), review_note = 'checked' where id = $1 and manual_review_required",
    [quoteId],
  );
const confirm = (brId: string) =>
  outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [brId]));
const renew = (brId: string) =>
  outcome(rpc(org.users.office, "select public.renew_booking_hold($1)", [brId]));
async function sentQuote(opts: Parameters<typeof publicQuote>[0] = {}) {
  const q = await publicQuote(opts);
  await approve(q.quoteId);
  expect(await office("update public.quotes set status = 'sent' where id = $1", [q.quoteId])).toBe(
    "ok",
  );
  return q;
}
async function confirmedQuote() {
  const q = await publicQuote({ units: 2 });
  await approve(q.quoteId);
  await hold(q.token);
  const br = await latest(q.quoteId);
  expect(await confirm(br.id)).toBe("ok");
  return { ...q, brId: br.id, reservationId: br.reservation_id };
}
/** The confirmed reservation still describes the accepted quote and its event. */
async function consistent(q: { quoteId: string; reservationId: string }) {
  const r = await one<{ ok: boolean }>(
    `select app.reservation_signature($2) = app.quote_items_signature($1)
        and not exists (select 1 from public.reservation_allocations a join public.quotes q on q.id = $1
                        join public.events e on e.id = q.event_id
                        where a.reservation_id = $2 and a.rental_period <> tstzrange(e.starts_at, e.ends_at, '[)'))
        and (select status from public.reservations where id = $2) = 'confirmed'
        and (select status from public.quotes where id = $1) = 'accepted' as ok`,
    [q.quoteId, q.reservationId],
  );
  return r.ok;
}

// ═══════════════════════════════ HIGH 1 ═══════════════════════════════
describe("HIGH 1. an accepted quote / confirmed booking is frozen", () => {
  it("the event time cannot change", async () => {
    const q = await confirmedQuote();
    expect(
      await office("update public.events set end_time = '18:00' where id = $1", [q.eventId]),
    ).toBe("RA010");
    expect(
      await office("update public.events set event_date = event_date + 1 where id = $1", [
        q.eventId,
      ]),
    ).toBe("RA010");
    expect(await consistent(q)).toBe(true);
  });

  it("the event address cannot change", async () => {
    const q = await confirmedQuote();
    expect(
      await office("update public.events set address_line1 = '1 Elsewhere Ave' where id = $1", [
        q.eventId,
      ]),
    ).toBe("RA010");
    expect(
      await office("update public.events set postal_code = '38139' where id = $1", [q.eventId]),
    ).toBe("RA010");
    expect(await consistent(q)).toBe(true);
  });

  it("non-critical event details (notes, guest count) can still be edited", async () => {
    const q = await confirmedQuote();
    expect(
      await office(
        "update public.events set notes = 'gate code 1234', guest_count = 30 where id = $1",
        [q.eventId],
      ),
    ).toBe("ok");
  });

  it("the customer and event links cannot change", async () => {
    const q = await confirmedQuote();
    const other = await publicQuote();
    expect(
      await office("update public.quotes set customer_id = $2 where id = $1", [
        q.quoteId,
        other.customerId,
      ]),
    ).toBe("RA010");
    expect(
      await office("update public.quotes set event_id = $2 where id = $1", [
        q.quoteId,
        other.eventId,
      ]),
    ).toBe("RA010");
    expect(await consistent(q)).toBe(true);
  });

  it("the pricing snapshot and price request cannot change (regression)", async () => {
    const q = await confirmedQuote();
    const other = await publicQuote();
    const calc = await one<{ c: string }>(
      "select pricing_calculation_id c from public.quotes where id = $1",
      [other.quoteId],
    );
    expect(
      await office("update public.quotes set pricing_calculation_id = $2 where id = $1", [
        q.quoteId,
        calc.c,
      ]),
    ).toBe("RA010");
    expect(
      await office(
        'update public.quotes set price_request = price_request || \'{"discountCodes":["X"]}\' where id = $1',
        [q.quoteId],
      ),
    ).toBe("RA010");
    expect(await consistent(q)).toBe(true);
  });

  it("items and quantities cannot be written directly (regression)", async () => {
    const q = await confirmedQuote();
    expect(
      await office("update public.quote_items set quantity = 2 where quote_id = $1", [q.quoteId]),
    ).toBe("42501");
    expect(await office("delete from public.quote_items where quote_id = $1", [q.quoteId])).toBe(
      "42501",
    );
    expect(
      await office(
        "update public.reservation_allocations set quantity = 2 where reservation_id = $1",
        [q.reservationId],
      ),
    ).toBe("42501");
    expect(await consistent(q)).toBe(true);
  });

  it("the confirmed reservation cannot be released, re-held or replaced through the generic functions (regression)", async () => {
    const q = await confirmedQuote();
    for (const fn of ["release_reservation", "renew_hold", "confirm_reservation"]) {
      expect(
        await outcome(rpc(org.users.office, `select public.${fn}($1)`, [q.reservationId])),
      ).toBe("RA010");
    }
    expect(await consistent(q)).toBe(true);
  });

  it("a pending quote-managed hold cannot be replaced through reserve_inventory", async () => {
    const q = await publicQuote({ units: 2 });
    await hold(q.token);
    const br = await latest(q.quoteId);
    const item = await one<{ v: string; s: Date; e: Date }>(
      "select variant_id v, lower(rental_period) s, upper(rental_period) e from public.quote_items where quote_id = $1",
      [q.quoteId],
    );
    expect(
      await outcome(
        rpc(
          org.users.office,
          "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual', $3)",
          [
            org.id,
            JSON.stringify([
              {
                variant_id: item.v,
                quantity: 2,
                start: item.s.toISOString(),
                end: item.e.toISOString(),
              },
            ]),
            br.reservation_id,
          ],
        ),
      ),
    ).toBe("RA010");
  });

  it("an event edit that waited behind the confirmation is refused once the booking is confirmed", async () => {
    const q = await publicQuote();
    await approve(q.quoteId);
    await hold(q.token);
    const br = await latest(q.quoteId);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_booking_request($1)", [br.id]);
    const b = await openTx(org.users.office);
    const edit = settle(
      b.q("update public.events set end_time = '18:00' where id = $1", [q.eventId]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await edit).toBe("RA010");
    await b.rollback();
    expect(await consistent({ quoteId: q.quoteId, reservationId: br.reservation_id })).toBe(true);
  });
});

// ═══════════════════════════════ HIGH 2 ═══════════════════════════════
describe("HIGH 2. event validity is judged against the immutable pricing snapshot", () => {
  it("the snapshot records the priced delivery destination", async () => {
    const q = await publicQuote();
    const r = await one<{ d: Record<string, unknown> | null }>(
      `select c.input -> 'destination' d from public.quotes q join public.pricing_calculations c on c.id = q.pricing_calculation_id
       where q.id = $1`,
      [q.quoteId],
    );
    expect(r.d).toMatchObject(ADDRESS);
  });

  it("a pickup quote records no destination; only its times bind it to the event", async () => {
    const p = await makeProduct(org, { units: 1 });
    const { token } = await submitQuoteRequest(
      tenant(),
      {
        contact: { email: `r3-${randomUUID().slice(0, 8)}@example.test` },
        event: { date: nextDate(), startTime: "12:00", endTime: "16:00", address: ADDRESS },
        items: [{ variantId: p.variantId, quantity: 1 }],
        delivery: "pickup",
      },
      meta,
      deps(),
    );
    const r = await one<{ d: unknown; s: string; e: string }>(
      `select c.input -> 'destination' d, c.input #>> '{delivery,status}' s, q.event_id::text e
       from public.quotes q join public.pricing_calculations c on c.id = q.pricing_calculation_id
       where q.token_hash = $1`,
      [await hashQuoteToken(token)],
    );
    expect(r.d).toBeNull();
    expect(r.s).toBe("not_requested");
    // The address was not priced, so editing it does not make the quote stale…
    expect(
      await office("update public.events set address_line1 = '9 Pickup Ln' where id = $1", [r.e]),
    ).toBe("ok");
    await hold(token);
    // …but its times were.
    const q2 = await publicQuote();
    expect(
      await office("update public.events set end_time = '17:00' where id = $1", [q2.eventId]),
    ).toBe("ok");
    await expect(hold(q2.token)).rejects.toMatchObject({ code: "STALE_BOOKING_REQUEST" });
  });

  it("rewriting price_request to match a changed address cannot make the stale quote valid", async () => {
    const q = await publicQuote();
    expect(
      await office("update public.events set address_line1 = '100 Other St' where id = $1", [
        q.eventId,
      ]),
    ).toBe("ok");
    expect(
      await office(
        `update public.quotes set price_request = jsonb_set(price_request, '{eventAddress,line1}', '"100 Other St"') where id = $1`,
        [q.quoteId],
      ),
    ).toBe("ok");
    await expect(hold(q.token)).rejects.toMatchObject({ code: "STALE_BOOKING_REQUEST" });
    expect(
      await outcome(
        rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
      ),
    ).toBe("RA013");
  });

  it("a time mismatch is detected from the snapshot even if price_request is rewritten (regression)", async () => {
    const q = await publicQuote();
    expect(
      await office("update public.events set end_time = '18:00' where id = $1", [q.eventId]),
    ).toBe("ok");
    const e = await one<{ s: Date; e: Date }>(
      "select starts_at s, ends_at e from public.events where id = $1",
      [q.eventId],
    );
    expect(
      await office(
        `update public.quotes set price_request = jsonb_set(price_request, '{items}',
           (select jsonb_agg(i || jsonb_build_object('start', $2::text, 'end', $3::text)) from jsonb_array_elements(price_request -> 'items') i))
         where id = $1`,
        [q.quoteId, e.s.toISOString(), e.e.toISOString()],
      ),
    ).toBe("ok");
    await expect(hold(q.token)).rejects.toMatchObject({ code: "STALE_BOOKING_REQUEST" });
  });

  it("request, renewal and confirmation all apply the same snapshot comparison", async () => {
    const q = await publicQuote();
    await approve(q.quoteId);
    await hold(q.token);
    const br = await latest(q.quoteId);
    // Storage-level drift (every trigger bypassed): the event and price_request agree, the snapshot does not.
    await admin(
      `do $$ begin
         set local session_replication_role = replica;
         update public.events set address_line1 = '100 Other St' where id = '${q.eventId}';
         update public.quotes set price_request = jsonb_set(price_request, '{eventAddress,line1}', '"100 Other St"')
         where id = '${q.quoteId}';
         update public.booking_requests set event_signature = app.event_signature('${q.eventId}') where id = '${br.id}';
       end $$`,
    );
    expect(await renew(br.id)).toBe("RA013");
    expect(await confirm(br.id)).toBe("RA013");
    expect(
      await outcome(
        rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
      ),
    ).toBe("RA013");
  });
});

// ═══════════════════════════════ HIGH 3 ═══════════════════════════════
describe("HIGH 3. quote expiry and holds stay consistent, decided after the lock waits", () => {
  it("a hold never outlives its quote", async () => {
    const q = await sentQuote();
    await admin(
      "update public.quotes set expires_at = clock_timestamp() + interval '2 minutes' where id = $1",
      [q.quoteId],
    );
    await hold(q.token);
    const r = await one<{ ok: boolean }>(
      `select r.hold_expires_at <= q.expires_at ok from public.quotes q join public.booking_requests b on b.quote_id = q.id
       join public.reservations r on r.id = b.reservation_id where q.id = $1 and b.status = 'pending'`,
      [q.quoteId],
    );
    expect(r.ok).toBe(true);
  });

  it("shortening a quote's validity shortens its pending hold in the same transaction", async () => {
    const q = await sentQuote();
    await hold(q.token);
    expect(
      await office(
        "update public.quotes set expires_at = clock_timestamp() + interval '1 minute' where id = $1",
        [q.quoteId],
      ),
    ).toBe("ok");
    const r = await one<{ ok: boolean }>(
      `select r.hold_expires_at <= q.expires_at ok from public.quotes q join public.booking_requests b on b.quote_id = q.id
       join public.reservations r on r.id = b.reservation_id where q.id = $1 and b.status = 'pending'`,
      [q.quoteId],
    );
    expect(r.ok).toBe(true);
  });

  it("expire_quotes releases the hold and closes the request (regression)", async () => {
    const q = await sentQuote();
    await hold(q.token);
    const br = await latest(q.quoteId);
    await admin("update public.quotes set expires_at = now() - interval '1 second' where id = $1", [
      q.quoteId,
    ]);
    await rpc(SYSTEM, "select public.expire_quotes()", []);
    expect((await latest(q.quoteId)).status).toBe("cancelled");
    expect(
      (
        await one<{ s: string }>("select status::text s from public.reservations where id = $1", [
          br.reservation_id,
        ])
      ).s,
    ).toBe("released");
  });

  it("confirmation that waited while the quote expired refuses after acquiring the lock", async () => {
    const q = await sentQuote();
    await hold(q.token);
    const br = await latest(q.quoteId);
    const b = await openTx(org.users.office);
    // B holds the quote row and moves its expiry to ~1s from now, then keeps the lock past it.
    await b.q(
      "update public.quotes set expires_at = clock_timestamp() + interval '1 second' where id = $1",
      [q.quoteId],
    );
    const a = await openTx(org.users.office); // A's transaction (and now()) starts before the expiry
    const res = settle(a.q("select public.confirm_booking_request($1)", [br.id]));
    await waitUntilBlocked(a.pid);
    await sleep(1600);
    await b.commit();
    expect(await res).toBe("RA009");
    await a.rollback();
  });

  it("renewal that waited across the hold's expiry fails after acquiring the lock", async () => {
    const q = await sentQuote();
    await hold(q.token);
    const br = await latest(q.quoteId);
    await admin(
      "update public.reservations set hold_expires_at = clock_timestamp() + interval '1 second' where id = $1",
      [br.reservation_id],
    );
    const b = await openTx(org.users.office);
    await b.q("update public.quotes set internal_notes = 'busy' where id = $1", [q.quoteId]);
    const a = await openTx(SYSTEM);
    const res = settle(a.q("select public.renew_booking_hold($1)", [br.id]));
    await waitUntilBlocked(a.pid);
    await sleep(1600);
    await b.commit();
    expect(await res).toBe("RA004");
    await a.rollback();
  });

  it("confirmation that waited across the hold's expiry fails after acquiring the lock", async () => {
    const q = await sentQuote();
    await hold(q.token);
    const br = await latest(q.quoteId);
    await admin(
      "update public.reservations set hold_expires_at = clock_timestamp() + interval '1 second' where id = $1",
      [br.reservation_id],
    );
    const b = await openTx(org.users.office);
    await b.q("update public.quotes set internal_notes = 'busy' where id = $1", [q.quoteId]);
    const a = await openTx(org.users.office);
    const res = settle(a.q("select public.confirm_booking_request($1)", [br.id]));
    await waitUntilBlocked(a.pid);
    await sleep(1600);
    await b.commit();
    expect(await res).toBe("RA004");
    await a.rollback();
  });

  it.each([1, 2, 3])(
    "round %i: confirm / renew / request / sweep / expire racing across quote expiry leave no live hold on an expired quote",
    async () => {
      const quotes = await Promise.all([0, 1, 2, 3, 4, 5].map(() => sentQuote({ units: 2 })));
      for (const q of quotes) await hold(q.token);
      // All quotes expire ~700 ms from now; operations run before, during and after that moment.
      await admin(
        "update public.quotes set expires_at = clock_timestamp() + interval '700 milliseconds' where id = any($1::uuid[])",
        [quotes.map((q) => q.quoteId)],
      );
      const ops: Promise<string>[] = [];
      for (let i = 0; i < 36; i++) {
        const q = quotes[i % quotes.length]!;
        const run = async (): Promise<unknown> => {
          await sleep((i % 9) * 120);
          switch (i % 6) {
            case 0:
              return rpc(org.users.office, "select public.confirm_booking_request($1)", [
                (await latest(q.quoteId)).id,
              ]);
            case 1:
              return renewPublicHold(tenant(), q.token, meta, deps());
            case 2:
              return hold(q.token);
            case 3:
              return rpc(SYSTEM, "select public.sweep_expired_holds()", []);
            case 4:
              return rpc(SYSTEM, "select public.expire_quotes()", []);
            default:
              return rpc(org.users.office, "select public.close_booking_request($1, 'cancelled')", [
                (await latest(q.quoteId)).id,
              ]);
          }
        };
        ops.push(outcome(run()));
      }
      const results = await Promise.all(ops);
      expect(results.filter((r) => r === "40P01")).toEqual([]);
      const ids = quotes.map((q) => q.quoteId);
      // Invariant: an expired quote never retains a live hold (checked at the current clock).
      const live = await admin(
        `select r.id from public.quotes q join public.booking_requests b on b.quote_id = q.id
         join public.reservations r on r.id = b.reservation_id
         where q.id = any($1::uuid[]) and q.expires_at <= clock_timestamp() and r.status = 'held'
           and r.hold_expires_at > clock_timestamp()`,
        [ids],
      );
      expect(live.rows).toEqual([]);
      // Consistent states: accepted only with a confirmed request made before expiry; no confirmed request
      // without a confirmed reservation; an expired quote has no pending request once swept.
      await rpc(SYSTEM, "select public.expire_quotes()", []);
      const bad = await admin(
        `select b.id from public.booking_requests b join public.quotes q on q.id = b.quote_id
         join public.reservations r on r.id = b.reservation_id
         where q.id = any($1::uuid[]) and (
           (b.status = 'confirmed' and (r.status <> 'confirmed' or q.status <> 'accepted' or q.accepted_at > q.expires_at))
           or (b.status = 'pending' and q.status in ('expired', 'cancelled', 'declined'))
           or (b.status in ('cancelled', 'declined') and r.status = 'held' and r.hold_expires_at > clock_timestamp()))`,
        [ids],
      );
      expect(bad.rows).toEqual([]);
    },
  );
});

// ═══════════════════════════════ HIGH 4 ═══════════════════════════════
describe("HIGH 4. one canonical order for all variant / inventory locks", () => {
  async function twoVariants(units = 4) {
    const a = await makeProduct(org, { units });
    const b = await makeProduct(org, { units });
    return [a.variantId, b.variantId].sort() as [string, string];
  }
  const items = (vs: string[], date: string) =>
    JSON.stringify(
      vs.map((v) => ({
        variant_id: v,
        quantity: 1,
        start: `${date}T17:00:00Z`,
        end: `${date}T21:00:00Z`,
      })),
    );
  const block = (
    tx: { q: (s: string, p?: unknown[]) => Promise<unknown> },
    variantId: string,
    date: string,
  ) =>
    tx.q(
      `insert into public.availability_blocks (organization_id, variant_id, period, reason)
       values ($1, $2, tstzrange($3::timestamptz, $4::timestamptz), 'maintenance')`,
      [org.id, variantId, `${date}T00:00:00Z`, `${date}T01:00:00Z`],
    );

  it("an out-of-order variant lock is refused (never waited on) — the canonical order is enforced", async () => {
    const [lo, hi] = await twoVariants();
    expect(
      await outcome(
        admin(`do $$ begin perform app.lock_variants('${org.id}', array['${hi}']::uuid[]);
                           perform app.lock_variants('${org.id}', array['${lo}']::uuid[]); end $$`),
      ),
    ).toBe("RA014");
    // Ascending acquisition, and re-acquiring locks already held, are fine.
    expect(
      await outcome(
        admin(`do $$ begin perform app.lock_variants('${org.id}', array['${lo}']::uuid[]);
                           perform app.lock_variants('${org.id}', array['${hi}', '${lo}']::uuid[]); end $$`),
      ),
    ).toBe("ok");
  });

  it("two reservations of the same two variants in reverse input order never deadlock (regression)", async () => {
    const [lo, hi] = await twoVariants(40);
    const ops: Promise<string>[] = [];
    for (let i = 0; i < 30; i++) {
      const date = nextDate();
      ops.push(
        outcome(
          rpc(
            org.users.office,
            "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual')",
            [org.id, items([lo, hi], date)],
          ),
        ),
        outcome(
          rpc(
            org.users.office,
            "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual')",
            [org.id, items([hi, lo], date)],
          ),
        ),
      );
    }
    const r = await Promise.all(ops);
    expect(r.filter((x) => x === "40P01")).toEqual([]);
  });

  it("blocks created one variant at a time, highest first, do not deadlock against a reservation of both", async () => {
    const [lo, hi] = await twoVariants();
    const date = nextDate();
    const b = await openTx(org.users.office);
    await block(b, hi, date); // B holds `hi`…
    const a = await openTx(org.users.office);
    const res = settle(
      a.q("select public.reserve_inventory($1, $2::jsonb, 'held', 'manual')", [
        org.id,
        items([lo, hi], date),
      ]),
    );
    await waitUntilBlocked(a.pid);
    const second = settle(block(b, lo, date)); // …and now wants `lo`
    const outcomes = await Promise.race([
      second.then((s) => ({ second: s })),
      sleep(3000).then(() => ({ second: "timeout" })),
    ]);
    if (outcomes.second === "ok") await b.commit();
    else await b.rollback();
    const all = [outcomes.second, await res];
    await a.rollback();
    expect(all.filter((x) => x === "40P01")).toEqual([]);
    expect(outcomes.second).toBe("ok");
  });

  it("bulk quote expiry does not deadlock against a transaction holding one of those quotes", async () => {
    const [v] = await twoVariants();
    const date = nextDate();
    const q1 = await sentQuote({ variants: [v], date });
    const q2 = await sentQuote({ variants: [v], date });
    await hold(q1.token);
    await admin(
      "update public.quotes set expires_at = now() - interval '1 second' where id = any($1::uuid[])",
      [[q1.quoteId, q2.quoteId]],
    );
    const c = await openTx(org.users.office);
    await c.q("update public.quotes set internal_notes = 'busy' where id = $1", [q2.quoteId]); // C holds q2
    const a = await openTx(SYSTEM);
    const expiring = settle(a.q("select public.expire_quotes()"));
    // A either finishes (skipping the locked quote) or waits for C; C then needs the variant A may hold.
    await Promise.race([expiring, sleep(500)]);
    const cBlock = settle(block(c, v, nextDate()));
    const results = await Promise.all([
      expiring.then(async (x) => {
        await a.commit();
        return x;
      }),
      cBlock.then(async (x) => {
        if (x === "ok") await c.commit();
        else await c.rollback();
        return x;
      }),
    ]);
    expect(results.filter((x) => x === "40P01")).toEqual([]);
    expect(results).toEqual(["ok", "ok"]);
  });

  it("confirmation vs a product-wide block and a multi-variant block (regression)", async () => {
    const [lo, hi] = await twoVariants();
    const q = await publicQuote({ variants: [hi, lo] });
    await approve(q.quoteId);
    await hold(q.token);
    const br = await latest(q.quoteId);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_booking_request($1)", [br.id]);
    const b = await openTx(org.users.office);
    const blk = settle(block(b, lo, nextDate()));
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await blk).toBe("ok");
    await b.commit();
  });

  it.each([1, 2, 3])(
    "round %i: reversed input orders across reservations, quotes, bulk blocks, bulk product edits, expiry and sweeps",
    async () => {
      const [lo, hi] = await twoVariants(60);
      const products = await admin<{ product_id: string }>(
        "select product_id from public.product_variants where id = any($1::uuid[]) order by id desc",
        [[lo, hi]],
      );
      const pids = products.rows.map((r) => r.product_id);
      const date = nextDate();
      const qs = await Promise.all([
        sentQuote({ variants: [lo, hi], date }),
        sentQuote({ variants: [hi, lo], date }),
        sentQuote({ variants: [hi, lo], date }),
        sentQuote({ variants: [lo, hi], date }),
      ]);
      const ops: Promise<string>[] = [];
      for (let i = 0; i < 48; i++) {
        const q = qs[i % qs.length]!;
        const order = i % 2 === 0 ? [lo, hi] : [hi, lo];
        const run = (): Promise<unknown> => {
          switch (i % 8) {
            case 0:
              return rpc(
                org.users.office,
                "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual')",
                [org.id, items(order, date)],
              );
            case 1:
              return hold(q.token);
            case 2:
              return latest(q.quoteId)
                .catch(() => null)
                .then((b) =>
                  b
                    ? rpc(org.users.office, "select public.confirm_booking_request($1)", [b.id])
                    : null,
                );
            case 3:
              // One statement, two rows, descending variant order.
              return as(
                org.users.office,
                (sql) =>
                  sql(
                    `insert into public.availability_blocks (organization_id, variant_id, period, reason)
                     select $1, v, tstzrange($3::timestamptz, $4::timestamptz), 'maintenance' from unnest($2::uuid[]) v`,
                    [org.id, order, `${date}T02:00:00Z`, `${date}T03:00:00Z`],
                  ),
                { commit: true },
              );
            case 4:
              return as(
                org.users.office,
                (sql) =>
                  sql("update public.products set name = name where id = any($1::uuid[])", [
                    i % 16 < 8 ? pids : [...pids].reverse(),
                  ]),
                { commit: true },
              );
            case 5:
              return rpc(SYSTEM, "select public.sweep_expired_holds()", []);
            case 6:
              return rpc(SYSTEM, "select public.expire_quotes()", []);
            default:
              return renewPublicHold(tenant(), q.token, meta, deps());
          }
        };
        ops.push(outcome(run()));
      }
      const results = await Promise.all(ops);
      expect(results.filter((r) => r === "40P01" || r === "RA014")).toEqual([]);
    },
  );
});
