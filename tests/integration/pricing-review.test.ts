import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PostalAddress } from "@/domain/delivery/address";
import type { DistanceProvider } from "@/domain/delivery/provider";
import { formatCents } from "@/domain/money";
import { explainReviewReason } from "@/domain/pricing/reasons";
import type { PriceResult } from "@/domain/pricing/types";
import { applyTenantBundle } from "../../scripts/tenant/apply-bundle.ts";
import { tenantBundleSchema } from "../../scripts/tenant/bundle-schema.ts";
import { june, makeProduct } from "./support/availability";
import { testDatabaseUrl } from "./support/config";
import { admin, createUser, type TestOrg } from "./support/db";
import { fakeProvider, price } from "./support/pricing";

/**
 * Generates docs/pricing-review.md from the REAL engine and the REAL Tiky Jumps tenant bundle, and
 * fails if the committed document is out of date. Regenerate with:
 *   WRITE_PRICING_REVIEW=1 pnpm test:integration tests/integration/pricing-review.test.ts
 *
 * Product prices below are ILLUSTRATIVE (Tiky Jumps' real prices come from their ERS import).
 * Road distances are simulated; production uses Google Maps.
 */
const DOC = "docs/pricing-review.md";
const EVENT: PostalAddress = {
  line1: "1930 S Germantown Rd",
  city: "Germantown",
  state: "TN",
  postalCode: "38138",
};
const client = new pg.Client({ connectionString: testDatabaseUrl() });

let org: TestOrg;
const products: Record<string, { variantId: string; productId: string }> = {};

async function product(
  key: string,
  name: string,
  categorySlug: string,
  priceCents: number,
  opts: { units?: number; pooled?: number } = {},
) {
  const cat = await admin<{ id: string }>(
    "select id from public.categories where organization_id = $1 and slug = $2",
    [org.id, categorySlug],
  );
  const p = await makeProduct(org, { ...opts, categoryId: cat.rows[0]!.id });
  await admin("update public.products set name = $2, base_price_cents = $3 where id = $1", [
    p.productId,
    name,
    priceCents,
  ]);
  await admin(
    "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
    [org.id, p.productId, cat.rows[0]!.id],
  );
  products[key] = p;
}

beforeAll(async () => {
  await client.connect();
  await admin("delete from public.organizations where slug = 'tiky-jumps-review'");
  const bundle = tenantBundleSchema.parse(
    JSON.parse(readFileSync("seeds/tenants/tiky-jumps/tenant.json", "utf8")),
  );
  // Same configuration, separate scratch organization (no domains, no owner invitation).
  const result = await applyTenantBundle(client, {
    ...bundle,
    organization: { ...bundle.organization, slug: "tiky-jumps-review" },
    domains: [],
    ownerEmail: null,
  });
  const office = await createUser("review-office");
  await admin(
    "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'office')",
    [result.organizationId, office.id],
  );
  org = {
    id: result.organizationId,
    slug: "tiky-jumps-review",
    users: { owner: office, admin: office, office, staff: office },
  };

  await product("slide", "Example Water Slide", "water-slides", 45000, { units: 2 });
  await product("bounce", "Example Bounce House", "bounce-houses", 17500, { units: 3 });
  await product("chairs", "Example Folding Chair", "tables-and-chairs", 250, { pooled: 200 });
});
afterAll(async () => {
  await client.end();
});

interface Scenario {
  title: string;
  note?: string;
  request: unknown;
  provider?: DistanceProvider | null;
  withTestTax?: boolean;
}

const item = (key: string, start: string, end: string, quantity = 1) => ({
  variantId: products[key]!.variantId,
  quantity,
  start,
  end,
});
const sat = (hhmm: string) => june(19, hhmm);

function scenarios(): Scenario[] {
  return [
    {
      title: "Water slide, 4 hours (the included window), 3.0 mi delivery",
      request: { items: [item("slide", sat("12:00"), sat("16:00"))], eventAddress: EVENT },
      provider: fakeProvider(3.0),
    },
    {
      title: "Delivery exactly 5.0 mi → $0",
      request: {
        items: [item("slide", sat("12:00"), sat("16:00"))],
        eventAddress: { ...EVENT, line1: "5.0 mile address" },
      },
      provider: fakeProvider(5.0),
    },
    {
      title: "Delivery 5.1 mi → 1 billable mile",
      request: {
        items: [item("slide", sat("12:00"), sat("16:00"))],
        eventAddress: { ...EVENT, line1: "5.1 mile address" },
      },
      provider: fakeProvider(5.1),
    },
    {
      title: "Delivery 8.2 mi → ceil(8.2 − 5) = 4 mi × $4 = $16",
      request: {
        items: [item("slide", sat("12:00"), sat("16:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Water slide, 5 hours (1 hour beyond the included 4)",
      note: "No extra-hour rate is configured for Tiky Jumps yet, so the engine refuses to guess.",
      request: {
        items: [item("slide", sat("12:00"), sat("17:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Water slide overnight (Sat 6 PM → Sun 10 AM)",
      note: "Overnight is not enabled and no overnight charge is configured, so the price needs review.",
      request: {
        items: [item("slide", sat("18:00"), june(20, "10:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Bounce house, Friday 5 PM → Sunday 12 PM (43 h = 2 billable days)",
      request: {
        items: [item("bounce", june(18, "17:00"), june(20, "12:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Bounce house, 3 days (Fri 10 AM → Mon 9 AM)",
      request: {
        items: [item("bounce", june(18, "10:00"), june(21, "09:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Quantities: 2 bounce houses + 100 chairs, 4 hours",
      request: {
        items: [
          item("bounce", sat("12:00"), sat("16:00"), 2),
          item("chairs", sat("12:00"), sat("16:00"), 100),
        ],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
    },
    {
      title: "Customer pickup (no delivery)",
      request: { items: [item("bounce", sat("12:00"), sat("16:00"))], eventAddress: null },
      provider: null,
    },
    {
      title: "Map service failure",
      note: "Delivery is never estimated: the whole price is marked for review.",
      request: {
        items: [item("slide", sat("12:00"), sat("16:00"))],
        eventAddress: { ...EVENT, line1: "Unreachable address" },
      },
      provider: {
        id: "simulated",
        version: "1",
        getRoadDistance: () => Promise.resolve({ ok: false, reason: "PROVIDER_ERROR" }),
      },
    },
    {
      title: "With an EXAMPLE test tax configuration (9.25 %, rentals taxable, delivery not)",
      note: "Illustrates taxable vs non-taxable components only. These are NOT Tennessee production rules; test configurations always require review.",
      request: {
        items: [item("slide", sat("12:00"), sat("16:00"))],
        eventAddress: { ...EVENT, line1: "8.2 mile address" },
      },
      provider: fakeProvider(8.2),
      withTestTax: true,
    },
  ];
}

function render(title: string, note: string | undefined, r: PriceResult): string {
  const money = (c: number) => formatCents(c, r.currency);
  const rows = r.lines.map(
    (l) =>
      `| ${l.label}${l.quantity > 1 && l.kind !== "discount" ? ` × ${l.quantity}` : ""} | ${l.taxable === null ? "?" : l.taxable ? "yes" : "no"} | ${money(l.amountCents)} |`,
  );
  const tax = r.taxLines.map(
    (t) =>
      `| ${t.name} (${t.rateBps / 100} % of ${money(t.taxableBaseCents)}) | | ${money(t.amountCents)} |`,
  );
  const summary = Object.fromEntries(Object.entries(r.summary));
  return [
    `### ${title}`,
    note ? `\n_${note}_\n` : "",
    "| Line | Taxable | Amount |",
    "|---|---|---:|",
    ...rows,
    `| **Subtotal** | | **${money(r.summary.subtotal)}** |`,
    ...tax,
    `| **Total** | | **${money(r.summary.total)}** |`,
    "",
    r.manualReviewRequired
      ? `**Manual review required** (the total above is provisional):\n${r.reviewReasons.map((x) => `- \`${x}\`: ${explainReviewReason(x)}`).join("\n")}`
      : "**Complete price**: no manual review needed.",
    "",
    "<details><summary>Structured output</summary>\n",
    "```json",
    JSON.stringify(
      {
        summary,
        appliedRules: r.appliedRules.map(({ type, name, revision }) => ({ type, name, revision })),
      },
      null,
      2,
    ),
    "```",
    "</details>",
    "",
  ].join("\n");
}

describe("pricing review document (Tiky Jumps configuration)", () => {
  it("matches the committed docs/pricing-review.md", async () => {
    const sections: string[] = [];
    const results: PriceResult[] = [];
    for (const s of scenarios()) {
      if (s.withTestTax) {
        const j = await admin<{ id: string }>(
          "insert into public.tax_jurisdictions (organization_id, name, state, postal_codes) values ($1, 'EXAMPLE test jurisdiction', 'TN', '{38138}') returning id",
          [org.id],
        );
        await admin(
          "insert into public.tax_rates (organization_id, jurisdiction_id, name, rate_bps) values ($1, $2, 'EXAMPLE test rate', 925)",
          [org.id, j.rows[0]!.id],
        );
        await admin(
          "insert into public.tax_component_rules (organization_id, jurisdiction_id, component, taxable) select $1, $2, c, c not in ('delivery') from unnest(array['rental','add_on','delivery','labor','fee','discount','adjustment']::public.tax_component[]) c",
          [org.id, j.rows[0]!.id],
        );
      }
      const { output } = await price(org.users.office, org, s.request, {
        provider: s.provider ?? null,
      });
      results.push(output);
      sections.push(render(s.title, s.note, output));
    }

    // Spot-check the numbers the product owner asked for.
    expect(results[0]!.summary).toMatchObject({ base: 45000, delivery: 0, extra_hours: 0 });
    expect(results[1]!.summary.delivery).toBe(0);
    expect(results[2]!.summary.delivery).toBe(400);
    expect(results[3]!.summary.delivery).toBe(1600);
    expect(results[4]!.reviewReasons).toContain("EXTRA_HOURS_PRICING_NOT_CONFIGURED:L1");
    expect(results[5]!.reviewReasons).toEqual(
      expect.arrayContaining(["OVERNIGHT_NOT_PERMITTED:L1", "OVERNIGHT_PRICING_NOT_CONFIGURED:L1"]),
    );
    expect(results[6]!.summary).toMatchObject({ base: 17500, additional_days: 4375 });
    expect(results[7]!.summary).toMatchObject({ additional_days: 8750 });
    expect(results[8]!.summary).toMatchObject({ quantity: 102, base: 35000 + 25000 });
    expect(results[9]!.summary.delivery).toBe(0);
    expect(results[10]!.reviewReasons).toContain("DELIVERY:PROVIDER_ERROR");
    expect(results[11]!.summary).toMatchObject({
      taxable_subtotal: 45000,
      tax: 4163,
      total: 45000 + 1600 + 4163,
    });
    for (const r of results.slice(0, 11))
      expect(r.reviewReasons).toContain("TAX_JURISDICTION_UNRESOLVED");

    const doc = [
      "# Pricing review: Tiky Jumps configuration",
      "",
      "> **Generated** by `tests/integration/pricing-review.test.ts` from the real pricing engine and the real",
      "> Tiky Jumps tenant bundle (`seeds/tenants/tiky-jumps/tenant.json`). Do not edit by hand. The test fails",
      "> if this file drifts from what the engine produces. Regenerate with",
      "> `WRITE_PRICING_REVIEW=1 pnpm test:integration tests/integration/pricing-review.test.ts`.",
      "",
      "**Product prices are illustrative** (Tiky Jumps' real prices will come from the ERS import).",
      "**Road distances are simulated**; production uses Google Maps (Routes API, one-way driving distance",
      "from 2560 Overton Crossing St, Memphis TN 38127). Events are on Saturday, June 19, 2027 (America/Chicago).",
      "",
      "Configuration in effect: water slides include 4 hours; +25 % of base per additional day; first 5 road",
      "miles free, then $4/mile rounded up; overnight **not enabled** and no overnight charge; no extra-hour,",
      "attendant or tax configuration. Wherever configuration is missing the engine returns",
      "`manual_review_required: true` with a reason. It never invents a price.",
      "",
      "Until Tiky Jumps' Tennessee tax rules are entered, **every** price below requires tax review",
      "(`TAX_JURISDICTION_UNRESOLVED`); the last scenario shows how taxable and non-taxable components",
      "behave, using an obviously fake test rate.",
      "",
      ...sections,
    ].join("\n");

    if (process.env.WRITE_PRICING_REVIEW === "1") writeFileSync(DOC, doc);
    expect(readFileSync(DOC, "utf8")).toBe(doc);
  });
});
