import { createHash, randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnInput } from "@/server/ai/assistant";
import { emptyState } from "@/server/ai/context";
import { Deadline } from "@/server/ai/deadline";
import { durableJournal } from "@/server/ai/journal";
import { sessionSealer } from "@/server/ai/seal";
import type { LlmProvider, LlmRequest, LlmResponse } from "@/server/ai/provider";
import { generateSessionToken, hashSessionToken } from "@/server/ai/session";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import type { AiConversationStore } from "@/server/trusted/gateway";
import { generateVisitorToken } from "@/server/visitor";
import { makeProduct } from "./support/availability";
import { pgAiStore } from "./support/ai";
import { admin, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * H2 / M4 (Codex review of 88d1f29): a retry, a provider failure, a lost response, a duplicate or
 * concurrent request, or the turn deadline never repeats a business mutation and never loses the
 * only reference to one that committed. Real database, real journal, deterministic models.
 */
let org: TestOrg;
const testSealer = sessionSealer("t".repeat(43), "00000000-0000-4000-8000-000000000000");
let day = 1;
const nextDate = () => new Date(Date.UTC(2028, 2, day++ * 2)).toISOString().slice(0, 10);

const tenant = () =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: `Org ${org.slug}`,
    timezone: "America/Chicago",
    currency: "USD",
    resolvedBy: "host",
  }) as unknown as ResolvedTenant;

beforeAll(async () => {
  org = await createOrg("durable");
  const p = await makeProduct(org, { units: 5 });
  await admin(
    "update public.products set slug = 'bounce-castle', name = 'Bounce Castle', base_price_cents = 20000 where id = $1",
    [p.productId],
  );
  const p2 = await makeProduct(org, { units: 5 });
  await admin(
    "update public.products set slug = 'snow-cone', name = 'Snow Cone Machine', base_price_cents = 5000 where id = $1",
    [p2.productId],
  );
  const j = await admin<{ id: string }>(
    "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes, status) values ($1, 'T', 'TN', '{38127}', 'active') returning id",
    [org.id],
  );
  await admin(
    "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'Tax', 1000)",
    [org.id, j.rows[0]!.id],
  );
  for (const component of [
    "rental",
    "add_on",
    "delivery",
    "labor",
    "fee",
    "discount",
    "adjustment",
  ]) {
    await admin(
      "insert into public.tax_component_rules (organization_id, jurisdiction_id, component, taxable) values ($1, $2, $3, true)",
      [org.id, j.rows[0]!.id, component],
    );
  }
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '1 Depot Rd', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127' where organization_id = $1`,
    [org.id],
  );
}, 120_000);

// ── deterministic models ────────────────────────────────────────────────────

type Step =
  | { call: string; args: unknown }
  | { say: string }
  | { fail: true }
  | { wait: Promise<unknown>; then: Step };

const tool = (call: string, args: unknown = {}): Step => ({ call, args });

/** Plays the steps in order, one per model call. */
function model(steps: Step[]): LlmProvider & { calls: number; seen: LlmRequest[] } {
  const seen: LlmRequest[] = [];
  const m = {
    id: "plan",
    model: "plan-test",
    calls: 0,
    seen,
    async complete(req: LlmRequest): Promise<LlmResponse> {
      seen.push(req);
      let step = steps[m.calls++] ?? { say: "Done." };
      while ("wait" in step) {
        await step.wait;
        step = step.then;
      }
      if ("fail" in step) throw Object.assign(new Error("provider down"), { code: "HTTP" });
      if ("say" in step) {
        return { text: step.say, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } };
      }
      return {
        text: null,
        toolCalls: [
          { id: `c${String(m.calls)}`, name: step.call, arguments: JSON.stringify(step.args) },
        ],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
  return m;
}

function deps(provider: LlmProvider, over: Partial<TurnDeps> = {}): TurnDeps {
  return {
    provider,
    store: pgAiStore(),
    maxOutputTokens: 300,
    publicDeps: {
      gateway: pgGateway(),
      rateLimit: () => Promise.resolve(),
      provider: fakeProvider(3),
    },
    ...over,
  };
}

function conversation() {
  const session = generateSessionToken();
  const visitor = generateVisitorToken();
  const email = `durable-${randomUUID().slice(0, 8)}@example.test`;
  const date = nextDate();
  const turn = (
    message: string,
    d: TurnDeps,
    requestKey?: string,
    extra: Partial<TurnInput> = {},
  ) =>
    runTurn(
      {
        tenant: tenant(),
        sessionToken: session,
        message,
        ...(requestKey ? { requestKey } : {}),
        meta: { ip: "198.51.100.44", visitorToken: visitor },
        correlationId: `c-${randomUUID()}`,
        ...extra,
      },
      d,
    );
  const setup = [
    tool("create_customer", { firstName: "Dana", email }),
    tool("create_event", { date, startTime: "12:00", endTime: "16:00", fulfillment: "pickup" }),
  ];
  return { session, email, date, turn, setup };
}

const count = async (sql: string, params: unknown[]) =>
  Number(
    (await admin<{ n: string }>(`select count(*)::text n from (${sql}) x`, params)).rows[0]!.n,
  );
const quotesFor = (email: string) =>
  count(
    "select q.id from public.quotes q join public.customers c on c.id = q.customer_id where c.email = $1",
    [email],
  );
const eventsFor = (email: string) =>
  count(
    "select e.id from public.events e join public.customers c on c.id = e.customer_id where c.email = $1",
    [email],
  );
const bookingsFor = (email: string) =>
  count(
    "select b.id from public.booking_requests b join public.quotes q on q.id = b.quote_id join public.customers c on c.id = q.customer_id where c.email = $1",
    [email],
  );
async function conversationRow(session: string) {
  return (
    await admin<{
      id: string;
      state: { quote?: { quoteNumber: string }; items: unknown[] };
      message_count: number;
      active_turn_id: string | null;
    }>(
      "select id, state, message_count, active_turn_id from public.ai_conversations where session_hash = $1",
      [await hashSessionToken(session)],
    )
  ).rows[0]!;
}

const variantOf = async (slug: string) =>
  (
    await admin<{ id: string }>(
      "select v.id from public.product_variants v join public.products p on p.id = v.product_id where p.organization_id = $1 and p.slug = $2 limit 1",
      [org.id, slug],
    )
  ).rows[0]!.id;

const linkOf = (r: { blocks: { type: string }[] }) =>
  (r.blocks.find((b) => b.type === "quote") as { url: string | null } | undefined)?.url ?? null;
/** How many quotes this link opens (1 = a working link). */
const quoteForLink = async (url: string) =>
  count("select 1 from public.quotes where token_hash = $1", [
    createHash("sha256").update(url.replace("/q/", "")).digest("hex"),
  ]);

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => {
    open = r;
  });
  return { p, open };
};
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

// ── H2: retries and failures ───────────────────────────────────────────────

describeRest("failed and repeated turns never repeat a mutation (H2)", () => {
  it("provider fails after create_quote → the reference is kept; retrying creates nothing new", async () => {
    const c = conversation();
    const key = randomUUID();
    const first = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { fail: true },
        ]),
      ),
      key,
    );
    expect(first).toMatchObject({ status: "error", errorCode: "AI_UNAVAILABLE" });
    // The customer still gets the quote card (with its link) and the conversation keeps it.
    const card = first.blocks.find((b) => b.type === "quote");
    expect((card as { url: string | null } | undefined)?.url).toMatch(/^\/q\//);
    expect(first.reply).toMatch(/Quote Q-\d+ is ready/);
    const row = await conversationRow(c.session);
    expect(row.state.quote?.quoteNumber).toMatch(/^Q-\d+$/);
    expect(row.active_turn_id).toBeNull();
    expect(row.message_count).toBe(0); // a failed turn keeps state, not messages
    expect(await quotesFor(c.email)).toBe(1);

    // "Try again" (same request id): the model re-plans and asks for the quote again.
    const retry = await c.turn(
      "Please create my quote",
      deps(model([tool("create_quote", {}), { say: "Your quote is ready." }])),
      key,
    );
    expect(retry.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
    expect(await eventsFor(c.email)).toBe(1);
    const turns = await admin<{ attempt: number; status: string }>(
      "select attempt, status from public.ai_turns where conversation_id = $1",
      [row.id],
    );
    expect(turns.rows).toEqual([{ attempt: 2, status: "completed" }]);
    // Even a NEW message asking again returns the same quote.
    const again = await c.turn(
      "create the quote again",
      deps(model([tool("create_quote", {}), { say: "Here it is." }])),
    );
    expect(again.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
  });

  it("a lost response: the same request id replays the stored reply without running anything", async () => {
    const c = conversation();
    const key = randomUUID();
    const plan = model([
      ...c.setup,
      tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
      { say: "Your quote is ready." },
    ]);
    const first = await c.turn("Please create my quote", deps(plan), key);
    expect(first.status).toBe("ok");
    const again = model([{ fail: true }]);
    const replay = await c.turn("Please create my quote", deps(again), key);
    expect(replay).toMatchObject({ status: "ok", reply: first.reply, replayed: true });
    expect(again.calls).toBe(0);
    // N2: the replay carries a WORKING quote link (stored sealed to this session, never in clear).
    const url = linkOf(replay);
    expect(url).toMatch(/^\/q\/[A-Za-z0-9_-]{43}$/);
    expect(await quoteForLink(url!)).toBe(1);
    const stored = await admin<{ s: string }>(
      "select response::text s from public.ai_turns t join public.ai_conversations c on c.id = t.conversation_id where c.session_hash = $1",
      [await hashSessionToken(c.session)],
    );
    expect(stored.rows[0]!.s).not.toContain(url!.slice(3));
    expect(await quotesFor(c.email)).toBe(1);
  });

  it("a duplicate POST while the first is running is told to wait; nothing runs twice", async () => {
    const c = conversation();
    const key = randomUUID();
    const g = gate();
    const slow = model([
      ...c.setup,
      tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
      { wait: g.p, then: { say: "Your quote is ready." } },
    ]);
    const firstP = c.turn("Please create my quote", deps(slow), key);
    while (slow.calls < 4) await sleep(10);
    const dup = model([tool("create_quote", {})]);
    const second = await c.turn("Please create my quote", deps(dup), key);
    expect(second).toMatchObject({ status: "error", errorCode: "IN_PROGRESS" });
    expect(dup.calls).toBe(0);
    g.open();
    expect((await firstP).status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
  });

  it("two concurrent messages in one conversation: the second is refused before it can mutate", async () => {
    const c = conversation();
    const g = gate();
    const slow = model([...c.setup, { wait: g.p, then: { say: "Saved." } }]);
    const firstP = c.turn("My details", deps(slow), randomUUID());
    while (slow.calls < 3) await sleep(10);
    const other = model([
      tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
    ]);
    const second = await c.turn("create my quote now", deps(other), randomUUID());
    expect(second).toMatchObject({ status: "error", errorCode: "BUSY" });
    expect(other.calls).toBe(0);
    g.open();
    await firstP;
    expect(await quotesFor(c.email)).toBe(0);
    // Many simultaneous messages: exactly one runs.
    const racers = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        c.turn(
          "create my quote",
          deps(
            model([
              tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
              { say: "ok" },
            ]),
          ),
          randomUUID(),
        ),
      ),
    );
    // Every message either ran (serially) or was refused as busy — and only one quote exists.
    expect(racers.every((r) => r.status === "ok" || r.errorCode === "BUSY")).toBe(true);
    expect(racers.some((r) => r.status === "ok")).toBe(true);
    expect(await quotesFor(c.email)).toBe(1);
  });

  it("the journal admits one claim per mutation key; a turn that lost the conversation cannot claim", async () => {
    const store = pgAiStore();
    const hash = await hashSessionToken(generateSessionToken());
    const claim = await store.beginTurn(org.id, hash, randomUUID().replace(/-/g, ""), 60, null);
    const turn = { turnId: claim.turnId!, attempt: claim.attempt! };
    const key = "a".repeat(64);
    const both = await Promise.all(
      [1, 2].map(() =>
        store.beginMutation(org.id, turn, {
          key,
          toolName: "create_quote",
          toolCallId: "x",
          pending: null,
        }),
      ),
    );
    expect(both.map((b) => b.outcome).sort()).toEqual(["in_progress", "proceed"]);
    await expect(
      store.beginMutation(
        org.id,
        { turnId: turn.turnId, attempt: 99 },
        { key: "b".repeat(64), toolName: "create_quote", toolCallId: "y", pending: null },
      ),
    ).rejects.toMatchObject({ db: { code: "RA010" } });
    // Another tenant cannot use this turn at all.
    const other = await createOrg("durable-other");
    await expect(
      store.beginMutation(other.id, turn, {
        key: "c".repeat(64),
        toolName: "create_quote",
        toolCallId: "z",
        pending: null,
      }),
    ).rejects.toMatchObject({ db: { code: "RA005" } });
  });

  it("add_quote_item retried after a failure is not added twice", async () => {
    const c = conversation();
    await c.turn(
      "quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Quote ready." },
        ]),
      ),
    );
    const key = randomUUID();
    const failed = await c.turn(
      "add a snow cone machine",
      deps(
        model([tool("add_quote_item", { productSlug: "snow-cone", quantity: 1 }), { fail: true }]),
      ),
      key,
    );
    expect(failed.errorCode).toBe("AI_UNAVAILABLE");
    const retried = await c.turn(
      "add a snow cone machine",
      deps(
        model([
          tool("add_quote_item", { productSlug: "snow-cone", quantity: 1 }),
          { say: "Added." },
        ]),
      ),
      key,
    );
    expect(retried.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(2); // the original + ONE updated quote
    const row = await conversationRow(c.session);
    const items = await admin<{ name: string; quantity: number }>(
      `select qi.product_name name, qi.quantity from public.quote_items qi join public.quotes q on q.id = qi.quote_id
       where q.organization_id = $1 and q.quote_number = $2 order by 1`,
      [org.id, row.state.quote!.quoteNumber],
    );
    expect(items.rows).toEqual([
      { name: "Bounce Castle", quantity: 1 },
      { name: "Snow Cone Machine", quantity: 1 },
    ]);
    // A NEW message asking to add one more does add one more (it is a new request).
    await c.turn(
      "add another snow cone machine",
      deps(
        model([
          tool("add_quote_item", { productSlug: "snow-cone", quantity: 1 }),
          { say: "Added." },
        ]),
      ),
    );
    expect(await quotesFor(c.email)).toBe(3);
  });

  it("request_booking retried after a failure replays the hold; exactly one booking request", async () => {
    const c = conversation();
    await c.turn(
      "quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Quote ready." },
        ]),
      ),
    );
    const key = randomUUID();
    const failed = await c.turn(
      "request the booking",
      deps(model([tool("request_booking"), { fail: true }])),
      key,
    );
    expect(failed.blocks.find((b) => b.type === "booking")).toMatchObject({
      status: "hold_placed",
    });
    const retried = await c.turn(
      "request the booking",
      deps(
        model([
          tool("request_booking"),
          {
            say: "Your booking request has been submitted and the inventory is being held for 15 minutes.",
          },
        ]),
      ),
      key,
    );
    expect(retried.status).toBe("ok");
    expect(retried.blocks.find((b) => b.type === "booking")).toMatchObject({
      status: "hold_placed",
    });
    expect(await bookingsFor(c.email)).toBe(1);
  });

  it("the conversation cannot be saved after a committed mutation → the next turn still has the quote", async () => {
    const c = conversation();
    const base = pgAiStore();
    const broken: AiConversationStore = {
      ...base,
      finishTurn: () => Promise.reject(Object.assign(new Error("conflict"), { code: "RA010" })),
      failTurn: () => Promise.reject(Object.assign(new Error("conflict"), { code: "RA010" })),
    };
    const first = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Your quote is ready." },
        ]),
        { store: broken },
      ),
      randomUUID(),
    );
    // N3: nothing could be saved, so the reply says so (retryable) — the committed quote stays shown.
    expect(first).toMatchObject({ status: "error", errorCode: "PERSIST_FAILED" });
    expect(first.blocks.find((b) => b.type === "quote")).toBeTruthy();
    expect(await quotesFor(c.email)).toBe(1);
    // Nothing was saved to the conversation — but the journal holds the committed quote. (The
    // unsaved turn keeps its lease until it expires; expire it as a crashed server would.)
    await admin(
      "update public.ai_conversations set active_turn_expires_at = now() - interval '1 second' where session_hash = $1",
      [await hashSessionToken(c.session)],
    );
    expect((await conversationRow(c.session)).state.quote).toBeUndefined();
    const next = await c.turn(
      "create my quote",
      deps(model([tool("create_quote", {}), { say: "Here it is." }])),
    );
    expect(next.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
    expect((await conversationRow(c.session)).state.quote?.quoteNumber).toMatch(/^Q-/);
  });

  it("New Chat while an old turn is still running: the old turn finishes in the old conversation only", async () => {
    const old = conversation();
    const g = gate();
    const slow = model([
      ...old.setup,
      tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
      { wait: g.p, then: { say: "Your quote is ready." } },
    ]);
    const oldP = old.turn("Please create my quote", deps(slow), randomUUID());
    while (slow.calls < 4) await sleep(10);
    // "New chat" = a new session cookie: a separate, empty conversation.
    const fresh = conversation();
    const res = await fresh.turn("hi", deps(model([{ say: "Hello!" }])));
    expect(res.status).toBe("ok");
    expect((await conversationRow(fresh.session)).state.quote).toBeUndefined();
    g.open();
    expect((await oldP).status).toBe("ok");
    expect((await conversationRow(old.session)).state.quote?.quoteNumber).toMatch(/^Q-/);
    expect((await conversationRow(fresh.session)).state.quote).toBeUndefined();
    expect(await quotesFor(old.email)).toBe(1);
  });
});

// ── M4: one absolute deadline ───────────────────────────────────────────────

describeRest("the turn deadline bounds the whole turn (M4)", () => {
  const short = { turnTimeoutMs: 600 };

  it("a slow model: the turn ends at the deadline, nothing is saved but the (unchanged) state", async () => {
    const c = conversation();
    const g = gate();
    const started = Date.now();
    const res = await c.turn(
      "hello",
      deps(model([{ wait: g.p, then: { say: "late" } }]), { limits: short }),
    );
    expect(res).toMatchObject({ status: "error", errorCode: "TURN_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(600 + 2_000);
    g.open();
    const row = await conversationRow(c.session);
    expect(row.message_count).toBe(0);
    expect(row.active_turn_id).toBeNull();
    const turns = await admin<{ status: string; error_code: string }>(
      "select status, error_code from public.ai_turns where conversation_id = $1",
      [row.id],
    );
    expect(turns.rows).toEqual([{ status: "failed", error_code: "TURN_TIMEOUT" }]);
  });

  it("a slow read tool stops at the deadline", async () => {
    const c = conversation();
    const started = Date.now();
    const res = await c.turn(
      "is it available?",
      deps(
        model([
          tool("check_availability", {
            productSlug: "bounce-castle",
            quantity: 1,
            date: c.date,
            startTime: "12:00",
            endTime: "16:00",
          }),
          { say: "checked" },
        ]),
        {
          limits: short,
          publicDeps: {
            gateway: pgGateway(),
            rateLimit: () => sleep(3_000),
            provider: fakeProvider(3),
          },
        },
      ),
    );
    expect(Date.now() - started).toBeLessThan(600 + 2_000);
    expect(res.status).toBe("error");
    expect(res.errorCode).toBe("TURN_TIMEOUT");
  });

  it("a mutation is never STARTED after the deadline", async () => {
    const c = conversation();
    const res = await c.turn(
      "create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "done" },
        ]),
        {
          limits: short,
          // The tool call reaches the dispatcher only after the deadline has passed.
          execute: async (name, args, ctx, onError) => {
            if (name === "create_quote") await sleep(900);
            const { executeTool } = await import("@/server/ai/tools");
            return executeTool(name, args, ctx, onError);
          },
        },
      ),
    );
    expect(res.status).toBe("error");
    expect(await quotesFor(c.email)).toBe(0);
    const row = await conversationRow(c.session);
    expect(
      await count("select 1 from public.ai_mutations where conversation_id = $1", [row.id]),
    ).toBe(0);
    // The journal itself refuses too.
    const deadline = Deadline.in(-1);
    const journal = durableJournal({
      store: pgAiStore(),
      organizationId: org.id,
      conversationId: row.id,
      turn: { turnId: randomUUID(), attempt: 1 },
      state: emptyState(),
      deadline,
      toolCallId: () => "x",
      sealer: testSealer,
      onApplied: () => undefined,
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    let performed = false;
    await expect(
      journal.run({
        toolName: "create_quote",
        key: {},
        pending: {},
        sealer: testSealer,
        recover: () => Promise.resolve(null),
        perform: () => {
          performed = true;
          return Promise.reject(new Error("unreachable"));
        },
      }),
    ).rejects.toMatchObject({ code: "TURN_DEADLINE" });
    expect(performed).toBe(false);
    deadline.dispose();
  });

  it("the deadline passes DURING a mutation: it completes, is journaled, and a retry does not repeat it", async () => {
    const c = conversation();
    const key = randomUUID();
    const slowWrites = {
      gateway: pgGateway(),
      // submitQuoteRequest's first step: the quote creation is slow, past the deadline.
      rateLimit: (policy: string) => (policy === "publicWrite" ? sleep(900) : Promise.resolve()),
      provider: fakeProvider(3),
    };
    const res = await c.turn(
      "create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "done" },
        ]),
        { limits: short, publicDeps: slowWrites },
      ),
      key,
    );
    expect(res).toMatchObject({ status: "error", errorCode: "TURN_TIMEOUT" });
    expect(res.blocks.find((b) => b.type === "quote")).toBeTruthy();
    expect(await quotesFor(c.email)).toBe(1);
    const row = await conversationRow(c.session);
    expect(row.state.quote?.quoteNumber).toMatch(/^Q-/);
    const journal = await admin<{ status: string; tool_name: string }>(
      "select status, tool_name from public.ai_mutations where conversation_id = $1",
      [row.id],
    );
    expect(journal.rows).toEqual([{ status: "committed", tool_name: "create_quote" }]);
    const retry = await c.turn(
      "create my quote",
      deps(model([tool("create_quote", {}), { say: "Here it is." }])),
      key,
    );
    expect(retry.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
  });
});

// ── round 2 (Codex review of 40c26dd) ───────────────────────────────────────

/** A store whose selected methods fail (a crash between two steps). */
function failing(
  methods: ("commitMutation" | "finishTurn" | "failTurn")[],
  base: AiConversationStore = pgAiStore(),
): AiConversationStore {
  const boom = () => Promise.reject(Object.assign(new Error("store down"), { code: "X" }));
  return {
    ...base,
    ...Object.fromEntries(methods.map((m) => [m, boom])),
  };
}
/** What happens when a worker dies: its turn's lease runs out (both records carry it). */
const expireLease = async (session: string) => {
  const hash = await hashSessionToken(session);
  await admin(
    "update public.ai_turns t set lease_expires_at = now() - interval '1 second' from public.ai_conversations c where c.id = t.conversation_id and c.session_hash = $1 and t.status = 'processing'",
    [hash],
  );
  await admin(
    "update public.ai_conversations set active_turn_expires_at = now() - interval '1 second' where session_hash = $1",
    [hash],
  );
};

describeRest("business writes are idempotent at the write itself (H2)", () => {
  it("the recorded recovery identity is never replaced by a later attempt", async () => {
    const store = pgAiStore();
    const session = generateSessionToken();
    const hash = await hashSessionToken(session);
    const requestKey = randomUUID().replace(/-/g, "");
    const t1 = await store.beginTurn(org.id, hash, requestKey, 60, null);
    const key = createHash("sha256").update(randomUUID()).digest("hex");
    const first = await store.beginMutation(
      org.id,
      { turnId: t1.turnId!, attempt: t1.attempt! },
      { key, toolName: "create_quote", toolCallId: "a", pending: { tokenHash: "A".repeat(4) } },
    );
    expect(first.outcome).toBe("proceed");
    await expireLease(session);
    const t2 = await store.beginTurn(org.id, hash, requestKey, 60, null);
    expect(t2.attempt).toBe(2);
    const second = await store.beginMutation(
      org.id,
      { turnId: t2.turnId!, attempt: t2.attempt! },
      { key, toolName: "create_quote", toolCallId: "b", pending: { tokenHash: "B".repeat(4) } },
    );
    expect(second).toMatchObject({ outcome: "unknown", pending: { tokenHash: "AAAA" } });
  });

  it("two workers racing the same key create one event, one quote and one booking request", async () => {
    const { submitQuoteRequest, requestPublicBooking } = await import("@/server/public/quotes");
    const { generateQuoteToken } = await import("@/server/quotes/token");
    const key = createHash("sha256").update(randomUUID()).digest("hex");
    const email = `race-${randomUUID().slice(0, 8)}@example.test`;
    const input = {
      contact: { firstName: "Race", email },
      event: { date: nextDate(), startTime: "12:00", endTime: "16:00", address: null },
      items: [{ variantId: await variantOf("bounce-castle"), quantity: 1 }],
      delivery: "pickup" as const,
    };
    const deps = {
      gateway: pgGateway(),
      rateLimit: () => Promise.resolve(),
      provider: fakeProvider(3),
    };
    const meta = {
      ip: "198.51.100.90",
      actor: "ai" as const,
      visitorToken: generateVisitorToken(),
    };
    const token = generateQuoteToken();
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        submitQuoteRequest(tenant(), input, meta, deps, { token, idempotencyKey: key }),
      ),
    );
    expect(new Set(results.map((r) => r.quoteId)).size).toBe(1);
    expect(await quotesFor(email)).toBe(1);
    expect(await eventsFor(email)).toBe(1);
    const bookingKey = createHash("sha256").update(randomUUID()).digest("hex");
    const holds = await Promise.allSettled(
      [1, 2, 3].map(() =>
        requestPublicBooking(tenant(), { tokenHash: results[0]!.tokenHash }, {}, meta, deps, {
          idempotencyKey: bookingKey,
        }),
      ),
    );
    expect(holds.filter((h) => h.status === "fulfilled")).toHaveLength(3);
    expect(await bookingsFor(email)).toBe(1);
  });

  it("the process dies after the quote is written but before anything is recorded: the retry finds it", async () => {
    const c = conversation();
    const key = randomUUID();
    // Crash: the journal commit, the turn finish and the failure record all fail.
    const crashed = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { fail: true },
        ]),
        { store: failing(["commitMutation", "finishTurn", "failTurn"]) },
      ),
      key,
    );
    expect(crashed.status).toBe("error");
    expect(await quotesFor(c.email)).toBe(1);
    expect((await conversationRow(c.session)).state.quote).toBeUndefined(); // nothing saved
    await expireLease(c.session);
    // Same message again: the model re-plans the whole thing; the journal's recorded input and
    // the business key resolve it to the SAME quote, with a working link.
    const retry = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Your quote is ready." },
        ]),
      ),
      key,
    );
    expect(retry.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
    expect(await eventsFor(c.email)).toBe(1);
    const url = linkOf(retry);
    expect(url).not.toBeNull();
    expect(await quoteForLink(url!)).toBe(1);
  });

  it("an old worker still inside the write after its lease was taken over resolves to the same quote", async () => {
    const c = conversation();
    const key = randomUUID();
    const g = gate();
    // The old worker stalls inside the quote write (before the event is created).
    const stalled = {
      gateway: pgGateway(),
      rateLimit: (policy: string) => (policy === "publicWrite" ? g.p : Promise.resolve()),
      provider: fakeProvider(3),
    };
    const oldP = c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "old worker done" },
        ]),
        { publicDeps: stalled },
      ),
      key,
    );
    // Wait until the old worker has claimed the mutation, then let its lease expire.
    for (let i = 0; i < 100; i++) {
      const n = await count(
        "select 1 from public.ai_mutations m join public.ai_conversations c on c.id = m.conversation_id where c.session_hash = $1",
        [await hashSessionToken(c.session)],
      );
      if (n > 0) break;
      await sleep(20);
    }
    await expireLease(c.session);
    const takeover = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Your quote is ready." },
        ]),
      ),
      key,
    );
    expect(takeover.status).toBe("ok");
    expect(await quotesFor(c.email)).toBe(1);
    g.open(); // the old worker now finishes its write — under the same business key
    await oldP;
    expect(await quotesFor(c.email)).toBe(1);
    expect(await eventsFor(c.email)).toBe(1);
  });
});

describeRest("recovery restores the ORIGINAL committed basis (H3)", () => {
  it("Codex reproduction: quote B has quantity 2 and recovers as quantity 2, never 3", async () => {
    const c = conversation();
    await c.turn(
      "quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "Quote ready." },
        ]),
      ),
    );
    const key = randomUUID();
    // add_quote_item makes quote B (quantity 2); both journal commits fail; the provider fails.
    const failed = await c.turn(
      "add one more castle",
      deps(
        model([
          tool("add_quote_item", { productSlug: "bounce-castle", quantity: 1 }),
          { fail: true },
        ]),
        { store: failing(["commitMutation"]) },
      ),
      key,
    );
    expect(failed.status).toBe("error");
    // Retry of the same message: staging now says 2, so "+1" would compute 3 — but the recorded
    // input (and the quote in the database) is 2.
    const retried = await c.turn(
      "add one more castle",
      deps(
        model([
          tool("add_quote_item", { productSlug: "bounce-castle", quantity: 1 }),
          tool("request_booking"),
          { say: "Done." },
        ]),
      ),
      key,
    );
    expect(retried.status).toBe("ok");
    const row = await conversationRow(c.session);
    const quoteNumber = row.state.quote!.quoteNumber;
    const items = await admin<{ quantity: number }>(
      "select qi.quantity from public.quote_items qi join public.quotes q on q.id = qi.quote_id where q.organization_id = $1 and q.quote_number = $2",
      [org.id, quoteNumber],
    );
    expect(items.rows).toEqual([{ quantity: 2 }]);
    expect(row.state.items).toEqual([expect.objectContaining({ quantity: 2 })]);
    expect(await quotesFor(c.email)).toBe(2); // A and B, never a third
    // The recovered quote is current (it matches the database), so it could be requested.
    expect(retried.blocks.find((b) => b.type === "booking")).toMatchObject({
      status: "hold_placed",
    });
  });

  it("a recovered quote that does not match its recorded input is never current: booking refused", async () => {
    for (const tamper of ["event", "items"] as const) {
      const c = conversation();
      const key = randomUUID();
      await c.turn(
        "Please create my quote",
        deps(
          model([
            ...c.setup,
            tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
            { fail: true },
          ]),
          { store: failing(["commitMutation", "finishTurn", "failTurn"]) },
        ),
        key,
      );
      await expireLease(c.session);
      // The quote in the database no longer matches what was recorded (e.g. changed by staff).
      const q = await admin<{ id: string; event_id: string }>(
        "select q.id, q.event_id from public.quotes q join public.customers c on c.id = q.customer_id where c.email = $1",
        [c.email],
      );
      if (tamper === "event") {
        await admin("update public.events set end_time = '18:00' where id = $1", [
          q.rows[0]!.event_id,
        ]);
      } else {
        const m = await admin<{
          id: string;
          pending: { staged: { items: { quantity: number }[] } };
        }>(
          "select m.id, m.pending from public.ai_mutations m join public.ai_conversations c on c.id = m.conversation_id where c.session_hash = $1",
          [await hashSessionToken(c.session)],
        );
        // Recorded input says 3 castles; the quote has 1 (simulates a mismatched record).
        const pending = m.rows[0]!.pending;
        pending.staged.items = pending.staged.items.map((i) => ({ ...i, quantity: 3 }));
        await admin("update public.ai_mutations set pending = $2 where id = $1", [
          m.rows[0]!.id,
          JSON.stringify(pending),
        ]);
      }
      const retry = await c.turn(
        "Please create my quote",
        deps(
          model([
            ...c.setup,
            tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
            tool("request_booking"),
            { say: "ok" },
          ]),
        ),
        key,
      );
      expect(retry.status, tamper).toBe("ok");
      expect(await bookingsFor(c.email), tamper).toBe(0);
      const state = (await conversationRow(c.session)).state as { quote?: { verified?: boolean } };
      expect(state.quote?.verified, tamper).toBe(false);
    }
  });
});

describeRest("deadline fencing of the write itself (M4)", () => {
  it("a mutation claim that returns after the deadline never performs the write", async () => {
    const c = conversation();
    const base = pgAiStore();
    const slowClaim: AiConversationStore = {
      ...base,
      beginMutation: async (...args) => {
        await sleep(900);
        return base.beginMutation(...args);
      },
    };
    const res = await c.turn(
      "Please create my quote",
      deps(
        model([
          ...c.setup,
          tool("create_quote", { items: [{ productSlug: "bounce-castle", quantity: 1 }] }),
          { say: "done" },
        ]),
        { store: slowClaim, limits: { turnTimeoutMs: 600 } },
      ),
    );
    expect(res.status).toBe("error");
    expect(await quotesFor(c.email)).toBe(0);
    expect(await eventsFor(c.email)).toBe(0);
    const row = await conversationRow(c.session);
    const journal = await admin<{ status: string; error_code: string }>(
      "select status, error_code from public.ai_mutations where conversation_id = $1",
      [row.id],
    );
    expect(journal.rows).toEqual([{ status: "failed", error_code: "TURN_DEADLINE" }]);
  });
});

describeRest("a failed save never claims staging was saved (N3)", () => {
  it.each([
    ["contact", tool("create_customer", { firstName: "Ana", email: "n3@example.test" })],
    [
      "event",
      tool("create_event", {
        date: "2028-09-02",
        startTime: "12:00",
        endTime: "16:00",
        fulfillment: "pickup",
      }),
    ],
  ])("%s-only turn", async (_what, step) => {
    const c = conversation();
    const res = await c.turn(
      "here are my details",
      deps(model([step, { say: "Thanks, I saved your details." }]), {
        store: failing(["finishTurn"]),
      }),
    );
    expect(res).toMatchObject({ status: "error", errorCode: "PERSIST_FAILED" });
    expect(res.reply).not.toMatch(/saved your/i);
    expect(res.reply).toMatch(/send your last message again/);
    const row = await conversationRow(c.session);
    expect(row.active_turn_id).toBeNull(); // released for the retry
    expect(JSON.stringify(row.state)).not.toContain("n3@example.test");
    expect(JSON.stringify(row.state)).not.toContain("2028-09-02");
  });
});
