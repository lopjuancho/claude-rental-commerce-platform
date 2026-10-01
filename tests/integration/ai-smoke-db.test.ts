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
  bookingHoldReleased,
  bookingRequestsFor,
  bookingStatus,
  cancelSmokeBooking,
  conversationCounters,
  createSmokeCleanup,
  modelCalls,
  removeSmokeAvailabilityBlock,
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
      expect(
        (await bookingHoldReleased(pool, orgA.id, qa!.id))?.blockingAllocations,
      ).toBeGreaterThan(0);
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
      // The inventory is released by the availability engine's own rule (no held/confirmed
      // allocation remains), not inferred from the request status.
      expect(await bookingHoldReleased(pool, orgA.id, qa!.id)).toEqual({
        requestStatus: "cancelled",
        blockingAllocations: 0,
      });
      expect(await bookingHoldReleased(pool, orgB.id, qa!.id)).toBeNull();
    });

    it("availability blocks: exact ownership — one id, one product, one org, one tag", async () => {
      const p = await makeProduct(orgA, { units: 1 });
      const p2 = await makeProduct(orgA, { units: 1 });
      const slug = (
        await admin<{ slug: string }>("select slug from public.products where id = $1", [
          p.productId,
        ])
      ).rows[0]!.slug;
      const tag = `ai-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const otherTag = `ai-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      // Invalid tags are refused BEFORE any insert.
      for (const bad of ["", "staff note", "ai-smoke-XYZ", "ai-smoke-123"]) {
        await expect(
          addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-06-01", bad),
        ).rejects.toThrow();
      }
      expect(await addSmokeAvailabilityBlock(pool, orgB.id, slug, "2030-06-01", tag)).toBeNull();
      const mine = await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-06-01", tag);
      expect(mine?.productId).toBe(p.productId);
      expect(mine?.id).toMatch(/^[0-9a-f-]{36}$/);
      // Look-alikes that must survive: a staff block, a second block with the SAME tag, another tag.
      const staff = await admin<{ id: string }>(
        `insert into public.availability_blocks (organization_id, product_id, period, reason, notes)
       values ($1, $2, tstzrange('2030-06-01', '2030-06-02'), 'maintenance', 'staff: deep clean') returning id`,
        [orgA.id, p.productId],
      );
      const twin = await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-06-01", tag);
      const other = await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-06-01", otherTag);
      // Wrong org, wrong product, wrong tag: nothing deleted.
      expect(await removeSmokeAvailabilityBlock(pool, orgB.id, mine!, tag)).toBe(0);
      expect(
        await removeSmokeAvailabilityBlock(
          pool,
          orgA.id,
          { ...mine!, productId: p2.productId },
          tag,
        ),
      ).toBe(0);
      expect(await removeSmokeAvailabilityBlock(pool, orgA.id, mine!, otherTag)).toBe(0);
      await expect(removeSmokeAvailabilityBlock(pool, orgA.id, mine!, "")).rejects.toThrow();
      // The exact block, and only it.
      expect(await removeSmokeAvailabilityBlock(pool, orgA.id, mine!, tag)).toBe(1);
      const left = await admin<{ id: string }>(
        "select id from public.availability_blocks where organization_id = $1 and product_id = $2",
        [orgA.id, p.productId],
      );
      expect(left.rows.map((r) => r.id).sort()).toEqual(
        [staff.rows[0]!.id, twin!.id, other!.id].sort(),
      );
      await admin("delete from public.availability_blocks where product_id = $1", [p.productId]);
    });

    it("cleanup: cancels a still-pending smoke booking, removes the exact block, reports safely", async () => {
      const email = `gate-${randomUUID().slice(0, 8)}@example.test`;
      const a = await quote(orgA, email);
      await requestPublicBooking(
        tenantOf(orgA),
        { tokenHash: a.tokenHash },
        {},
        { ip: "198.51.100.65", visitorToken: generateVisitorToken() },
        deps(),
      );
      const qa = await quoteByLink(pool, orgA.id, a.url);
      const p = await makeProduct(orgA, { units: 1 });
      const slug = (
        await admin<{ slug: string }>("select slug from public.products where id = $1", [
          p.productId,
        ])
      ).rows[0]!.slug;
      const tag = `ai-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      expect(() => createSmokeCleanup(pool, "bad")).toThrow();
      const client = await pool.connect();
      try {
        const cleanup = createSmokeCleanup(client, tag);
        // Nothing registered yet: nothing attempted.
        expect(await cleanup.run()).toMatchObject({
          bookingCleanup: "not attempted",
          blockCleanup: "not created",
        });
        cleanup.state.organizationId = orgA.id;
        cleanup.state.booking = { quoteId: qa!.id, quoteNumber: a.quoteNumber };
        cleanup.state.block = await addSmokeAvailabilityBlock(
          client,
          orgA.id,
          slug,
          "2030-07-06",
          tag,
        );
        // A crash now would leave these: the recovery lines name them without any secret.
        const recovery = cleanup.recovery().join("\n");
        expect(recovery).toContain(cleanup.state.block!.id);
        expect(recovery).toContain(a.quoteNumber);
        expect(recovery).not.toMatch(/[0-9a-f]{64}/);
        const state = await cleanup.run();
        expect(state.bookingCleanup).toBe("succeeded (cancelled)");
        expect(state.blockCleanup).toBe("succeeded");
        expect(cleanup.recovery()).toEqual([]);
        expect(await bookingHoldReleased(pool, orgA.id, qa!.id)).toEqual({
          requestStatus: "cancelled",
          blockingAllocations: 0,
        });
        // Idempotent: a second run (a signal after the normal path) changes nothing.
        expect((await cleanup.run()).bookingCleanup).toBe("succeeded (cancelled)");
      } finally {
        client.release();
      }
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
      // A live turn records each provider call; a replay of the same request records none.
      expect(await modelCalls(pool, orgA.id, session)).toBe(1);
      expect(await modelCalls(pool, orgB.id, session)).toBe(0);
      const before = await conversationCounters(pool, orgA.id, session);
      const replay = await runTurn(input, turnDeps(fail));
      expect(replay.replayed).toBe(true);
      expect(await modelCalls(pool, orgA.id, session)).toBe(1);
      expect(await conversationCounters(pool, orgA.id, session)).toEqual(before);
      // A new message calls the model again (a failing call is recorded too).
      await runTurn({ ...input, requestKey: randomUUID() }, turnDeps(fail));
      expect(await modelCalls(pool, orgA.id, session)).toBe(2);
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
