import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { runTurn, type TurnDeps } from "@/server/ai/assistant";
import type { LlmProvider, LlmResponse } from "@/server/ai/provider";
import { generateSessionToken, hashSessionToken } from "@/server/ai/session";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken } from "@/server/visitor";
import { pgAiStore } from "./support/ai";
import { makeProduct } from "./support/availability";
import { admin, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * M7 live staging smoke (run 37001309667, attempt 2), main chat, with the live model's ACTUAL tool
 * choices (from the staging journal):
 *   "The party is on … and I will pick up."     → create_event + create_quote (quote one turn early)
 *   "Please create my quote for one <product>." → request_booking — a hold nobody asked for;
 *                                                  every later change was then QUOTE_NOT_EDITABLE.
 * Now: request_booking is refused unless the customer asked (BOOKING_NOT_REQUESTED, nothing held),
 * the existing quote is shown again WITH its link, and the rest of the flow works.
 */
let org: TestOrg;
let slug: string;
const tenant = () =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: `Org ${org.slug}`,
    timezone: "America/Chicago",
    currency: "USD",
    resolvedBy: "host",
  }) as unknown as ResolvedTenant;

/** A model that requests exactly these tool calls (one per step), then answers. */
function liveModel(calls: { name: string; args: unknown }[], text = "Done."): LlmProvider {
  let step = 0;
  return {
    id: "live-replay",
    model: "live-replay",
    complete(): Promise<LlmResponse> {
      const c = calls[step++];
      return Promise.resolve(
        c
          ? {
              text: null,
              toolCalls: [
                { id: `l${String(step)}`, name: c.name, arguments: JSON.stringify(c.args) },
              ],
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          : { text, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } },
      );
    },
  };
}

beforeAll(async () => {
  org = await createOrg("live-prog");
  const p = await makeProduct(org, { units: 3 });
  slug = `smoke-castle-${org.slug.slice(-6)}`;
  await admin(
    "update public.products set slug = $2, name = 'Smoke Castle', base_price_cents = 20000 where id = $1",
    [p.productId, slug],
  );
}, 120_000);

describeRest("the live smoke's main-chat progression (live model tool choices)", () => {
  it("no hold without the customer's request; the early quote is shown with its link; then add, book", async () => {
    const session = generateSessionToken();
    const visitor = generateVisitorToken();
    const email = `live-${randomUUID().slice(0, 8)}@example.test`;
    const say = (message: string, calls: { name: string; args: unknown }[], text?: string) => {
      const deps: TurnDeps = {
        provider: liveModel(calls, text),
        store: pgAiStore(),
        maxOutputTokens: 300,
        publicDeps: {
          gateway: pgGateway(),
          rateLimit: () => Promise.resolve(),
          provider: fakeProvider(3),
        },
      };
      return runTurn(
        {
          tenant: tenant(),
          sessionToken: session,
          message,
          meta: { ip: "198.51.100.91", visitorToken: visitor },
          correlationId: `req-${randomUUID()}`,
        },
        deps,
      );
    };
    const bookings = async () =>
      Number(
        (
          await admin<{ n: string }>(
            `select count(*)::text n from public.booking_requests b join public.quotes q on q.id = b.quote_id
             join public.customers c on c.id = q.customer_id where q.organization_id = $1 and c.email = $2`,
            [org.id, email],
          )
        ).rows[0]!.n,
      );

    await say(`My name is Smoke Test, email ${email}.`, [
      { name: "create_customer", args: { firstName: "Smoke", lastName: "Test", email } },
    ]);
    // The live model created the quote already here, and offered a booking hold.
    const early = await say(
      "The party is on 2027-10-16 from 12:00 to 16:00 and I will pick up.",
      [
        {
          name: "create_event",
          args: { date: "2027-10-16", startTime: "12:00", endTime: "16:00", fulfillment: "pickup" },
        },
        { name: "create_quote", args: { items: [{ productSlug: slug, quantity: 1 }] } },
      ],
      "I created your quote. Would you like me to request a booking hold for it?",
    );
    const q1 = early.blocks.find((b) => b.type === "quote");
    expect(q1).toMatchObject({ type: "quote" });
    const q1Url = (q1 as { url: string | null }).url;
    expect(q1Url).toMatch(/^\/q\//);

    // "Please create my quote" → the live model called request_booking. Refused: nothing held.
    const asked = await say(`Please create my quote for one Smoke Castle.`, [
      { name: "request_booking", args: {} },
      { name: "create_quote", args: {} },
    ]);
    expect(asked.blocks.some((b) => b.type === "booking")).toBe(false);
    expect(await bookings()).toBe(0);
    const conv = (
      await admin<{ id: string }>(
        "select id from public.ai_conversations where organization_id = $1 and session_hash = $2",
        [org.id, await hashSessionToken(session)],
      )
    ).rows[0]!.id;
    const refused = await admin<{ status: string; error_code: string }>(
      "select status, error_code from public.ai_actions where conversation_id = $1 and tool_name = 'request_booking'",
      [conv],
    );
    expect(refused.rows).toEqual([
      { status: "rejected_policy", error_code: "BOOKING_NOT_REQUESTED" },
    ]);
    // The existing quote comes back WITH its working link (the same one).
    const existing = asked.blocks.find((b) => b.type === "quote") as
      { quoteNumber: string; url: string | null } | undefined;
    expect(existing?.quoteNumber).toBe((q1 as { quoteNumber: string }).quoteNumber);
    expect(existing?.url).toBe(q1Url);
    // The stored conversation state never holds the link in clear.
    const stateText = (
      await admin<{ s: string }>(
        "select state::text s from public.ai_conversations where id = $1",
        [conv],
      )
    ).rows[0]!.s;
    expect(stateText).not.toContain(q1Url!.slice(3));

    // Not booked, so the quote can still change: "add one more" makes a replacement quote.
    const added = await say("Please add one more Smoke Castle to my quote.", [
      { name: "add_quote_item", args: { productSlug: slug, quantity: 1 } },
    ]);
    const q2 = added.blocks.find((b) => b.type === "quote") as
      { quoteNumber: string; replaces: string | null; url: string | null } | undefined;
    expect(q2?.replaces).toBe((q1 as { quoteNumber: string }).quoteNumber);
    expect(q2?.url).toMatch(/^\/q\//);

    // The customer's own request places the hold.
    const booked = await say("Please request the booking.", [
      { name: "request_booking", args: {} },
    ]);
    expect(booked.blocks.find((b) => b.type === "booking")).toMatchObject({
      quoteNumber: q2?.quoteNumber,
      status: "hold_placed",
    });
    expect(await bookings()).toBe(1);
  });

  it("a short yes to the assistant's booking offer is the customer's request", async () => {
    const session = generateSessionToken();
    const visitor = generateVisitorToken();
    const email = `yes-${randomUUID().slice(0, 8)}@example.test`;
    const say = (message: string, calls: { name: string; args: unknown }[], text?: string) =>
      runTurn(
        {
          tenant: tenant(),
          sessionToken: session,
          message,
          meta: { ip: "198.51.100.92", visitorToken: visitor },
          correlationId: `req-${randomUUID()}`,
        },
        {
          provider: liveModel(calls, text),
          store: pgAiStore(),
          maxOutputTokens: 300,
          publicDeps: {
            gateway: pgGateway(),
            rateLimit: () => Promise.resolve(),
            provider: fakeProvider(3),
          },
        },
      );
    await say(
      `I'm Robin, ${email}. One Smoke Castle on 2027-10-23 from 12:00 to 16:00, pickup, please quote it.`,
      [
        { name: "create_customer", args: { email } },
        {
          name: "create_event",
          args: { date: "2027-10-23", startTime: "12:00", endTime: "16:00", fulfillment: "pickup" },
        },
        { name: "create_quote", args: { items: [{ productSlug: slug, quantity: 1 }] } },
      ],
      "Here is your quote. Would you like me to request a booking hold?",
    );
    const yes = await say("Yes please", [{ name: "request_booking", args: {} }]);
    expect(yes.blocks.find((b) => b.type === "booking")).toMatchObject({ status: "hold_placed" });
  });
});
