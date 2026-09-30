import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { quoteNextStep } from "@/domain/storefront/quote-step";
import { getPublicQuote, submitQuoteRequest } from "@/server/public/quotes";
import {
  listBookableVariants,
  listProductSlugs,
  loadProductBySlug,
  loadProductPage,
  loadShell,
} from "@/server/public/storefront";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct, outcome } from "./support/availability";
import { admin, adminGated, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * M6 storefront data (ADR 0016). View-level guarantees are checked as the `anon` role in SQL; the
 * loaders are checked through the real PostgREST API with the publishable key (describeRest).
 */
const anon = { kind: "anon" } as const;
/** Storefront loading only uses the host-resolved tenant's organization id. */
const tenantOf = (organizationId: string) => ({ organizationId }) as ResolvedTenant;
/** Rows as JSON, the way PostgREST serializes them (arrays, enums, jsonb). */
const read = (view: string) => (org: string) =>
  as(anon, async (sql) =>
    (
      await sql<{ r: Record<string, unknown> }>(
        `select to_jsonb(v) as r from public.${view} v where organization_id = $1`,
        [org],
      )
    ).rows.map((x) => x.r),
  );

let a: TestOrg;
let b: TestOrg;
const fx = {} as {
  aPublished: string;
  aHidden: string;
  aPublishedCategory: string;
  aHiddenCategory: string;
  bProduct: string;
  verifiedPath: string;
  unverifiedPath: string;
  hiddenProductPath: string;
};

async function product(org: TestOrg, slug: string, published: boolean) {
  const { productId } = await makeProduct(org, { published });
  await admin("update public.products set slug = $2, name = $3 where id = $1", [
    productId,
    slug,
    `Name ${slug}`,
  ]);
  return productId;
}
async function category(org: TestOrg, slug: string, published: boolean, productId: string) {
  const { rows } = await admin<{ id: string }>(
    "insert into public.categories (organization_id, name, slug, is_published) values ($1, $2, $2, $3) returning id",
    [org.id, slug, published],
  );
  const id = rows[0]!.id;
  await admin(
    "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
    [org.id, productId, id],
  );
  return id;
}
async function media(org: TestOrg, productId: string, rights: string) {
  const path = `${org.id}/${randomUUID()}.jpg`;
  await admin(
    `insert into public.product_media (organization_id, product_id, storage_path, source, rights_status, alt_text)
     values ($1, $2, $3, 'upload', $4, 'Photo')`,
    [org.id, productId, path, rights],
  );
  await admin("insert into storage.objects (bucket_id, name) values ('product-media', $1)", [path]);
  return path;
}

beforeAll(async () => {
  a = await createOrg("store-a");
  b = await createOrg("store-b");
  fx.aPublished = await product(a, "castle", true);
  fx.aHidden = await product(a, "draft-slide", false);
  fx.bProduct = await product(b, "castle", true); // same slug on another tenant
  fx.aPublishedCategory = await category(a, "bouncers", true, fx.aPublished);
  fx.aHiddenCategory = await category(a, "secret", false, fx.aPublished);
  await category(b, "b-only", true, fx.bProduct);
  fx.verifiedPath = await media(a, fx.aPublished, "owned");
  fx.unverifiedPath = await media(a, fx.aPublished, "unverified");
  fx.hiddenProductPath = await media(a, fx.aHidden, "owned");
  await media(b, fx.bProduct, "owned");

  await admin(
    `insert into public.organization_policies (organization_id, policy_type, title, body, is_published, is_placeholder)
     values ($1, 'safety', 'Safety', 'Approved text', true, false),
            ($1, 'weather', 'Weather', 'Placeholder text', false, true),
            ($1, 'cancellation', 'Cancellation', 'Draft text', false, false),
            ($2, 'delivery', 'B delivery', 'B text', true, false)`,
    [a.id, b.id],
  );
  await admin(
    `insert into public.service_areas (organization_id, name, is_active) values ($1, 'North', true), ($1, 'Retired', false), ($2, 'B town', true)`,
    [a.id, b.id],
  );
  await admin(
    `insert into public.organization_domains (organization_id, hostname, is_primary, verified_at)
     values ($1, $2, true, now()), ($1, $3, false, now()), ($1, $4, false, null), ($5, $6, true, null)`,
    [
      a.id,
      `${a.slug}.example.test`,
      `www.${a.slug}.example.test`,
      `unverified.${a.slug}.example.test`,
      b.id,
      `${b.slug}.example.test`,
    ],
  );
});

describe("storefront views (as anon)", () => {
  it("placeholder and unpublished policies are never shown", async () => {
    const rows = await read("public_storefront_policies")(a.id);
    expect(rows.map((r) => r.title)).toEqual(["Safety"]);
  });

  it("only rights-verified media of published products is listed", async () => {
    const rows = await read("public_catalog_product_media")(a.id);
    expect(rows.map((r) => r.storage_path)).toEqual([fx.verifiedPath]);
  });

  it("M1: only verified domains are listed (unverified primary or alias never)", async () => {
    const hosts = (await read("public_storefront_domains")(a.id)).map((r) => r.hostname).sort();
    expect(hosts).toEqual([`${a.slug}.example.test`, `www.${a.slug}.example.test`].sort());
    expect(await read("public_storefront_domains")(b.id)).toEqual([]);
  });

  it("M2: bookable variants carry the engine's starting price (override ?? base)", async () => {
    const { productId, variantId } = await makeProduct(a, {});
    await adminGated(
      a.id,
      "update public.product_variants set price_override_cents = 30000 where id = $1",
      [variantId],
    );
    const rows = await read("public_catalog_variants")(a.id);
    const row = rows.find((r) => r.id === variantId);
    expect(row).toMatchObject({ product_id: productId, effective_base_price_cents: 30000 });
    // …and the pricing engine's context agrees (the same coalesce).
    const ctx = await admin<{ price: string }>(
      "select coalesce(v.price_override_cents, p.base_price_cents)::text as price from public.product_variants v join public.products p on p.id = v.product_id where v.id = $1",
      [variantId],
    );
    expect(ctx.rows[0]?.price).toBe("30000");
  });

  it("category summaries count published products; unpublished categories have none", async () => {
    const rows = await read("public_catalog_category_summaries")(a.id);
    expect(rows).toEqual([
      expect.objectContaining({ category_id: fx.aPublishedCategory, product_count: 1 }),
    ]);
  });

  it("the settings and area views expose no internal or pricing fields", async () => {
    const [row] = await read("public_storefront_settings")(a.id);
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "address_line1",
        "city",
        "free_delivery_miles",
        "maximum_delivery_miles",
        "organization_id",
        "postal_code",
        "primary_hostname",
        "state",
      ].sort(),
    );
    const [area] = await read("public_service_areas")(a.id);
    expect(Object.keys(area ?? {}).sort()).toEqual(["id", "name", "organization_id", "priority"]);
  });
});

describeRest("storefront loaders through PostgREST", () => {
  it("tenant A never sees tenant B's catalog, policies, areas or domains", async () => {
    const shell = await loadShell(tenantOf(a.id));
    const page = await loadProductPage(tenantOf(a.id), { page: 1 });
    expect(page.products.map((p) => p.id)).not.toContain(fx.bProduct);
    expect(page.products.some((p) => p.id === fx.aPublished)).toBe(true);
    expect(shell.categories.map((c) => c.slug)).toEqual(["bouncers"]);
    expect(shell.profile.policies.map((p) => p.title)).toEqual(["Safety"]);
    expect(shell.profile.serviceAreas).toEqual(["North"]);
    const json = JSON.stringify([shell, page]);
    expect(json).not.toContain(b.id);
    expect(json).not.toContain(fx.bProduct);
    expect(json).not.toContain("B town");
  });

  it("the same slug resolves to each tenant's own product only (direct lookup)", async () => {
    expect((await loadProductBySlug(tenantOf(b.id), "castle"))?.id).toBe(fx.bProduct);
    expect((await loadProductBySlug(tenantOf(a.id), "castle"))?.id).toBe(fx.aPublished);
    expect(await loadProductBySlug(tenantOf(a.id), "b-only-nothing")).toBeNull();
  });

  it("unpublished products and categories are hidden (also from product links)", async () => {
    expect(await loadProductBySlug(tenantOf(a.id), "draft-slide")).toBeNull();
    const shell = await loadShell(tenantOf(a.id));
    expect(shell.categories.some((c) => c.slug === "secret")).toBe(false);
    const castle = await loadProductBySlug(tenantOf(a.id), "castle");
    expect(castle?.categoryIds).toEqual([fx.aPublishedCategory]);
    expect(castle?.images).toHaveLength(1);
    expect(await listProductSlugs(tenantOf(a.id))).not.toContain("draft-slide");
  });

  it("M1: the shell carries verified domains only", async () => {
    const shell = await loadShell(tenantOf(a.id));
    expect(shell.profile.domains.map((d) => d.hostname).sort()).toEqual(
      [`${a.slug}.example.test`, `www.${a.slug}.example.test`].sort(),
    );
    expect((await loadShell(tenantOf(b.id))).profile.domains).toEqual([]);
  });

  it("a suspended tenant has no storefront data", async () => {
    const c = await createOrg("store-c");
    await product(c, "castle", true);
    await admin("update public.organizations set status = 'suspended' where id = $1", [c.id]);
    expect((await loadProductPage(tenantOf(c.id), { page: 1 })).total).toBe(0);
    expect(await listBookableVariants(tenantOf(c.id))).toEqual([]);
  });
});

describe("product media storage policy", () => {
  const visible = (path: string) =>
    as(
      anon,
      async (sql) =>
        (
          await sql(
            "select 1 from storage.objects where bucket_id = 'product-media' and name = $1",
            [path],
          )
        ).rowCount,
    );

  it("anon can read exactly the published, rights-verified objects", async () => {
    expect(await visible(fx.verifiedPath)).toBe(1);
    expect(await visible(fx.unverifiedPath)).toBe(0);
    expect(await visible(fx.hiddenProductPath)).toBe(0);
  });

  it("anon still cannot write to the bucket", async () => {
    expect(
      await outcome(
        as(anon, (sql) =>
          sql("insert into storage.objects (bucket_id, name) values ('product-media', $1)", [
            `${a.id}/evil.jpg`,
          ]),
        ),
      ),
    ).not.toBe("ok");
  });
});

describe("stale quote view", () => {
  const tenant = () =>
    ({
      organizationId: a.id,
      slug: a.slug,
      name: a.slug,
      timezone: "America/Chicago",
    }) as unknown as ResolvedTenant;
  const deps = () => ({
    gateway: pgGateway(),
    provider: fakeProvider(3),
    rateLimit: () => Promise.resolve(),
  });

  it("an event changed after pricing marks the quote stale and blocks the booking request", async () => {
    await admin(
      `update public.organization_settings set primary_depot_address_line1 = '1 Depot Rd', primary_depot_city = 'Memphis',
         primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
       where organization_id = $1`,
      [a.id],
    );
    const { variantId } = await makeProduct(a, { units: 1 });
    const { token } = await submitQuoteRequest(
      tenant(),
      {
        contact: { email: `stale-${randomUUID().slice(0, 8)}@example.test` },
        event: {
          date: "2027-11-02",
          startTime: "12:00",
          endTime: "16:00",
          address: { line1: "10 Main St", city: "Memphis", state: "TN", postalCode: "38127" },
        },
        items: [{ variantId, quantity: 2 }],
      },
      { ip: "198.51.100.20" },
      deps(),
    );
    const fresh = await getPublicQuote(tenant(), token, deps());
    expect(fresh?.stale).toBe(false);
    expect(fresh?.items).toMatchObject([{ variantId, quantity: 2 }]);

    const { rows } = await admin<{
      event_id: string;
      manual_review_required: boolean;
      id: string;
    }>("select id, event_id, manual_review_required from public.quotes where token_hash = $1", [
      await hashQuoteToken(token),
    ]);
    const q = rows[0]!;
    if (q.manual_review_required) {
      await as(
        a.users.office,
        (sql) =>
          sql(
            "update public.quotes set review_approved_at = now(), review_note = 'ok' where id = $1",
            [q.id],
          ),
        { commit: true },
      );
    }
    expect((await getPublicQuote(tenant(), token, deps()))?.canRequestBooking).toBe(true);

    await as(
      a.users.office,
      (sql) => sql("update public.events set end_time = '18:00' where id = $1", [q.event_id]),
      { commit: true },
    );
    const stale = await getPublicQuote(tenant(), token, deps());
    expect(stale).toMatchObject({ stale: true, canRequestBooking: false });
    expect(quoteNextStep(stale!).kind).toBe("stale");
  });
});
