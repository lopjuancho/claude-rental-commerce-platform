import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  cancelPublicBooking,
  renewPublicHold,
  requestPublicBooking,
  submitQuoteRequest,
} from "@/server/public/quotes";
import { generateVisitorToken, hashVisitorToken } from "@/server/visitor";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct, outcome, rpc, SYSTEM } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { openTx, settle, waitUntilBlocked } from "./support/tx";

/**
 * M3 decision: at most 2 concurrent live PUBLIC holds per anonymous visitor per organization.
 * The visitor is a server-issued opaque token (cookie); only its hash reaches the database.
 * Emails and IPs are not the identity; staff holds are exempt; the check is atomic in PostgreSQL.
 */
let orgA: TestOrg;
let orgB: TestOrg;
const ADDRESS = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
const tenantOf = (org: TestOrg) =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: org.slug,
    timezone: "America/Chicago",
  }) as unknown as ResolvedTenant;
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(8.2),
  rateLimit: () => Promise.resolve(),
});
let day = 0;
const nextDate = () => new Date(Date.UTC(2028, 0, 1 + day++)).toISOString().slice(0, 10);
const metaFor = (visitorToken?: string) => ({
  ip: "198.51.100.12",
  ...(visitorToken === undefined ? {} : { visitorToken }),
});

async function setup(org: TestOrg) {
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
}
beforeAll(async () => {
  orgA = await createOrg("cap-a");
  orgB = await createOrg("cap-b");
  await setup(orgA);
  await setup(orgB);
});

async function quote(org: TestOrg = orgA, email = `cap-${randomUUID().slice(0, 8)}@example.test`) {
  const p = await makeProduct(org, { units: 2 });
  const { token } = await submitQuoteRequest(
    tenantOf(org),
    {
      contact: { email },
      event: { date: nextDate(), startTime: "12:00", endTime: "16:00", address: ADDRESS },
      items: [{ variantId: p.variantId, quantity: 1 }],
    },
    metaFor(),
    deps(),
  );
  const q = await admin<{ id: string }>("select id from public.quotes where token_hash = $1", [
    await hashQuoteToken(token),
  ]);
  return { token, quoteId: q.rows[0]!.id, org };
}
type Q = Awaited<ReturnType<typeof quote>>;
const hold = (q: Q, visitor: string | undefined) =>
  requestPublicBooking(tenantOf(q.org), q.token, {}, metaFor(visitor), deps());
const tryHold = (q: Q, visitor: string | undefined) =>
  hold(q, visitor).then(
    () => "ok",
    (e: unknown) => (e as { code?: string }).code ?? "error",
  );
const latest = async (quoteId: string) =>
  (
    await admin<{ id: string; reservation_id: string }>(
      "select id, reservation_id from public.booking_requests where quote_id = $1 order by created_at desc limit 1",
      [quoteId],
    )
  ).rows[0];
async function liveHolds(org: TestOrg, visitor: string) {
  const r = await admin<{ n: number }>(
    `select count(*)::int n from public.reservations
     where organization_id = $1 and public_visitor_hash = $2 and status = 'held' and hold_expires_at > clock_timestamp()`,
    [org.id, await hashVisitorToken(visitor)],
  );
  return r.rows[0]!.n;
}

describe("per-visitor cap on live public holds (default 2 per organization)", () => {
  it("1. two live holds → a third hold on a different quote is refused (nothing created)", async () => {
    const v = generateVisitorToken();
    const [q1, q2, q3] = [await quote(), await quote(), await quote()];
    await hold(q1, v);
    await hold(q2, v);
    await expect(hold(q3, v)).rejects.toMatchObject({ code: "PUBLIC_HOLD_LIMIT" });
    expect(await latest(q3.quoteId)).toBeUndefined();
    const budget = await admin("select 1 from public.quote_hold_budgets where quote_id = $1", [
      q3.quoteId,
    ]);
    expect(budget.rows).toEqual([]); // the refusal consumed no per-quote budget
    expect(await liveHolds(orgA, v)).toBe(2);
  });

  it("2. cancelling one hold allows another", async () => {
    const v = generateVisitorToken();
    const [q1, q2, q3] = [await quote(), await quote(), await quote()];
    await hold(q1, v);
    await hold(q2, v);
    await cancelPublicBooking(tenantOf(orgA), q1.token, metaFor(v), deps());
    expect(await tryHold(q3, v)).toBe("ok");
  });

  it("3. an expired hold no longer counts", async () => {
    const v = generateVisitorToken();
    const [q1, q2, q3] = [await quote(), await quote(), await quote()];
    await hold(q1, v);
    await hold(q2, v);
    await admin(
      "update public.reservations set hold_expires_at = clock_timestamp() - interval '1 second' where id = $1",
      [(await latest(q1.quoteId))!.reservation_id],
    );
    expect(await tryHold(q3, v)).toBe("ok");
  });

  it("4. a confirmed booking is no longer a live public hold", async () => {
    const v = generateVisitorToken();
    const [q1, q2, q3] = [await quote(), await quote(), await quote()];
    await hold(q1, v);
    await hold(q2, v);
    await as(
      orgA.users.office,
      (sql) =>
        sql(
          "update public.quotes set review_approved_at = now(), review_note = 'ok' where id = $1 and manual_review_required",
          [q1.quoteId],
        ),
      { commit: true },
    );
    expect(
      await outcome(
        rpc(orgA.users.office, "select public.confirm_booking_request($1)", [
          (await latest(q1.quoteId))!.id,
        ]),
      ),
    ).toBe("ok");
    expect(await tryHold(q3, v)).toBe("ok");
  });

  it("5. a new quote does not reset the cap", async () => {
    const v = generateVisitorToken();
    await hold(await quote(), v);
    await hold(await quote(), v);
    const fresh = await quote(); // same visitor asks for yet another quote
    expect(await tryHold(fresh, v)).toBe("PUBLIC_HOLD_LIMIT");
  });

  it("6a. two concurrent requests when the visitor already has 1 cannot produce 3 live holds (deterministic)", async () => {
    const v = generateVisitorToken();
    const [q1, q2, q3] = [await quote(), await quote(), await quote()];
    await hold(q1, v);
    const vh = await hashVisitorToken(v);
    const a = await openTx(SYSTEM);
    await a.q("select * from public.request_booking_by_token($1, $2, 'web', null, $3)", [
      orgA.id,
      await hashQuoteToken(q2.token),
      vh,
    ]); // A: second hold, not yet committed
    const b = await openTx(SYSTEM);
    const second = settle(
      b.q("select * from public.request_booking_by_token($1, $2, 'web', null, $3)", [
        orgA.id,
        await hashQuoteToken(q3.token),
        vh,
      ]),
    );
    await waitUntilBlocked(b.pid); // B waits on the visitor's lock
    await a.commit();
    expect(await second).toBe("RA015");
    await b.rollback();
    expect(await liveHolds(orgA, v)).toBe(2);
  });

  it.each([1, 2, 3])(
    "6b. round %i: 6 concurrent requests from one visitor with 1 live hold → exactly 1 more",
    async () => {
      const v = generateVisitorToken();
      const qs = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(() => quote()));
      await hold(qs[0]!, v);
      const results = await Promise.all(qs.slice(1).map((q) => tryHold(q, v)));
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
      expect(results.filter((r) => r === "PUBLIC_HOLD_LIMIT")).toHaveLength(5);
      expect(await liveHolds(orgA, v)).toBe(2);
    },
  );

  it("7. different visitors are independent", async () => {
    const v1 = generateVisitorToken();
    const v2 = generateVisitorToken();
    await hold(await quote(), v1);
    await hold(await quote(), v1);
    expect(await tryHold(await quote(), v1)).toBe("PUBLIC_HOLD_LIMIT");
    expect(await tryHold(await quote(), v2)).toBe("ok");
    expect(await tryHold(await quote(), v2)).toBe("ok");
  });

  it("8. different organizations are independent (same visitor token)", async () => {
    const v = generateVisitorToken();
    await hold(await quote(orgA), v);
    await hold(await quote(orgA), v);
    expect(await tryHold(await quote(orgA), v)).toBe("PUBLIC_HOLD_LIMIT");
    expect(await tryHold(await quote(orgB), v)).toBe("ok");
    expect(await tryHold(await quote(orgB), v)).toBe("ok");
    expect(await tryHold(await quote(orgB), v)).toBe("PUBLIC_HOLD_LIMIT");
  });

  it("9. staff holds are exempt and do not count for the visitor", async () => {
    const v = generateVisitorToken();
    await hold(await quote(), v);
    await hold(await quote(), v);
    for (let i = 0; i < 3; i++) {
      const q = await quote();
      expect(
        await outcome(
          rpc(orgA.users.office, "select * from public.request_booking($1, 'admin')", [q.quoteId]),
        ),
      ).toBe("ok");
    }
    expect(await liveHolds(orgA, v)).toBe(2);
    const staffHolds = await admin<{ n: number }>(
      `select count(*)::int n from public.reservations where organization_id = $1 and status = 'held'
         and public_visitor_hash is null and source = 'booking_request'`,
      [orgA.id],
    );
    expect(staffHolds.rows[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it("10. a missing or malformed visitor token is refused safely (no hold, no budget)", async () => {
    const q = await quote();
    for (const bad of [undefined, "", "short", "x".repeat(43) + "!", "a".repeat(200)]) {
      await expect(hold(q, bad)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    // The trusted function itself refuses a public hold without a well-formed visitor hash.
    for (const bad of [null, "", "not-a-hash", "A".repeat(64)]) {
      expect(
        await outcome(
          rpc(SYSTEM, "select * from public.request_booking_by_token($1, $2, 'web', null, $3)", [
            orgA.id,
            await hashQuoteToken(q.token),
            bad,
          ]),
        ),
      ).toBe("RA006");
    }
    expect(await latest(q.quoteId)).toBeUndefined();
    const budget = await admin("select 1 from public.quote_hold_budgets where quote_id = $1", [
      q.quoteId,
    ]);
    expect(budget.rows).toEqual([]);
  });

  it("10b. the raw visitor token is never stored — only its hash", async () => {
    const v = generateVisitorToken();
    await hold(await quote(), v);
    const leaks = await admin<{ n: number }>(
      `select (select count(*) from public.reservations r where r::text like '%' || $1 || '%')
            + (select count(*) from public.booking_requests b where b::text like '%' || $1 || '%')
            + (select count(*) from public.audit_logs a where a::text like '%' || $1 || '%') as n`,
      [v],
    );
    expect(String(leaks.rows[0]!.n)).toBe("0");
    expect(await liveHolds(orgA, v)).toBe(1);
  });

  it("11. the customer email does not change the identity", async () => {
    const v = generateVisitorToken();
    await hold(await quote(orgA, `a-${randomUUID().slice(0, 6)}@example.test`), v);
    await hold(await quote(orgA, `b-${randomUUID().slice(0, 6)}@example.test`), v);
    // Same visitor, yet another email → still capped.
    expect(await tryHold(await quote(orgA, `c-${randomUUID().slice(0, 6)}@example.test`), v)).toBe(
      "PUBLIC_HOLD_LIMIT",
    );
    // Same email, different visitor → independent.
    const shared = `shared-${randomUUID().slice(0, 6)}@example.test`;
    const w = generateVisitorToken();
    expect(await tryHold(await quote(orgA, shared), w)).toBe("ok");
    expect(await tryHold(await quote(orgA, shared), generateVisitorToken())).toBe("ok");
  });

  it("12. the per-quote renewal budget still applies independently of the cap", async () => {
    const v = generateVisitorToken();
    const q = await quote();
    await hold(q, v); // budget 1
    for (let i = 0; i < 3; i++) await renewPublicHold(tenantOf(orgA), q.token, metaFor(v), deps()); // 2–4
    await expect(
      renewPublicHold(tenantOf(orgA), q.token, metaFor(v), deps()),
    ).rejects.toMatchObject({
      code: "HOLD_RENEWAL_LIMIT",
    });
    await cancelPublicBooking(tenantOf(orgA), q.token, metaFor(v), deps());
    // Under the cap (0 live holds), but this quote's budget is spent.
    expect(await tryHold(q, v)).toBe("HOLD_RENEWAL_LIMIT");
    expect(await liveHolds(orgA, v)).toBe(0);
  });
});
