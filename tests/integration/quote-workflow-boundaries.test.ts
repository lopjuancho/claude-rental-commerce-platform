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
import { makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway, price } from "./support/pricing";

/**
 * Codex review of M5 (b59a7ea): workflow boundaries between quotes, booking requests and holds.
 * Each block reproduces one finding; all of them failed before the fix.
 */
let org: TestOrg;
const EVENT = {
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
const meta = { ip: "198.51.100.9" };
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(8.2),
  rateLimit: () => Promise.resolve(),
});
const email = () => `w-${randomUUID().slice(0, 8)}@example.test`;
let day = 1;
const nextDate = () => `2027-08-${String(day++).padStart(2, "0")}`;

beforeAll(async () => {
  org = await createOrg("workflow");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
});

async function publicQuote(opts: { contact?: Record<string, unknown>; units?: number } = {}) {
  const p = await makeProduct(org, { units: opts.units ?? 1 });
  const { token } = await submitQuoteRequest(
    tenant(),
    {
      contact: opts.contact ?? { email: email() },
      event: { date: nextDate(), startTime: "12:00", endTime: "16:00", address: EVENT },
      items: [{ variantId: p.variantId, quantity: 1 }],
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
    ...p,
  };
}
const hold = (token: string) => requestPublicBooking(tenant(), token, {}, meta, deps());
const pending = async (quoteId: string) =>
  (
    await admin<{ id: string; status: string; reservation_id: string }>(
      "select id, status::text, reservation_id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
      [quoteId],
    )
  ).rows[0]!;
const resStatus = async (id: string) =>
  (
    await admin<{ status: string }>("select status::text from public.reservations where id = $1", [
      id,
    ])
  ).rows[0]!.status;
const approve = (quoteId: string) =>
  as(
    org.users.office,
    (sql) =>
      sql(
        "update public.quotes set review_approved_at = now(), review_note = 'checked' where id = $1",
        [quoteId],
      ),
    {
      commit: true,
    },
  );
const setStatus = (quoteId: string, status: string) =>
  outcome(
    as(
      org.users.office,
      (sql) => sql("update public.quotes set status = $2 where id = $1", [quoteId, status]),
      { commit: true },
    ),
  );
const confirm = (brId: string) =>
  outcome(rpc(org.users.office, "select public.confirm_booking_request($1)", [brId]));
async function reprice(quoteId: string) {
  const req = (
    await admin<{ price_request: unknown }>(
      "select price_request from public.quotes where id = $1",
      [quoteId],
    )
  ).rows[0]!.price_request;
  const run = await price(org.users.office, org, req, { save: true });
  return outcome(
    as(
      org.users.office,
      (sql) =>
        sql("update public.quotes set pricing_calculation_id = $2 where id = $1", [
          quoteId,
          run.calculationId,
        ]),
      {
        commit: true,
      },
    ),
  );
}

describe("1 + 7. a hold is bound to the exact quote revision, snapshot, items and event", () => {
  it("re-pricing a draft releases the old hold; that booking request can no longer be confirmed", async () => {
    const q = await publicQuote();
    await hold(q.token);
    const br = await pending(q.quoteId);
    expect(await reprice(q.quoteId)).toBe("ok");
    const after = await pending(q.quoteId);
    expect(after.status).toBe("cancelled");
    expect(await resStatus(br.reservation_id)).toBe("released");
    await approve(q.quoteId);
    expect(await confirm(br.id)).toBe("RA010");
  });

  it("revising a sent quote back to draft releases its hold", async () => {
    const q = await publicQuote();
    await approve(q.quoteId);
    expect(await setStatus(q.quoteId, "sent")).toBe("ok");
    await hold(q.token);
    const br = await pending(q.quoteId);
    expect(await setStatus(q.quoteId, "draft")).toBe("ok");
    expect((await pending(q.quoteId)).status).toBe("cancelled");
    expect(await resStatus(br.reservation_id)).toBe("released");
  });

  it("changing the event underneath the hold makes confirmation fail (no silent fix-up)", async () => {
    const q = await publicQuote();
    await hold(q.token);
    await approve(q.quoteId);
    await as(
      org.users.office,
      (sql) => sql("update public.events set end_time = '18:00' where id = $1", [q.eventId]),
      { commit: true },
    );
    const br = await pending(q.quoteId);
    expect(await confirm(br.id)).toBe("RA013");
    expect((await pending(q.quoteId)).status).toBe("pending");
  });

  it("held items that no longer match the quote's items make confirmation fail", async () => {
    const q = await publicQuote({ units: 2 });
    await hold(q.token);
    await approve(q.quoteId);
    const br = await pending(q.quoteId);
    // Tamper at the storage level: the hold now covers a different period than the quote.
    await admin(
      "update public.reservation_allocations set rental_period = tstzrange(lower(rental_period), upper(rental_period) + interval '1 hour') where reservation_id = $1",
      [br.reservation_id],
    );
    expect(await confirm(br.id)).toBe("RA013");
  });

  it("an expired hold is rejected at confirmation (a fresh booking request is required)", async () => {
    const q = await publicQuote();
    await hold(q.token);
    await approve(q.quoteId);
    const br = await pending(q.quoteId);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
      [br.reservation_id],
    );
    expect(await confirm(br.id)).toBe("RA004");
    // A fresh request creates a new hold for the same booking request, which then confirms.
    await hold(q.token);
    expect(await confirm(br.id)).toBe("ok");
  });

  it("the happy path still confirms: same revision, snapshot, items, event, live hold, review approved", async () => {
    const q = await publicQuote();
    await hold(q.token);
    await approve(q.quoteId);
    const br = await pending(q.quoteId);
    expect(await confirm(br.id)).toBe("ok");
    expect(await resStatus(br.reservation_id)).toBe("confirmed");
  });
});

describe("2. there is one confirmation path", () => {
  it("the generic reservation functions refuse holds that belong to a booking request", async () => {
    const q = await publicQuote();
    await hold(q.token);
    const br = await pending(q.quoteId);
    // Review NOT approved: the old endpoint must not be a way around it.
    expect(
      await outcome(
        rpc(org.users.office, "select public.confirm_reservation($1)", [br.reservation_id]),
      ),
    ).toBe("RA010");
    expect(
      await outcome(rpc(org.users.office, "select public.renew_hold($1)", [br.reservation_id])),
    ).toBe("RA010");
    expect(
      await outcome(
        rpc(org.users.office, "select public.release_reservation($1)", [br.reservation_id]),
      ),
    ).toBe("RA010");
    expect(
      await outcome(rpc(SYSTEM, "select public.confirm_reservation($1)", [br.reservation_id])),
    ).toMatch(/42501|RA010/);
    expect(await resStatus(br.reservation_id)).toBe("held");
  });

  it("manual staff holds that are not part of a quote still use the generic functions", async () => {
    const p = await makeProduct(org, { units: 1 });
    const [r] = await rpc<{ id: string }>(
      org.users.office,
      "select public.reserve_inventory($1, $2::jsonb, 'held', 'manual') as id",
      [
        org.id,
        JSON.stringify([
          {
            variant_id: p.variantId,
            quantity: 1,
            start: "2027-09-01T17:00:00Z",
            end: "2027-09-01T21:00:00Z",
          },
        ]),
      ],
    );
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_reservation($1)", [r!.id])),
    ).toBe("ok");
  });
});

describe("3. cancelling or declining the quote invalidates its hold", () => {
  it("cancel → hold released; renew, confirm and a new request are all refused", async () => {
    const q = await publicQuote();
    await hold(q.token);
    const br = await pending(q.quoteId);
    expect(await setStatus(q.quoteId, "cancelled")).toBe("ok");
    expect(await resStatus(br.reservation_id)).toBe("released");
    expect((await pending(q.quoteId)).status).toBe("cancelled");
    await expect(renewPublicHold(tenant(), q.token, meta, deps())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await confirm(br.id)).toBe("RA010");
    await expect(hold(q.token)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("decline (sent quote) → hold released and not renewable", async () => {
    const q = await publicQuote();
    await approve(q.quoteId);
    expect(await setStatus(q.quoteId, "sent")).toBe("ok");
    await hold(q.token);
    const br = await pending(q.quoteId);
    expect(await setStatus(q.quoteId, "declined")).toBe("ok");
    expect(await resStatus(br.reservation_id)).toBe("released");
    await expect(renewPublicHold(tenant(), q.token, meta, deps())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("expiry of the quote releases its hold too", async () => {
    const q = await publicQuote();
    await approve(q.quoteId);
    expect(await setStatus(q.quoteId, "sent")).toBe("ok");
    await hold(q.token);
    const br = await pending(q.quoteId);
    await admin("update public.quotes set expires_at = now() - interval '1 second' where id = $1", [
      q.quoteId,
    ]);
    await rpc(SYSTEM, "select public.expire_quotes()", []);
    expect(await resStatus(br.reservation_id)).toBe("released");
  });
});

describe("5. anonymous submissions cannot change an existing customer", () => {
  it("knowing a customer's email does not let a visitor add or change their name or phone", async () => {
    const e = email();
    const [c] = await rpc<{ id: string }>(
      org.users.office,
      "select public.match_or_create_customer($1, $2) as id",
      [org.id, JSON.stringify({ email: e })],
    );
    const q = await publicQuote({
      contact: {
        email: e.toUpperCase(),
        firstName: "Mallory",
        lastName: "Evil",
        phone: "+19015550199",
      },
    });
    expect(q.customerId).toBe(c!.id); // reuses the customer…
    const row = await admin<{
      first_name: string | null;
      last_name: string | null;
      phone_e164: string | null;
    }>("select first_name, last_name, phone_e164 from public.customers where id = $1", [c!.id]);
    expect(row.rows[0]).toEqual({ first_name: null, last_name: null, phone_e164: null }); // …but never changes it
    // What the visitor typed is kept with the quote for staff to review.
    const sub = await admin<{ submitted_contact: Record<string, unknown> }>(
      "select submitted_contact from public.quotes where id = $1",
      [q.quoteId],
    );
    expect(sub.rows[0]!.submitted_contact).toMatchObject({
      firstName: "Mallory",
      phone: "+19015550199",
    });
  });

  it("a visitor cannot attach a phone number that belongs to someone else's record either", async () => {
    const [c] = await rpc<{ id: string }>(
      org.users.office,
      "select public.match_or_create_customer($1, $2) as id",
      [org.id, JSON.stringify({ phone: "+19015550177", firstName: "Real" })],
    );
    const q = await publicQuote({
      contact: { phone: "(901) 555-0177", email: email(), firstName: "Mallory" },
    });
    expect(q.customerId).toBe(c!.id);
    const row = await admin<{ first_name: string; email: string | null }>(
      "select first_name, email from public.customers where id = $1",
      [c!.id],
    );
    expect(row.rows[0]).toEqual({ first_name: "Real", email: null });
  });

  it("staff can still fill in details explicitly", async () => {
    const e = email();
    const [c] = await rpc<{ id: string }>(
      org.users.office,
      "select public.match_or_create_customer($1, $2) as id",
      [org.id, JSON.stringify({ email: e })],
    );
    await as(
      org.users.office,
      (sql) => sql("update public.customers set first_name = 'Ana' where id = $1", [c!.id]),
      { commit: true },
    );
    expect(
      (
        await admin<{ f: string }>("select first_name f from public.customers where id = $1", [
          c!.id,
        ])
      ).rows[0]!.f,
    ).toBe("Ana");
  });
});

describe("6. the renewal budget belongs to the booking attempt, not to one hold", () => {
  it("cancel + request again cannot roll holds forever (budget = 1 hold + max renewals per quote revision)", async () => {
    // Default max_hold_renewals = 3 → at most 4 holds/extensions in total for this quote revision.
    const q = await publicQuote();
    await hold(q.token); // 1
    await renewPublicHold(tenant(), q.token, meta, deps()); // 2
    await cancelPublicBooking(tenant(), q.token, meta, deps());
    await hold(q.token); // 3
    await cancelPublicBooking(tenant(), q.token, meta, deps());
    await hold(q.token); // 4
    await expect(renewPublicHold(tenant(), q.token, meta, deps())).rejects.toMatchObject({
      code: "HOLD_RENEWAL_LIMIT",
    });
    await cancelPublicBooking(tenant(), q.token, meta, deps());
    await expect(hold(q.token)).rejects.toMatchObject({ code: "HOLD_RENEWAL_LIMIT" });
  });

  it("an expired hold re-requested also consumes the budget", async () => {
    const q = await publicQuote();
    for (let i = 0; i < 4; i++) {
      await hold(q.token);
      const br = await pending(q.quoteId);
      await admin(
        "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
        [br.reservation_id],
      );
    }
    await expect(hold(q.token)).rejects.toMatchObject({ code: "HOLD_RENEWAL_LIMIT" });
  });

  it("staff can always hold items for a customer (trusted; not limited by the public budget)", async () => {
    const q = await publicQuote();
    for (let i = 0; i < 4; i++) {
      await hold(q.token);
      await cancelPublicBooking(tenant(), q.token, meta, deps());
    }
    expect(
      await outcome(
        rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
      ),
    ).toBe("ok");
  });
});

describe("4. one lock order: request / renew / cancel / confirm / revise concurrently never deadlock", () => {
  it.each([1, 2, 3])("round %i: 40 mixed concurrent operations on shared quotes", async () => {
    const quotes = await Promise.all([0, 1, 2, 3].map(() => publicQuote({ units: 2 })));
    for (const q of quotes) await approve(q.quoteId);
    const ops: Promise<string>[] = [];
    for (let i = 0; i < 40; i++) {
      const q = quotes[i % quotes.length]!;
      const kind = i % 6;
      const op =
        kind === 0
          ? hold(q.token)
          : kind === 1
            ? renewPublicHold(tenant(), q.token, meta, deps())
            : kind === 2
              ? cancelPublicBooking(tenant(), q.token, meta, deps())
              : kind === 3
                ? admin<{ id: string }>(
                    "select id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
                    [q.quoteId],
                  ).then((r) =>
                    r.rows[0]
                      ? rpc(org.users.office, "select public.confirm_booking_request($1)", [
                          r.rows[0].id,
                        ])
                      : null,
                  )
                : kind === 4
                  ? reprice(q.quoteId)
                  : rpc(org.users.office, "select * from public.request_booking($1, 'admin')", [
                      q.quoteId,
                    ]);
      ops.push(outcome(op).then((o) => (typeof o === "string" ? o : "ok")));
    }
    const results = await Promise.all(ops);
    expect(results.filter((r) => r === "40P01")).toEqual([]); // no deadlocks
    expect(
      results.filter(
        (r) =>
          !/^(ok|RA0\d\d|NOT_FOUND|INVALID_STATE|HOLD_EXPIRED|HOLD_RENEWAL_LIMIT|INSUFFICIENT_AVAILABILITY|REVIEW_REQUIRED|BLOCKED|23505)$/.test(
            r,
          ),
      ),
    ).toEqual([]);
    // Invariants: at most one pending request per quote; every pending/confirmed request matches its quote's current revision.
    const bad = await admin(
      `select b.id from public.booking_requests b join public.quotes q on q.id = b.quote_id
       where b.status in ('pending', 'confirmed') and (b.quote_revision <> q.revision or b.pricing_calculation_id <> q.pricing_calculation_id)
         and q.organization_id = $1`,
      [org.id],
    );
    expect(bad.rows).toEqual([]);
    const confirmedWithoutAccept = await admin(
      `select b.id from public.booking_requests b join public.quotes q on q.id = b.quote_id
       where b.status = 'confirmed' and q.status <> 'accepted' and q.organization_id = $1`,
      [org.id],
    );
    expect(confirmedWithoutAccept.rows).toEqual([]);
  });
});
