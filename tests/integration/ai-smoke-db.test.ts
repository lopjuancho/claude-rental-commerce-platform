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
  reconcileSmokeBookings,
  modelCalls,
  removeSmokeAvailabilityBlock,
  requestTerminality,
  storedTurn,
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
      cleanup.state.inFlight = s.done.then(h.responded, h.failed);
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
      expect(none.unresolved.join(" ")).toMatch(/no turn recorded yet/);
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
      cleanup.state.inFlight = s.done.then(h.responded, h.failed);
      s.open();
      cleanup.state.stopping = true;
      const state = await cleanup.run({ waitForInFlightMs: 10_000 });
      expect(h.intent.state).toBe("response_completed");
      expect(state.bookingOutcome).toBe("reconciled_booking_cancelled");
      expect(await bookingStatus(pool, orgA.id, q.quoteId)).toBe("cancelled");
      expect((await bookingHoldReleased(pool, orgA.id, q.quoteId))?.blockingAllocations).toBe(0);
      expect(exitCode(state, cleanup.recovery())).toBe(0);
    });

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
        await requestTerminality(pool, orgA.id, s.session, s.requestKey, "wait_timed_out_unknown"),
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
        "wait_timed_out_unknown",
      );
      expect(started).toMatchObject({ terminal: false });
      expect(started.reason).toMatch(/mutation is still in progress/);
      await admin(
        `update public.ai_mutations set status = 'failed' where turn_id = (select id from public.ai_turns where request_key = $1)`,
        [s.requestKey],
      );
      expect(
        await requestTerminality(pool, orgA.id, s.session, s.requestKey, "wait_timed_out_unknown"),
      ).toMatchObject({ terminal: true });
      // Another tenant's scope never sees the turn (and so never calls it terminal).
      expect(
        await requestTerminality(pool, orgB.id, s.session, s.requestKey, "wait_timed_out_unknown"),
      ).toMatchObject({ terminal: false });
      s.open();
      await s.done;
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
