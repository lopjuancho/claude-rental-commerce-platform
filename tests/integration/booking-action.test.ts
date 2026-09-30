import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type * as GatewayModuleNs from "@/server/trusted/gateway";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeProduct } from "./support/availability";
import { admin, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";

/**
 * L1 coverage (Codex review of 5f8a9e3): the REAL storefront booking server action and the REAL
 * middleware, with only framework/network edges replaced — Next's request cookies/headers, the
 * redirect, the host→tenant lookup, the rate limiter and the Supabase REST transport (the trusted
 * gateway runs the same SQL functions against the test database).
 */
const state = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  set: [] as { name: string; value: string }[],
  tenant: null as Record<string, string> | null,
}));

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        state.cookies.has(name) ? { name, value: state.cookies.get(name)! } : undefined,
      set: (name: string, value: string) => {
        state.set.push({ name, value });
      },
    }),
  headers: () =>
    Promise.resolve(new Headers({ "user-agent": "vitest", "cf-connecting-ip": "198.51.100.20" })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));
vi.mock("@/server/tenancy/resolve-tenant", () => ({
  getRequestTenant: () => Promise.resolve(state.tenant),
}));
vi.mock("@/server/rate-limit", () => ({ enforceRateLimit: () => Promise.resolve() }));
vi.mock("@/server/delivery/provider", () => ({ getDistanceProvider: () => fakeProvider(8.2) }));
vi.mock("@/server/trusted/gateway", async (original) => ({
  ...(await original<typeof GatewayModuleNs>()),
  systemGateway: () => pgGateway(),
}));

const { requestBookingAction } = await import("@/app/(storefront)/quote/actions");
const { middleware } = await import("@/middleware");
const { submitQuoteRequest } = await import("@/server/public/quotes");
const { hashQuoteToken } = await import("@/server/quotes/token");

let org: TestOrg;
let day = 0;
beforeAll(async () => {
  org = await createOrg("action");
  await admin(
    `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
       primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
     where organization_id = $1`,
    [org.id],
  );
  state.tenant = {
    organizationId: org.id,
    slug: org.slug,
    name: org.slug,
    timezone: "America/Chicago",
  };
});
beforeEach(() => {
  state.cookies.clear();
  state.set.length = 0;
});

async function quote() {
  const p = await makeProduct(org, { units: 1 });
  const { token } = await submitQuoteRequest(
    state.tenant as never,
    {
      contact: { email: `act-${randomUUID().slice(0, 6)}@example.test` },
      event: {
        date: new Date(Date.UTC(2028, 10, 1 + day++)).toISOString().slice(0, 10),
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
    { ip: "198.51.100.20" },
    { gateway: pgGateway(), provider: fakeProvider(8.2), rateLimit: () => Promise.resolve() },
  );
  const q = await admin<{ id: string }>("select id from public.quotes where token_hash = $1", [
    await hashQuoteToken(token),
  ]);
  return { token, quoteId: q.rows[0]!.id };
}
const form = (token: string) => {
  const fd = new FormData();
  fd.set("token", token);
  return fd;
};
/** Runs the real action; success (the browser is sent back to the quote) is reported as "ok". */
const act = (token: string) =>
  requestBookingAction({ status: "idle" }, form(token)).then(
    (s) =>
      s.status === "error"
        ? `error:${s.message ?? ""}`
        : s.status === "success" && s.redirectTo === `/q/${token}`
          ? "ok"
          : s.status,
    (e: unknown) =>
      (e as Error).message === "NEXT_REDIRECT" ? "ok" : `throw:${(e as Error).message}`,
  );
const requestsFor = async (quoteId: string) =>
  (await admin("select 1 from public.booking_requests where quote_id = $1", [quoteId])).rowCount;
const budgetFor = async (quoteId: string) =>
  (await admin("select 1 from public.quote_hold_budgets where quote_id = $1", [quoteId])).rowCount;

describe("the real booking action and the visitor cookie", () => {
  it("without a visitor cookie: refused, no hold, no budget change, and the action mints no cookie", async () => {
    const q = await quote();
    expect(await act(q.token)).toMatch(/^error:/);
    expect(await requestsFor(q.quoteId)).toBe(0);
    expect(await budgetFor(q.quoteId)).toBe(0);
    expect(state.set).toEqual([]);
  });

  it("a storefront page GET establishes the cookie (HttpOnly, SameSite=Lax, path /, long-lived)", async () => {
    const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = ""; // no session refresh in this test
    try {
      const res = await middleware(new NextRequest("https://shop.example.test/q/abc"));
      const header = res.headers.get("set-cookie") ?? "";
      expect(header).toMatch(/rc_visitor=[A-Za-z0-9_-]{43}/);
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=lax/i);
      expect(header).toMatch(/Path=\//);
      expect(header).toMatch(/Max-Age=\d{7,}/);
      // An action (POST) never gets one.
      const post = await middleware(
        new NextRequest("https://shop.example.test/q/abc", { method: "POST" }),
      );
      expect(post.headers.get("set-cookie") ?? "").not.toMatch(/rc_visitor=/);
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
    }
  });

  it("concurrent real booking actions sharing that cookie cannot bypass the visitor cap (2)", async () => {
    const saved = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "";
    let token: string;
    try {
      const res = await middleware(new NextRequest("https://shop.example.test/quote"));
      token = /rc_visitor=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")![1]!;
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved;
    }
    state.cookies.set("rc_visitor", token);
    const qs = await Promise.all([0, 1, 2, 3, 4].map(() => quote()));
    const results = await Promise.all(qs.map((q) => act(q.token)));
    expect(results.filter((r) => r === "ok")).toHaveLength(2);
    expect(results.filter((r) => r.startsWith("error:"))).toHaveLength(3);
    expect(state.set).toEqual([]); // the actions never minted an identity
    const { hashVisitorToken } = await import("@/server/visitor");
    const live = await admin<{ n: number }>(
      `select count(*)::int n from public.reservations where organization_id = $1 and public_visitor_hash = $2
         and status = 'held' and hold_expires_at > clock_timestamp()`,
      [org.id, await hashVisitorToken(token)],
    );
    expect(live.rows[0]!.n).toBe(2);
  });
});
