import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { quoteNextStep } from "@/domain/storefront/quote-step";
import { getPublicQuote, submitQuoteRequest } from "@/server/public/quotes";
import { loadStorefront, type StorefrontSource } from "@/server/public/storefront";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { makeProduct, outcome } from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";

/**
 * M6 storefront data (ADR 0016): what an anonymous visitor's storefront can see, read exactly as
 * the app does — the anon-safe views filtered by the host-resolved tenant — through a pg-backed
 * StorefrontSource running as the `anon` role.
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

/** The same queries the Supabase source issues, run as `anon` against the real views. */
const anonSource = (): StorefrontSource => ({
  settings: async (org) => {
    const [row] = await read("public_storefront_settings")(org);
    return (row ?? null) as never;
  },
  policies: read("public_storefront_policies") as never,
  serviceAreas: read("public_service_areas") as never,
  categories: read("public_catalog_categories") as never,
  products: read("public_catalog_products") as never,
  media: read("public_catalog_product_media") as never,
  variants: read("public_catalog_variants") as never,
});
/** A deliberately broken source that ignores the tenant filter (defence-in-depth check). */
const unfilteredSource = (): StorefrontSource => {
  const all = (view: string) => () =>
    as(anon, async (sql) =>
      (await sql<{ r: never }>(`select to_jsonb(v) as r from public.${view} v`)).rows.map(
        (x) => x.r,
      ),
    );
  return {
    settings: () => Promise.resolve(null),
    policies: all("public_storefront_policies"),
    serviceAreas: all("public_service_areas"),
    categories: all("public_catalog_categories"),
    products: all("public_catalog_products"),
    media: all("public_catalog_product_media"),
    variants: all("public_catalog_variants"),
  };
};

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
     values ($1, $2, true, now()), ($3, $4, true, null)`,
    [a.id, `${a.slug}.example.test`, b.id, `${b.slug}.example.test`],
  );
});

describe("storefront tenant isolation", () => {
  it("tenant A's storefront never contains tenant B's catalog, policies or areas", async () => {
    const store = await loadStorefront(tenantOf(a.id), anonSource());
    expect(store.products.map((p) => p.id)).toEqual([fx.aPublished]);
    expect(store.categories.map((c) => c.slug)).toEqual(["bouncers"]);
    expect(store.profile.policies.map((p) => p.title)).toEqual(["Safety"]);
    expect(store.profile.serviceAreas).toEqual(["North"]);
    const json = JSON.stringify(store);
    expect(json).not.toContain(b.id);
    expect(json).not.toContain(fx.bProduct);
    expect(json).not.toContain("B town");
  });

  it("the same slug resolves to each tenant's own product only", async () => {
    const storeB = await loadStorefront(tenantOf(b.id), anonSource());
    expect(storeB.products.find((p) => p.slug === "castle")?.id).toBe(fx.bProduct);
    const storeA = await loadStorefront(tenantOf(a.id), anonSource());
    expect(storeA.products.find((p) => p.slug === "castle")?.id).toBe(fx.aPublished);
  });

  it("even a source that forgot the tenant filter cannot leak another tenant's rows", async () => {
    const store = await loadStorefront(tenantOf(a.id), unfilteredSource());
    expect(store.products.every((p) => p.row.organization_id === a.id)).toBe(true);
    expect(store.categories.map((c) => c.slug)).toEqual(["bouncers"]);
    expect(store.profile.policies.map((p) => p.title)).toEqual(["Safety"]);
  });

  it("a suspended tenant has no storefront data", async () => {
    const c = await createOrg("store-c");
    await product(c, "castle", true);
    await admin("update public.organizations set status = 'suspended' where id = $1", [c.id]);
    const store = await loadStorefront(tenantOf(c.id), anonSource());
    expect(store.products).toEqual([]);
    expect(store.profile.primaryHostname).toBeNull();
  });
});

describe("published-only storefront data", () => {
  it("unpublished products and categories are hidden (including from product links)", async () => {
    const store = await loadStorefront(tenantOf(a.id), anonSource());
    expect(store.products.some((p) => p.slug === "draft-slide")).toBe(false);
    expect(store.categories.some((c) => c.slug === "secret")).toBe(false);
    expect(store.products[0]?.categoryIds).toEqual([fx.aPublishedCategory]);
    expect(JSON.stringify(store)).not.toContain(fx.aHiddenCategory);
  });

  it("placeholder and unpublished policies are never shown", async () => {
    const rows = await read("public_storefront_policies")(a.id);
    expect(rows.map((r) => r.title)).toEqual(["Safety"]);
  });

  it("only rights-verified media of published products is listed", async () => {
    const store = await loadStorefront(tenantOf(a.id), anonSource());
    expect(store.products[0]?.images).toHaveLength(1);
    const rows = await read("public_catalog_product_media")(a.id);
    expect(rows.map((r) => r.storage_path)).toEqual([fx.verifiedPath]);
  });

  it("the primary hostname is exposed only once verified", async () => {
    expect((await loadStorefront(tenantOf(a.id), anonSource())).profile.primaryHostname).toBe(
      `${a.slug}.example.test`,
    );
    expect((await loadStorefront(tenantOf(b.id), anonSource())).profile.primaryHostname).toBeNull();
  });

  it("the settings view exposes no internal or pricing fields", async () => {
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

    const { rows } = await admin<{ event_id: string; manual_review_required: boolean; id: string }>(
      "select id, event_id, manual_review_required from public.quotes where token_hash = $1",
      [await hashQuoteToken(token)],
    );
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
