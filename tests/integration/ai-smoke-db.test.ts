import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { runTurn } from "@/server/ai/assistant";
import type { LlmProvider } from "@/server/ai/provider";
import { generateSessionToken } from "@/server/ai/session";
import { requestPublicBooking, submitQuoteRequest } from "@/server/public/quotes";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken } from "@/server/visitor";
import {
  addSmokeAvailabilityBlock,
  bookingRequestsFor,
  bookingStatus,
  cancelSmokeBooking,
  conversationCounters,
  removeSmokeAvailabilityBlocks,
  storedTurn,
  countForCustomer,
  currentSessionToken,
  expireQuote,
  makeQuoteStale,
  quoteByLink,
  resolveOrganization,
} from "../../scripts/ai-smoke-db.mjs";
import { pgAiStore } from "./support/ai";
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

describeRest(
  "final-gate smoke helpers are tenant-scoped and leak nothing (live replay checks)",
  () => {
    const sayModel = (text: string): LlmProvider => ({
      id: "plan",
      model: "plan-test",
      complete: () =>
        Promise.resolve({
          text,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
    });
    const fail: LlmProvider = {
      id: "plan",
      model: "plan-test",
      complete: () => Promise.reject(Object.assign(new Error("down"), { code: "HTTP" })),
    };
    const turnDeps = (provider: LlmProvider) => ({
      provider,
      store: pgAiStore(),
      maxOutputTokens: 200,
      publicDeps: deps(),
    });

    it("cancelSmokeBooking cancels only this organization's exact quote's request", async () => {
      const email = `gate-${randomUUID().slice(0, 8)}@example.test`;
      const a = await quote(orgA, email);
      await requestPublicBooking(
        tenantOf(orgA),
        { tokenHash: a.tokenHash },
        {},
        { ip: "198.51.100.63", visitorToken: generateVisitorToken() },
        deps(),
      );
      const qa = await quoteByLink(pool, orgA.id, a.url);
      expect(await bookingStatus(pool, orgA.id, qa!.id)).toBe("pending");
      // Another tenant's scope cannot touch it.
      const other = await pool.connect();
      try {
        await expect(cancelSmokeBooking(other, orgB.id, qa!.id)).rejects.toThrow();
      } finally {
        other.release();
      }
      expect(await bookingStatus(pool, orgA.id, qa!.id)).toBe("pending");
      expect(await bookingStatus(pool, orgB.id, qa!.id)).toBeNull();
      const client = await pool.connect();
      try {
        expect(await cancelSmokeBooking(client, orgA.id, qa!.id)).toMatch(/^[0-9a-f-]{36}$/);
      } finally {
        client.release();
      }
      expect(await bookingStatus(pool, orgA.id, qa!.id)).toBe("cancelled");
    });

    it("availability blocks: added for one product, removed exactly by tag, scoped to the org", async () => {
      const p = await makeProduct(orgA, { units: 1 });
      const slug = (
        await admin<{ slug: string }>("select slug from public.products where id = $1", [
          p.productId,
        ])
      ).rows[0]!.slug;
      const tag = `ai-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      expect(await addSmokeAvailabilityBlock(pool, orgB.id, slug, "2030-06-01", tag)).toBeNull();
      expect(await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-06-01", tag)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      expect(await removeSmokeAvailabilityBlocks(pool, orgB.id, tag)).toBe(0);
      expect(await removeSmokeAvailabilityBlocks(pool, orgA.id, tag)).toBe(1);
      await expect(removeSmokeAvailabilityBlocks(pool, orgA.id, "")).rejects.toThrow();
    });

    it("storedTurn / conversationCounters: scoped, hash-free, and unchanged by a replay", async () => {
      const session = generateSessionToken();
      const key = randomUUID();
      const input = {
        tenant: tenantOf(orgA),
        sessionToken: session,
        requestKey: key,
        message: "hello",
        meta: { ip: "198.51.100.64" },
        correlationId: `c-${randomUUID()}`,
      };
      await runTurn(input, turnDeps(sayModel("Hi there!")));
      const t = await storedTurn(pool, orgA.id, session, key);
      expect(t).toEqual({ status: "completed", attempt: 1, bookingRefs: 0 });
      expect(JSON.stringify(t)).not.toMatch(/[0-9a-f]{64}/);
      expect(await storedTurn(pool, orgB.id, session, key)).toBeNull();
      const before = await conversationCounters(pool, orgA.id, session);
      const replay = await runTurn(input, turnDeps(fail));
      expect(replay.replayed).toBe(true);
      expect(await conversationCounters(pool, orgA.id, session)).toEqual(before);
      // References count, without being returned.
      await admin(
        `update public.ai_turns t set response = response || jsonb_build_object(
         'refs', jsonb_build_object('bookings', jsonb_build_array(jsonb_build_object('quoteRef', repeat('a', 64), 'quoteNumber', 'Q-1'))),
         'blocks', jsonb_build_array(jsonb_build_object('type', 'booking', 'quoteRef', repeat('a', 64))))
       from public.ai_conversations c where c.id = t.conversation_id and t.request_key = $1 and c.organization_id = $2`,
        [key, orgA.id],
      );
      const withRefs = await storedTurn(pool, orgA.id, session, key);
      expect(withRefs?.bookingRefs).toBe(2);
      expect(JSON.stringify(withRefs)).not.toContain("a".repeat(64));
    });
  },
);
