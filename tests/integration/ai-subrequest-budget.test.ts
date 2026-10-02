import { afterAll, beforeAll, expect, it } from "vitest";
import { runTurn } from "@/server/ai/assistant";
import type { LlmProvider, LlmResponse } from "@/server/ai/provider";
import { generateSessionToken } from "@/server/ai/session";
import { systemAiStore, systemGateway } from "@/server/trusted/gateway";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct } from "./support/availability";
import { admin, createOrg, type TestOrg } from "./support/db";
import { describeRest } from "./support/rest";

/**
 * M7 live staging smoke (run 37001309667, attempt 2): a turn of search → details → availability →
 * create_customer made 50 Supabase requests + 5 model calls = 55 outbound requests — over the
 * Workers per-request subrequest limit (50 on the Free plan). From there every request failed:
 * the 5th model call, its telemetry row and the turn's own failure record, so the turn stayed
 * 'processing' under its lease and that session answered BUSY until it expired. The assistant read
 * the storefront shell and the product once PER TOOL; it now reads each once per turn.
 *
 * Counted here through the real system gateway and store (supabase-js over PostgREST, as the
 * Worker does), with a model that requests the same tools.
 */
let org: TestOrg;
let slug: string;
const urls: string[] = [];
const realFetch = globalThis.fetch;

function model(calls: { name: string; args: unknown }[]): LlmProvider {
  let step = 0;
  return {
    id: "budget",
    model: "budget-test",
    complete(): Promise<LlmResponse> {
      const c = calls[step++];
      return Promise.resolve(
        c
          ? {
              text: null,
              toolCalls: [
                { id: `b${String(step)}`, name: c.name, arguments: JSON.stringify(c.args) },
              ],
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          : { text: "Here you go.", toolCalls: [], usage: { inputTokens: 0, outputTokens: 0 } },
      );
    },
  };
}

beforeAll(async () => {
  org = await createOrg("budget");
  const p = await makeProduct(org, { units: 2 });
  slug = `budget-castle-${org.slug.slice(-6)}`;
  await admin(
    "update public.products set slug = $2, name = 'Budget Castle', base_price_cents = 15000 where id = $1",
    [p.productId, slug],
  );
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(new URL(u).pathname);
    return realFetch(input, init);
  };
}, 120_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describeRest("one assistant turn stays within a Worker's subrequest budget", () => {
  it("search → details → availability → create_customer: shell and product read once; ≤ 40 outbound requests", async () => {
    const tenant = {
      organizationId: org.id,
      slug: org.slug,
      name: "Budget Rentals",
      timezone: "America/Chicago",
      currency: "USD",
      resolvedBy: "host",
    } as unknown as ResolvedTenant;
    const calls = [
      { name: "search_products", args: { query: "castle", limit: 6 } },
      { name: "get_product_details", args: { productSlug: slug } },
      {
        name: "check_availability",
        args: {
          productSlug: slug,
          quantity: 1,
          date: "2027-10-09",
          startTime: "12:00",
          endTime: "16:00",
        },
      },
      { name: "create_customer", args: { email: "budget@example.test" } },
    ];
    urls.length = 0;
    const res = await runTurn(
      {
        tenant,
        sessionToken: generateSessionToken(),
        message: "Please create a quote for one castle on 2027-10-09 from 12:00 to 16:00, pickup",
        meta: { ip: "198.51.100.201" },
        correlationId: "budget",
      },
      {
        provider: model(calls),
        store: systemAiStore(),
        maxOutputTokens: 300,
        publicDeps: {
          gateway: systemGateway(),
          rateLimit: () => Promise.resolve(),
          provider: null,
        },
      },
    );
    expect(res.status).toBe("ok");
    const count = (path: string) => urls.filter((u) => u === path).length;
    // The storefront shell is read once in the turn (it was read once per tool).
    for (const table of [
      "public_storefront_settings",
      "public_storefront_domains",
      "public_storefront_policies",
      "public_catalog_categories",
      "public_catalog_event_types",
    ]) {
      expect(count(`/rest/v1/${table}`), table).toBeLessThanOrEqual(1);
    }
    // Total outbound requests: Supabase requests + one per model call. The handler adds its own
    // (tenant resolution); the Workers Free plan allows 50 per request.
    const modelCalls = calls.length + 1;
    expect(urls.length + modelCalls).toBeLessThanOrEqual(40);
  });
});
