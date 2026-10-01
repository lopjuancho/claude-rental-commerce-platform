import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
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
  reconcileSmokeBookings,
  modelCalls,
  removeSmokeAvailabilityBlock,
  requestTerminality,
  storedTurn,
  trackedExchange,
  countForCustomer,
  currentSessionToken,
  expireQuote,
  makeQuoteStale,
  quoteByLink,
  resolveOrganization,
} from "../../scripts/ai-smoke-db.mjs";
import { smokeExitCode } from "../../scripts/ai-smoke-checks.mjs";
import { pgAiStore } from "./support/ai";
import { makeProduct, rpc } from "./support/availability";
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
      expect(await bookingHoldReleased(pool, orgA.id, qa!.id)).toMatchObject({
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

    /** A smoke-like customer with a quote, and (optionally) its booking request committed. */
    async function smokeQuote(book: boolean) {
      const email = `ai-smoke-${randomUUID().slice(0, 8)}@example.test`;
      const a = await quote(orgA, email);
      const qa = (await quoteByLink(pool, orgA.id, a.url))!;
      const commit = () =>
        requestPublicBooking(
          tenantOf(orgA),
          { tokenHash: a.tokenHash },
          {},
          { ip: "198.51.100.66", visitorToken: generateVisitorToken() },
          deps(),
        );
      if (book) await commit();
      return { email, quoteId: qa.id, quoteNumber: a.quoteNumber, commit };
    }
    const newTag = () => `ai-smoke-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    it("release follows the engine's own predicate (allocation_is_active)", async () => {
      const q = await smokeQuote(true);
      const reservation = (
        await admin<{ reservation_id: string }>(
          "select reservation_id from public.booking_requests where quote_id = $1",
          [q.quoteId],
        )
      ).rows[0]!.reservation_id;
      const setAllocations = (status: string, expires: string) =>
        admin(
          `begin; set local session_replication_role = replica;
           update public.reservation_allocations set status = '${status}', hold_expires_at = ${expires} where reservation_id = '${reservation}';
           commit;`,
        );
      // An unexpired held allocation blocks.
      expect(
        (await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations,
      ).toBeGreaterThan(0);
      // An EXPIRED held allocation row remains, but no longer blocks: released.
      await setAllocations("held", "now() - interval '1 minute'");
      const expired = await bookingHoldReleased(pool, orgA.id, q.quoteId);
      expect(expired?.blockingAllocations).toBe(0);
      expect(expired?.residualAllocations).toBeGreaterThan(0);
      // A confirmed allocation blocks.
      await setAllocations("confirmed", "null");
      expect(
        (await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations,
      ).toBeGreaterThan(0);
      await setAllocations("released", "null");
    });

    it("found through the smoke customer even when the quote id was never registered", async () => {
      const q = await smokeQuote(true);
      const client = await pool.connect();
      try {
        const r = await reconcileSmokeBookings(client, orgA.id, [], [q.email]);
        expect(r).toMatchObject({ quotes: 1, requests: 1, cancelled: 1, unresolved: [] });
        expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
        // Another tenant's scope finds nothing of it.
        expect(await reconcileSmokeBookings(client, orgB.id, [q.quoteId], [q.email])).toMatchObject(
          {
            quotes: 0,
            requests: 0,
          },
        );
      } finally {
        client.release();
      }
    });

    it("no booking committed: cleanup is a safe success", async () => {
      const q = await smokeQuote(false);
      const cleanup = createSmokeCleanup(pool, newTag());
      cleanup.state.organizationId = orgA.id;
      cleanup.state.quoteIds.add(q.quoteId);
      const state = await cleanup.run();
      expect(state.bookingOutcome).toBe("reconciled_no_booking_terminal");
      expect(state.bookingCleanup).toMatch(/^succeeded \(no booking request was committed/);
      expect(cleanup.recovery()).toEqual([]);
    });

    it("a CONFIRMED booking is never reported as cleaned up; recovery names it; nothing cancelled", async () => {
      const q = await smokeQuote(true);
      const id = (
        await admin<{ id: string }>("select id from public.booking_requests where quote_id = $1", [
          q.quoteId,
        ])
      ).rows[0]!.id;
      // (The fixture's delivery quote needs review approval before the team can confirm it.)
      await admin(
        `begin; set local session_replication_role = replica;
         update public.quotes set review_approved_at = now() where id = '${q.quoteId}';
         commit;`,
      );
      await rpc(orgA.users.office, "select public.confirm_booking_request($1, true)", [id]);
      const cleanup = createSmokeCleanup(pool, newTag());
      cleanup.state.organizationId = orgA.id;
      cleanup.state.quoteIds.add(q.quoteId);
      const state = await cleanup.run();
      expect(state.bookingCleanup).toMatch(/^unresolved/);
      expect(state.bookingCleanup).not.toMatch(/succeeded/);
      expect(cleanup.recovery().join("\n")).toContain(q.quoteNumber);
      expect(cleanup.recovery().join("\n")).not.toMatch(/[0-9a-f]{64}/);
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("confirmed");
    });

    it("AMBIGUOUS (two live requests on one quote): fail closed, nothing cancelled", async () => {
      const issued: string[] = [];
      // The schema allows one pending request per quote; the ambiguity is simulated at the query
      // level to prove the reconciler refuses rather than picks one.
      const fake = {
        query(sql: string) {
          issued.push(sql);
          if (/from public\.quotes q/.test(sql)) {
            return Promise.resolve({ rows: [{ id: "q-1", quote_number: "Q-77" }], rowCount: 1 });
          }
          if (/select b\.status::text as status/.test(sql)) {
            return Promise.resolve({
              rows: [{ status: "pending" }, { status: "pending" }],
              rowCount: 2,
            });
          }
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
      };
      const r = await reconcileSmokeBookings(fake, "org", ["q-1"], []);
      expect(r.unresolved.join(" ")).toMatch(/Q-77: 2 live booking requests \(ambiguous\)/);
      expect(issued.some((q) => /cancel_booking_by_token/.test(q))).toBe(false);
    });

    it("cleanup removes the exact block and reports unresolved block failures", async () => {
      const p = await makeProduct(orgA, { units: 1 });
      const slug = (
        await admin<{ slug: string }>("select slug from public.products where id = $1", [
          p.productId,
        ])
      ).rows[0]!.slug;
      const tag = newTag();
      expect(() => createSmokeCleanup(pool, "bad")).toThrow();
      const cleanup = createSmokeCleanup(pool, tag);
      cleanup.state.organizationId = orgA.id;
      cleanup.state.block = await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2030-07-06", tag);
      expect(cleanup.recovery().join("\n")).toContain(cleanup.state.block!.id);
      expect((await cleanup.run()).blockCleanup).toBe("succeeded");
      expect(cleanup.recovery()).toEqual([]);
      // A block that is already gone is NOT reported as cleaned.
      const again = createSmokeCleanup(pool, tag);
      again.state.organizationId = orgA.id;
      again.state.block = { id: randomUUID(), productId: p.productId };
      expect((await again.run()).blockCleanup).toBe("failed (not found)");
      expect(again.recovery().length).toBeGreaterThan(0);
    });

    /**
     * A REAL assistant request on the server (runTurn → ai_turns journal). Its model call waits on
     * `open()`; then, if `book`, the booking commits — i.e. LATE, after the smoke stopped waiting.
     */
    function serverRequest(q: Awaited<ReturnType<typeof smokeQuote>>, book: boolean) {
      const session = generateSessionToken();
      const requestKey = `smoke-${randomUUID()}`;
      let open!: () => void;
      const gate = new Promise<void>((r) => {
        open = r;
      });
      let entered!: () => void;
      const started = new Promise<void>((r) => {
        entered = r;
      });
      const provider: LlmProvider = {
        id: "plan",
        model: "plan-test",
        complete: async () => {
          entered();
          await gate;
          if (book) await q.commit();
          return { text: "Done.", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
        },
      };
      const done = runTurn(
        {
          tenant: tenantOf(orgA),
          sessionToken: session,
          requestKey,
          message: "Please request the booking.",
          meta: { ip: "198.51.100.67" },
          correlationId: `c-${randomUUID()}`,
        },
        turnDeps(provider),
      );
      return { session, requestKey, open, started, done };
    }
    function smokeCleanup(q: Awaited<ReturnType<typeof smokeQuote>>) {
      const tag = newTag();
      const cleanup = createSmokeCleanup(pool, tag);
      cleanup.state.organizationId = orgA.id;
      cleanup.state.quoteIds.add(q.quoteId);
      cleanup.state.quoteNumbers.set(q.quoteId, q.quoteNumber);
      cleanup.state.customerEmails.add(q.email);
      return { tag, cleanup };
    }
    const exitCode = (s: { bookingCleanup: string; blockCleanup: string }, recovery: string[]) =>
      smokeExitCode({
        failedChecks: 0,
        bookingCleanup: s.bookingCleanup,
        blockCleanup: s.blockCleanup,
        recovery,
      });

    it("CASE 1: wait timed out, no booking yet, the request commits LATE — never success before; recovery names it", async () => {
      const q = await smokeQuote(false);
      const s = serverRequest(q, true);
      const { tag, cleanup } = smokeCleanup(q);
      const h = cleanup.beginRequest(s.requestKey, s.session);
      cleanup.state.inFlight = s.done.then(
        () => {
          h.responded(200, null);
        },
        () => {
          h.failed();
        },
      );
      await s.started; // the server is executing the request
      cleanup.state.stopping = true; // SIGTERM
      const first = await cleanup.run({ waitForInFlightMs: 200 });
      expect(h.intent.state).toBe("wait_timed_out_unknown");
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBeNull(); // nothing committed YET…
      expect(first.bookingOutcome).toBe("unresolved"); // …and still not "no booking committed"
      expect(first.bookingCleanup).toMatch(/^unresolved/);
      expect(first.unresolved.join(" ")).toMatch(/live lease/);
      const recovery = cleanup.recovery();
      expect(exitCode(first, recovery)).toBe(1);
      const text = recovery.join("\n");
      for (const id of [orgA.id, q.quoteId, q.quoteNumber, s.requestKey, tag])
        expect(text).toContain(id);
      expect(text).not.toContain(s.session);
      expect(text).not.toMatch(/[0-9a-f]{64}|\/q\/|postgres:|service_role/);
      // The request commits late; once the journal shows it terminal, cleanup completes.
      s.open();
      await s.done;
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("pending");
      const second = await cleanup.run();
      expect(h.intent.state).toBe("response_completed");
      expect(second.bookingOutcome).toBe("reconciled_booking_cancelled");
      expect(second.bookingCleanup).toBe("succeeded (released; 1 cancelled now)");
      expect((await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations).toBe(0);
      expect(cleanup.recovery()).toEqual([]);
    });

    it("CASE 2: the transport failed, the server commits later — unresolved until the journal is terminal", async () => {
      const q = await smokeQuote(false);
      const { cleanup } = smokeCleanup(q);
      // (a) The connection failed before the server recorded anything: unknown, not "nothing".
      const lost = cleanup.beginRequest(`smoke-${randomUUID()}`, generateSessionToken());
      lost.failed();
      const none = await cleanup.run();
      expect(none.bookingOutcome).toBe("unresolved");
      expect(none.unresolved.join(" ")).toMatch(/no turn recorded/);
      expect(cleanup.recovery().join("\n")).toContain(lost.intent.requestId);
      cleanup.state.requests.delete(lost.intent.requestId);
      // (b) The connection failed while the server keeps executing; it commits afterwards.
      const s = serverRequest(q, true);
      const h = cleanup.beginRequest(s.requestKey, s.session);
      h.failed();
      await s.started;
      const first = await cleanup.run();
      expect(h.intent.state).toBe("transport_failed_unknown");
      expect(first.bookingOutcome).toBe("unresolved");
      expect(first.bookingCleanup).not.toMatch(/succeeded/);
      s.open();
      await s.done;
      const second = await cleanup.run();
      expect(second.bookingOutcome).toBe("reconciled_booking_cancelled");
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
    });

    it("CASE 3: the request failed terminally before any booking (response lost) — a safe no-op", async () => {
      const q = await smokeQuote(false);
      const { cleanup } = smokeCleanup(q);
      const session = generateSessionToken();
      const requestKey = `smoke-${randomUUID()}`;
      const h = cleanup.beginRequest(requestKey, session);
      await runTurn(
        {
          tenant: tenantOf(orgA),
          sessionToken: session,
          requestKey,
          message: "Please request the booking.",
          meta: { ip: "198.51.100.68" },
          correlationId: `c-${randomUUID()}`,
        },
        turnDeps(fail),
      );
      h.failed(); // the smoke never saw the response
      expect((await storedTurn(pool, orgA.id, session, requestKey))?.status).toBe("failed");
      const state = await cleanup.run();
      expect(state.bookingOutcome).toBe("reconciled_no_booking_terminal");
      expect(state.bookingCleanup).toMatch(/^succeeded \(no booking request was committed/);
      expect(cleanup.recovery()).toEqual([]);
    });

    it("CASE 4: a definitive answer without a booking — success", async () => {
      const q = await smokeQuote(false);
      const { cleanup } = smokeCleanup(q);
      const session = generateSessionToken();
      const requestKey = `smoke-${randomUUID()}`;
      const h = cleanup.beginRequest(requestKey, session);
      await runTurn(
        {
          tenant: tenantOf(orgA),
          sessionToken: session,
          requestKey,
          message: "Please request the booking.",
          meta: { ip: "198.51.100.69" },
          correlationId: `c-${randomUUID()}`,
        },
        turnDeps(sayModel("I can't request that booking yet.")),
      );
      h.responded();
      const state = await cleanup.run();
      expect(state.bookingOutcome).toBe("reconciled_no_booking_terminal");
      expect(exitCode(state, cleanup.recovery())).toBe(0);
    });

    it("CASE 5: a committed pending booking of a finished request — cancelled, released, success", async () => {
      const q = await smokeQuote(false);
      const s = serverRequest(q, true);
      const { cleanup } = smokeCleanup(q);
      const h = cleanup.beginRequest(s.requestKey, s.session);
      cleanup.state.inFlight = s.done.then(
        () => {
          h.responded(200, null);
        },
        () => {
          h.failed();
        },
      );
      s.open();
      cleanup.state.stopping = true;
      const state = await cleanup.run({ waitForInFlightMs: 10_000 });
      expect(h.intent.state).toBe("response_completed");
      expect(state.bookingOutcome).toBe("reconciled_booking_cancelled");
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
      expect((await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations).toBe(0);
      expect(exitCode(state, cleanup.recovery())).toBe(0);
    });

    const unknownDelivery = [{ refusal: null }];
    it("an expired lease is terminal only when no business mutation is still 'started'", async () => {
      const q = await smokeQuote(false);
      const s = serverRequest(q, false);
      await s.started;
      const expireLease = () =>
        admin(
          `update public.ai_turns set lease_expires_at = now() - interval '5 minutes' where request_key = $1`,
          [s.requestKey],
        );
      expect(
        await requestTerminality(pool, orgA.id, s.session, s.requestKey, unknownDelivery),
      ).toMatchObject({ terminal: false });
      await admin(
        `insert into public.ai_mutations (organization_id, conversation_id, turn_id, attempt, tool_name, mutation_key, status)
         select t.organization_id, t.conversation_id, t.id, t.attempt, 'request_booking', repeat('b', 64), 'started'
         from public.ai_turns t where t.request_key = $1`,
        [s.requestKey],
      );
      await expireLease();
      const started = await requestTerminality(
        pool,
        orgA.id,
        s.session,
        s.requestKey,
        unknownDelivery,
      );
      expect(started).toMatchObject({ terminal: false });
      expect(started.reason).toMatch(/mutation is still in progress/);
      await admin(
        `update public.ai_mutations set status = 'failed' where turn_id = (select id from public.ai_turns where request_key = $1)`,
        [s.requestKey],
      );
      expect(
        await requestTerminality(pool, orgA.id, s.session, s.requestKey, unknownDelivery),
      ).toMatchObject({ terminal: true });
      // Another tenant's scope never sees the turn (and so never calls it terminal).
      expect(
        await requestTerminality(pool, orgB.id, s.session, s.requestKey, unknownDelivery),
      ).toMatchObject({ terminal: false });
      s.open();
      await s.done;
    });

    // ── current-attempt terminality: a retry of the same request key (real ai_turn_begin) ──
    const sessionHash = (token: string) => createHash("sha256").update(`ai:${token}`).digest("hex");
    /** A request whose attempt 1 FAILED (committed) — e.g. its response was lost. */
    async function failedAttempt() {
      const session = generateSessionToken();
      const key = `smoke-${randomUUID()}`;
      await runTurn(
        {
          tenant: tenantOf(orgA),
          sessionToken: session,
          requestKey: key,
          message: "Please request the booking.",
          meta: { ip: "198.51.100.70" },
          correlationId: `c-${randomUUID()}`,
        },
        turnDeps(fail),
      );
      expect(await storedTurn(pool, orgA.id, session, key)).toMatchObject({
        status: "failed",
        attempt: 1,
      });
      return { session, key };
    }
    type Conn = PoolClient;
    /** On its OWN connection: claims the retry through the app's ai_turn_begin, uncommitted. */
    async function beginRetry(c: Conn, session: string, key: string) {
      await c.query("begin");
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const { rows } = await c.query<{ outcome: string; turn_id: string; attempt: number }>(
        "select outcome, turn_id, attempt from public.ai_turn_begin($1, $2, $3, 60, 'retry-test')",
        [orgA.id, sessionHash(session), key],
      );
      return rows[0]!;
    }
    async function failRetry(turnId: string, attempt: number) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
        await c.query("select public.ai_turn_fail($1, $2, $3, 'RETRY_FAILED', null, null, null)", [
          orgA.id,
          turnId,
          attempt,
        ]);
        await c.query("commit");
      } finally {
        c.release();
      }
    }

    it("RETRY 1: failed attempt N + an UNCOMMITTED retry N+1 → unresolved (never the stale failed row); rollback → fenced no-op", async () => {
      const q = await smokeQuote(false);
      const { session, key } = await failedAttempt();
      const { cleanup } = smokeCleanup(q);
      cleanup.beginRequest(key, session).failed(); // the smoke's delivery: outcome unknown
      const b = await pool.connect();
      try {
        const retry = await beginRetry(b, session, key);
        expect(retry).toMatchObject({ outcome: "started", attempt: 2 });
        // What any other connection reads is still the OLD committed row: attempt 1, failed.
        expect(await storedTurn(pool, orgA.id, session, key)).toMatchObject({
          status: "failed",
          attempt: 1,
        });
        const during = await cleanup.run();
        expect(during.bookingOutcome).toBe("unresolved");
        expect(during.bookingCleanup).not.toMatch(/succeeded/);
        expect(during.unresolved.join(" ")).toMatch(/being claimed or written/);
        // Nothing was fenced while the retry held the conversation.
        expect(await storedTurn(pool, orgA.id, session, key)).toMatchObject({ status: "failed" });
        await b.query("rollback");
      } finally {
        b.release();
      }
      // The retry never happened: attempt 1 (failed) is current → fenced → a terminal no-op.
      const after = await cleanup.run();
      expect(after.bookingOutcome).toBe("reconciled_no_booking_terminal");
      expect(await storedTurn(pool, orgA.id, session, key)).toMatchObject({
        status: "completed",
        attempt: 1,
      });
      // The fence holds: a delivery arriving later replays and cannot start attempt 2.
      const late = await pool.connect();
      try {
        expect((await beginRetry(late, session, key)).outcome).toBe("replay");
        await late.query("rollback");
      } finally {
        late.release();
      }
    });

    it("RETRY 2/3: retry N+1 committed and in progress → unresolved; N+1 fails without a mutation → fenced no-op success", async () => {
      const q = await smokeQuote(false);
      const { session, key } = await failedAttempt();
      const { cleanup } = smokeCleanup(q);
      cleanup.beginRequest(key, session).failed();
      const b = await pool.connect();
      let retry: { turn_id: string; attempt: number };
      try {
        retry = await beginRetry(b, session, key);
        await b.query("commit");
      } finally {
        b.release();
      }
      const during = await cleanup.run();
      expect(during.bookingOutcome).toBe("unresolved");
      expect(during.unresolved.join(" ")).toMatch(/attempt 2 processing; it may still act/);
      await failRetry(retry.turn_id, retry.attempt);
      const after = await cleanup.run();
      expect(after.bookingOutcome).toBe("reconciled_no_booking_terminal");
      expect(exitCode(after, cleanup.recovery())).toBe(0);
      expect(await storedTurn(pool, orgA.id, session, key)).toMatchObject({
        status: "completed",
        attempt: 2,
      });
    });

    it("RETRY 4: retry N+1 commits a booking → unresolved while it runs; once terminal: cancelled + released", async () => {
      const q = await smokeQuote(false);
      const { session, key } = await failedAttempt();
      const { cleanup } = smokeCleanup(q);
      cleanup.beginRequest(key, session).failed();
      const b = await pool.connect();
      let retry: { turn_id: string; attempt: number };
      try {
        retry = await beginRetry(b, session, key);
        await b.query("commit");
      } finally {
        b.release();
      }
      await q.commit(); // attempt 2's booking
      const during = await cleanup.run();
      // The booking that exists is cancelled at once (inventory released), but the request is
      // still running — it could create another — so cleanup stays unresolved.
      expect(during.bookingOutcome).toBe("unresolved");
      expect(during.unresolved.join(" ")).toMatch(/attempt 2 processing/);
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
      await failRetry(retry.turn_id, retry.attempt);
      const after = await cleanup.run();
      expect(after.bookingOutcome).toBe("reconciled_booking_cancelled");
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
      expect((await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations).toBe(0);
      expect(exitCode(after, cleanup.recovery())).toBe(0);
    });

    // ── no turn in the journal: only a recognized application refusal proves anything ──
    const fakeResponse = (status: number, text: string) => () =>
      Promise.resolve({ status, text: () => Promise.resolve(text) });
    it.each([
      ["gateway 502", fakeResponse(502, "<html>502 Bad Gateway</html>"), "unresolved"],
      ["gateway 504", fakeResponse(504, "<html>504 Gateway Timeout</html>"), "unresolved"],
      [
        "503 AI_UNAVAILABLE (after runTurn)",
        fakeResponse(503, '{"status":"error","errorCode":"AI_UNAVAILABLE","reply":"x"}'),
        "unresolved",
      ],
      ["a 200 with no turn", fakeResponse(200, '{"status":"ok","reply":"Hi"}'), "unresolved"],
      [
        "recognized 429 RATE_LIMITED",
        fakeResponse(429, '{"status":"error","errorCode":"RATE_LIMITED","reply":"x"}'),
        "reconciled_no_booking_terminal",
      ],
      [
        "recognized 409 SESSION_REQUIRED",
        fakeResponse(409, '{"status":"error","errorCode":"SESSION_REQUIRED","reply":"x"}'),
        "reconciled_no_booking_terminal",
      ],
    ])("no turn + %s → %s", async (_label, send, expected) => {
      const q = await smokeQuote(false);
      // A session whose conversation exists (an earlier request), but NOT for this request key.
      const { session } = await failedAttempt();
      const { cleanup } = smokeCleanup(q);
      const key = `smoke-${randomUUID()}`;
      await trackedExchange(cleanup, key, session, send);
      expect(cleanup.state.requests.get(key)!.state).toBe("response_completed");
      const state = await cleanup.run();
      // (the earlier, failed request of this session is not one of the smoke's intents here)
      expect(state.bookingOutcome).toBe(expected);
      if (expected === "unresolved") {
        expect(state.unresolved.join(" ")).toMatch(/no turn recorded/);
        expect(cleanup.recovery().join("\n")).toContain(key);
      }
    });

    // ── cleanup phases: a FULL cleanup is never satisfied by a block-only one ──
    /** One connection whose block DELETE waits until released (the rest passes straight through). */
    function gatedDb(c: PoolClient) {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let reached!: () => void;
      const atDelete = new Promise<void>((r) => {
        reached = r;
      });
      const db = {
        async query(sql: string, params?: unknown[]) {
          if (/delete from public\.availability_blocks/.test(sql)) {
            reached();
            await gate;
          }
          return c.query(sql, params);
        },
      };
      return { db, release, atDelete };
    }
    async function smokeBlock(tag: string) {
      const p = await makeProduct(orgA, { units: 1 });
      const slug = (
        await admin<{ slug: string }>("select slug from public.products where id = $1", [
          p.productId,
        ])
      ).rows[0]!.slug;
      return (await addSmokeAvailabilityBlock(pool, orgA.id, slug, "2031-03-01", tag))!;
    }
    const tick = () => new Promise((r) => setTimeout(r, 50));

    it("block-only cleanup in progress, then FULL cleanup: the full one escalates through B+C (Codex race)", async () => {
      const q = await smokeQuote(true); // a pending booking that can be reconciled
      const client = await pool.connect();
      try {
        const g = gatedDb(client);
        const tag = newTag();
        const cleanup = createSmokeCleanup(g.db, tag);
        cleanup.state.organizationId = orgA.id;
        cleanup.state.quoteIds.add(q.quoteId);
        cleanup.state.quoteNumbers.set(q.quoteId, q.quoteNumber);
        cleanup.state.block = await smokeBlock(tag);
        const key = `smoke-${randomUUID()}`;
        cleanup.beginRequest(key, generateSessionToken()).failed(); // unresolved request
        // 1. Block-only cleanup starts; its DELETE is held.
        const partial = cleanup.run({ blockOnly: true });
        await g.atDelete;
        // 2. The FULL cleanup (as SIGINT/SIGTERM/abort request it) starts meanwhile.
        let fullDone = false;
        const full = cleanup.run({ waitForInFlightMs: 100 }).then((s) => {
          fullDone = true;
          return s;
        });
        await tick();
        expect(fullDone).toBe(false); // it does not return on the block-only promise
        expect(cleanup.state.bookingOutcome).toBe("not_started");
        // 3. The block deletion finishes.
        g.release();
        await partial;
        const state = await full;
        expect(state.phaseRuns).toEqual({ block: 1, requests: 1, bookings: 1 });
        expect(state.blockCleanup).toBe("succeeded");
        expect(state.requests.get(key)!.resolution).toBe("unknown"); // terminality was checked
        expect(state.bookingOutcome).toBe("unresolved"); // …and the request is still unresolved
        expect(state.bookingOutcome).not.toBe("not_started");
        // Booking reconciliation ran: the pending booking is cancelled and released.
        expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
        expect((await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations).toBe(0);
        const recovery = cleanup.recovery();
        expect(recovery.join("\n")).toContain(key);
        expect(recovery.join("\n")).toContain(q.quoteId);
        expect(exitCode(state, recovery)).toBe(1);
      } finally {
        client.release();
      }
    });

    it("two simultaneous FULL cleanups share one pass; FULL then block-only does not rerun or downgrade", async () => {
      const q = await smokeQuote(true);
      const client = await pool.connect();
      try {
        const g = gatedDb(client);
        const tag = newTag();
        const cleanup = createSmokeCleanup(g.db, tag);
        cleanup.state.organizationId = orgA.id;
        cleanup.state.quoteIds.add(q.quoteId);
        cleanup.state.block = await smokeBlock(tag);
        const a = cleanup.run();
        await g.atDelete;
        const b = cleanup.run();
        // A block-only call during a full pass waits for that whole pass.
        let partialDone = false;
        const partial = cleanup.run({ blockOnly: true }).then(() => {
          partialDone = true;
        });
        await tick();
        expect(partialDone).toBe(false);
        g.release();
        const [sa, sb] = await Promise.all([a, b, partial]);
        expect(sa).toBe(sb);
        expect(sa.phaseRuns).toEqual({ block: 1, requests: 1, bookings: 1 }); // one pass
        expect(sa.bookingCleanup).toBe("succeeded (released; 1 cancelled now)");
        expect(sa.blockCleanup).toBe("succeeded");
        // A block-only call afterwards changes nothing: no booking phase, no downgrade.
        await cleanup.run({ blockOnly: true });
        expect(cleanup.state.phaseRuns).toEqual({ block: 1, requests: 1, bookings: 1 });
        expect(cleanup.state.bookingOutcome).toBe("reconciled_booking_cancelled");
        expect(cleanup.state.bookingCleanup).toBe("succeeded (released; 1 cancelled now)");
        expect(exitCode(cleanup.state, cleanup.recovery())).toBe(0);
      } finally {
        client.release();
      }
    });

    // ── the fence, directly: the OLD attempt can no longer finish, fail or mutate ──
    it("after fencing attempt N, its old owner's real ai_turn_finish / ai_turn_fail / ai_mutation_begin change nothing", async () => {
      const session = generateSessionToken();
      const key = `smoke-${randomUUID()}`;
      // Attempt 1 claimed through the app's own function; its owner is still "alive".
      const c = await pool.connect();
      let turn: { turn_id: string; attempt: number };
      try {
        turn = await beginRetry(c, session, key);
        await c.query("commit");
      } finally {
        c.release();
      }
      expect(turn.attempt).toBe(1);
      // Its lease runs out (the owner stalled); nothing started.
      await admin(
        `update public.ai_turns set lease_expires_at = now() - interval '5 minutes' where id = $1;
         update public.ai_conversations set active_turn_expires_at = now() - interval '5 minutes'
          where active_turn_id = $1`.replace(/\$1/g, `'${turn.turn_id}'`),
      );
      const fenced = await requestTerminality(pool, orgA.id, session, key, [{ refusal: null }]);
      expect(fenced).toMatchObject({ terminal: true });
      expect(fenced.reason).toMatch(/fenced/);
      const asOwner = async (sql: string, params: unknown[]) => {
        const o = await pool.connect();
        try {
          await o.query("begin");
          await o.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
          await o.query(sql, params);
          await o.query("commit");
          return null;
        } catch (e) {
          await o.query("rollback");
          return (e as { code?: string }).code ?? "error";
        } finally {
          o.release();
        }
      };
      const row = async () =>
        (
          await admin<{ status: string; attempt: number; error_code: string; fence: string }>(
            `select status, attempt, error_code, response ->> 'errorCode' as fence
             from public.ai_turns where id = $1`,
            [turn.turn_id],
          )
        ).rows[0];
      const FENCED = {
        status: "completed",
        attempt: 1,
        error_code: "SMOKE_FENCED",
        fence: "SMOKE_FENCED",
      };
      expect(await row()).toEqual(FENCED);
      // The old owner tries to finish with its late reply: refused (it no longer owns it).
      expect(
        await asOwner(
          `select public.ai_turn_finish($1, $2, $3, '{}'::jsonb, null, '[]'::jsonb, 0, 0, 'v',
                                        0, '{"status":"ok","reply":"late reply","blocks":[]}'::jsonb)`,
          [orgA.id, turn.turn_id, turn.attempt],
        ),
      ).toBe("RA010");
      expect(await row()).toEqual(FENCED);
      // …or to fail: a no-op (the fence is no longer 'processing').
      expect(
        await asOwner("select public.ai_turn_fail($1, $2, $3, 'LATE', null, null, null)", [
          orgA.id,
          turn.turn_id,
          turn.attempt,
        ]),
      ).toBeNull();
      expect(await row()).toEqual(FENCED);
      // …or to begin a business mutation: refused; no mutation row exists.
      expect(
        await asOwner(
          `select * from public.ai_mutation_begin($1, $2, $3, repeat('c', 64), 'request_booking', 'tc-1', '{}'::jsonb)`,
          [orgA.id, turn.turn_id, turn.attempt],
        ),
      ).toBe("RA010");
      expect(
        (
          await admin<{ n: number }>(
            "select count(*)::int as n from public.ai_mutations where turn_id = $1",
            [turn.turn_id],
          )
        ).rows[0]!.n,
      ).toBe(0);
      expect(await row()).toEqual(FENCED);
      // A later delivery of the same key replays the fence; no attempt 2 starts.
      const late = await pool.connect();
      try {
        expect(await beginRetry(late, session, key)).toMatchObject({
          outcome: "replay",
          attempt: 1,
        });
        await late.query("rollback");
      } finally {
        late.release();
      }
      expect(await row()).toEqual(FENCED);
    });

    it("recovery after a database failure still names the exact known identifiers, and no secret", async () => {
      const q = await smokeQuote(false);
      const tag = newTag();
      const broken = { query: () => Promise.reject(new Error("connection refused")) };
      const cleanup = createSmokeCleanup(broken, tag);
      cleanup.state.organizationId = orgA.id;
      cleanup.state.quoteIds.add(q.quoteId);
      cleanup.state.quoteNumbers.set(q.quoteId, q.quoteNumber);
      const session = generateSessionToken();
      const h = cleanup.beginRequest("smoke-request-1", session);
      h.failed();
      cleanup.state.block = { id: randomUUID(), productId: randomUUID() };
      const state = await cleanup.run();
      expect(state.bookingCleanup).toBe("failed (database error during reconciliation)");
      expect(state.blockCleanup).toBe("failed (database error)");
      const text = cleanup.recovery().join("\n");
      for (const id of [
        orgA.id,
        q.quoteId,
        q.quoteNumber,
        "smoke-request-1",
        tag,
        state.block!.id,
        state.block!.productId,
      ])
        expect(text).toContain(id);
      expect(text).not.toContain(session);
      expect(text).not.toMatch(/[0-9a-f]{64}|\/q\/|connection refused/);
      expect(exitCode(state, cleanup.recovery())).toBe(1);
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
      const live = await runTurn(input, turnDeps(sayModel("Hi there!")));
      // In-process observation of THIS request: one provider call, telemetry durably written.
      expect(live.observation).toEqual({ modelCalls: 1, telemetryComplete: true });
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
      expect(replay.observation).toEqual({ modelCalls: 0, telemetryComplete: true });
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
