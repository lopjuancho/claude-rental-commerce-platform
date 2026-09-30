import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { requestPublicBooking, submitQuoteRequest } from "@/server/public/quotes";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken } from "@/server/visitor";
import {
  bookingRequestsFor,
  countForCustomer,
  currentSessionToken,
  expireQuote,
  makeQuoteStale,
  quoteByLink,
  resolveOrganization,
} from "../../scripts/ai-smoke-db.mjs";
import { makeProduct } from "./support/availability";
import { admin, createOrg, pool, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * R4-L1 (Codex review of bc328e3): the live smoke test's database assertions are scoped to the
 * staging tenant's organization AND the exact quote. Quote numbers are unique only inside an
 * organization: another tenant's quote with the SAME number must never count.
 */
let orgA: TestOrg;
let orgB: TestOrg;
const tenantOf = (org: TestOrg) =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: org.slug,
    timezone: "America/Chicago",
    currency: "USD",
  }) as unknown as ResolvedTenant;
const deps = () => ({
  gateway: pgGateway(),
  provider: fakeProvider(3),
  rateLimit: () => Promise.resolve(),
});

async function quote(org: TestOrg, email: string) {
  const p = await makeProduct(org, { units: 3 });
  const { token, quoteNumber, tokenHash } = await submitQuoteRequest(
    tenantOf(org),
    {
      contact: { email },
      event: {
        date: "2029-04-07",
        startTime: "12:00",
        endTime: "16:00",
        address: {
          line1: "1930 S Germantown Rd",
          city: "Germantown",
          state: "TN",
          postalCode: "38138",
        },
      },
      items: [{ variantId: p.variantId, quantity: 1 }],
    },
    { ip: "198.51.100.61" },
    deps(),
  );
  return { url: `/q/${token}`, quoteNumber, tokenHash };
}

beforeAll(async () => {
  orgA = await createOrg("smoke-a");
  orgB = await createOrg("smoke-b");
  for (const org of [orgA, orgB]) {
    await admin(
      `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
         primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
       where organization_id = $1`,
      [org.id],
    );
  }
  await admin(
    "insert into public.organization_domains (organization_id, hostname, is_primary) values ($1, $2, true)",
    [orgA.id, `${orgA.slug}.smoke.example`],
  );
});

describeRest("smoke-test database checks are tenant-scoped (R4-L1)", () => {
  it("tenant B's booking on the SAME quote number never counts for tenant A", async () => {
    const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
    const a = await quote(orgA, email);
    const b = await quote(orgB, email);
    // Force the collision: B's quote carries A's quote number.
    await admin(
      `begin; set local session_replication_role = replica;
       update public.quotes set quote_number = '${a.quoteNumber}' where organization_id = '${orgB.id}' and quote_number = '${b.quoteNumber}';
       commit;`,
    );
    const numbers = await admin<{ n: string }>(
      "select count(*)::text n from public.quotes where quote_number = $1 and organization_id = any($2::uuid[])",
      [a.quoteNumber, [orgA.id, orgB.id]],
    );
    expect(Number(numbers.rows[0]!.n)).toBe(2);
    // Only tenant B books.
    await requestPublicBooking(
      tenantOf(orgB),
      { tokenHash: b.tokenHash },
      {},
      { ip: "198.51.100.62", visitorToken: generateVisitorToken() },
      deps(),
    );

    // As the smoke test resolves them: organization from the host, quote from its link.
    const org = await resolveOrganization(pool, `${orgA.slug}.smoke.example`);
    expect(org).toBe(orgA.id);
    const qa = await quoteByLink(pool, org!, a.url);
    expect(qa?.quoteNumber).toBe(a.quoteNumber);
    expect(await quoteByLink(pool, org!, b.url)).toBeNull(); // B's quote is not tenant A's
    expect(await bookingRequestsFor(pool, org!, [qa!.id])).toBe(0);
    expect(await countForCustomer(pool, org!, email, "bookings")).toBe(0);
    expect(await countForCustomer(pool, org!, email, "quotes")).toBe(1);
    // …while the unscoped number-only query the script used before WOULD have counted B's booking.
    const unscoped = await admin<{ n: string }>(
      "select count(*)::text n from public.booking_requests b join public.quotes q on q.id = b.quote_id where q.quote_number = $1 and q.organization_id = any($2::uuid[])",
      [a.quoteNumber, [orgA.id, orgB.id]],
    );
    expect(Number(unscoped.rows[0]!.n)).toBe(1);
    // Tenant B, scoped, sees its own.
    const qb = await quoteByLink(pool, orgB.id, b.url);
    expect(await bookingRequestsFor(pool, orgB.id, [qb!.id])).toBe(1);
  });

  it("setup writes (expire, stale) touch only the tenant's own exact quote", async () => {
    const email = `smoke-${randomUUID().slice(0, 8)}@example.test`;
    const a = await quote(orgA, email);
    const b = await quote(orgB, email);
    const qa = await quoteByLink(pool, orgA.id, a.url);
    const qb = await quoteByLink(pool, orgB.id, b.url);
    // Another tenant's quote id is never written through tenant A's scope.
    expect(await expireQuote(pool, orgA.id, qb!.id)).toBe(0);
    expect(await makeQuoteStale(pool, orgA.id, qb!.id)).toBe(0);
    // (The smoke quotes are final pickup quotes; approve this delivery quote so it can be sent.)
    await admin(
      `begin; set local session_replication_role = replica;
       update public.quotes set review_approved_at = now() where id = '${qa!.id}';
       commit;`,
    );
    expect(await expireQuote(pool, orgA.id, qa!.id)).toBe(1);
    expect(await makeQuoteStale(pool, orgA.id, qa!.id)).toBe(1);
    const statusB = await admin<{ status: string }>(
      "select status::text from public.quotes where id = $1",
      [qb!.id],
    );
    expect(statusB.rows[0]!.status).not.toBe("sent");
  });

  it("the session in effect is the highest cookie generation", () => {
    const t = (c: string) => c.repeat(43);
    expect(
      currentSessionToken(
        new Map([
          ["rc_ai", t("a")],
          ["rc_ai_3", t("c")],
          ["rc_ai_2", t("b")],
          ["rc_visitor", t("v")],
        ]),
      ),
    ).toBe(t("c"));
    expect(currentSessionToken(new Map())).toBeNull();
  });
});
