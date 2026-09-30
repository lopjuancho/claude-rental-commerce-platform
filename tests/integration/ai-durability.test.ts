import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnInput } from "@/server/ai/assistant";
import { emptyState } from "@/server/ai/context";
import { Deadline } from "@/server/ai/deadline";
import { durableJournal } from "@/server/ai/journal";
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
    // The stored reply never contains the quote link token.
    expect(replay.blocks.find((b) => b.type === "quote")).toMatchObject({ url: null });
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
    expect(first.status).toBe("ok");
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
      onApplied: () => undefined,
      onCommitted: () => undefined,
      onError: () => undefined,
    });
    let performed = false;
    await expect(
      journal.run({
        toolName: "create_quote",
        key: {},
        pending: null,
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
