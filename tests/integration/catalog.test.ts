import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";

let a: TestOrg;
let b: TestOrg;

async function product(org: TestOrg, fields: Record<string, unknown> = {}) {
  const cols = {
    name: "P",
    slug: `p-${randomUUID().slice(0, 8)}`,
    base_price_cents: 10000,
    ...fields,
  };
  const keys = Object.keys(cols);
  const { rows } = await admin<{ id: string }>(
    `insert into public.products (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [org.id, ...Object.values(cols)],
  );
  return rows[0]!.id;
}

async function category(org: TestOrg, fields: Record<string, unknown> = {}) {
  const cols = { name: "C", slug: `c-${randomUUID().slice(0, 8)}`, ...fields };
  const keys = Object.keys(cols);
  const { rows } = await admin<{ id: string }>(
    `insert into public.categories (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`,
    [org.id, ...Object.values(cols)],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  a = await createOrg("cat-a");
  b = await createOrg("cat-b");
});

describe("catalog integrity", () => {
  it("creates exactly one default serialized variant per product", async () => {
    const id = await product(a);
    const { rows } = await admin(
      "select is_default, tracking_mode, pooled_quantity from public.product_variants where product_id = $1",
      [id],
    );
    expect(rows).toEqual([
      { is_default: true, tracking_mode: "serialized", pooled_quantity: null },
    ]);
  });

  it("allows the same slug in different organizations but not twice in one", async () => {
    await product(a, { slug: "shared-slug" });
    await product(b, { slug: "shared-slug" });
    await expectDenied(product(a, { slug: "shared-slug" }), ["23505"]);
  });

  it.each([
    [{ minimum_age: 10, maximum_age: 5 }],
    [{ wet_allowed: false, dry_allowed: false }],
    [{ indoor_allowed: false, outdoor_allowed: false }],
    [{ allowed_surfaces: ["lava"] }],
    [{ base_price_cents: -1 }],
    [{ slug: "Bad Slug" }],
    [{ external_ref: "123" }], // external_ref without external_source
  ])("rejects invalid product data %j", async (fields) => {
    await expectDenied(product(a, fields), ["23514"]);
  });

  it("rejects cross-tenant references (composite foreign keys)", async () => {
    const pa = await product(a);
    const cb = await category(b);
    await expectDenied(
      admin(
        "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
        [a.id, pa, cb],
      ),
      ["23503"],
    );
    await expectDenied(
      admin("update public.products set primary_category_id = $2 where id = $1", [pa, cb]),
      ["23503"],
    );
  });

  it("keeps media inside the owning organization's storage prefix", async () => {
    const pa = await product(a);
    await expectDenied(
      admin(
        "insert into public.product_media (organization_id, product_id, storage_path, source) values ($1, $2, $3, 'upload')",
        [a.id, pa, `${b.id}/products/x.jpg`],
      ),
      ["23514"],
    );
    await expectDenied(
      admin(
        "insert into public.product_media (organization_id, product_id, storage_path, source) values ($1, $2, $3, 'upload')",
        [a.id, pa, `${a.id}/../${b.id}/x.jpg`],
      ),
      ["23514"],
    );
  });

  it("rejects category cycles", async () => {
    const parent = await category(a);
    const child = await category(a, { parent_id: parent });
    await expectDenied(
      admin("update public.categories set parent_id = $2 where id = $1", [parent, child]),
      ["23514"],
    );
  });

  it("only allows inventory units on serialized variants", async () => {
    const id = await product(a);
    await admin(
      "update public.product_variants set tracking_mode = 'pooled', pooled_quantity = 100 where product_id = $1",
      [id],
    );
    await expectDenied(
      admin(
        "insert into public.inventory_units (organization_id, variant_id, label) select organization_id, id, 'U1' from public.product_variants where product_id = $1",
        [id],
      ),
      ["23514"],
    );
    await expectDenied(
      admin("update public.product_variants set pooled_quantity = null where product_id = $1", [
        id,
      ]),
      ["23514"],
    );
  });
});

describe("catalog permissions", () => {
  it.each([
    ["office", 1],
    ["admin", 1],
    ["staff", 0],
  ] as const)("%s updating a product affects %i row(s)", async (role, expected) => {
    const id = await product(a);
    const n = await as(
      a.users[role],
      async (sql) =>
        (await sql("update public.products set name = 'X' where id = $1", [id])).rowCount,
    );
    expect(n).toBe(expected);
  });

  it("staff cannot create products", async () => {
    await expectDenied(
      as(a.users.staff, (sql) =>
        sql(
          "insert into public.products (organization_id, name, slug, base_price_cents) values ($1, 'X', 'x-staff', 1)",
          [a.id],
        ),
      ),
    );
  });

  it("the generated search vector cannot be written", async () => {
    const id = await product(a);
    await expectDenied(
      as(a.users.owner, (sql) =>
        sql("update public.products set search_vector = to_tsvector('x') where id = $1", [id]),
      ),
      ["42501", "428C9"],
    );
  });

  it("stamps the media uploader from the session, not from input", async () => {
    const id = await product(a);
    const row = await as(
      a.users.office,
      async (sql) =>
        (
          await sql<{ uploaded_by: string }>(
            "insert into public.product_media (organization_id, product_id, storage_path, source, uploaded_by) values ($1, $2, $3, 'upload', $4) returning uploaded_by",
            [a.id, id, `${a.id}/products/${id}/x.jpg`, a.users.owner.id],
          )
        ).rows[0],
    );
    expect(row).toEqual({ uploaded_by: a.users.office.id });
  });
});

describe("public catalog views (anonymous storefront)", () => {
  let published: string;
  let unpublished: string;
  let archived: string;
  let windCategory: string;
  let trainCategory: string;
  let train: string;

  beforeAll(async () => {
    windCategory = await category(a);
    trainCategory = await category(a);
    await admin(
      `insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit)
       values ($1, $2, 'wind', true, 15, 'mph'), ($1, $2, 'lightning', true, null, null), ($1, $3, 'wind', false, null, null)`,
      [a.id, windCategory, trainCategory],
    );
    train = await product(a, { is_published: true, primary_category_id: trainCategory });
    published = await product(a, {
      is_published: true,
      primary_category_id: windCategory,
      internal_notes: "cost $90",
    });
    unpublished = await product(a, { is_published: false });
    archived = await product(a, { is_published: true, archived_at: new Date().toISOString() });
    for (const [rights, suffix] of [
      ["owned", "ok.jpg"],
      ["unverified", "scraped.jpg"],
    ] as const) {
      await admin(
        "insert into public.product_media (organization_id, product_id, storage_path, source, rights_status) values ($1, $2, $3, 'upload', $4)",
        [a.id, published, `${a.id}/products/${published}/${suffix}`, rights],
      );
    }
  });

  const anon = <T>(fn: Parameters<typeof as<T>>[1]) => as({ kind: "anon" }, fn);

  it("shows only published, non-archived products", async () => {
    const ids = await anon(async (sql) =>
      (
        await sql<{ id: string }>(
          "select id from public.public_catalog_products where organization_id = $1",
          [a.id],
        )
      ).rows.map((r) => r.id),
    );
    expect(ids).toContain(published);
    expect(ids).not.toContain(unpublished);
    expect(ids).not.toContain(archived);
  });

  it("never exposes internal fields", async () => {
    const { rows } = await admin<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'public_catalog_products'",
    );
    const cols = rows.map((r) => r.column_name);
    for (const forbidden of [
      "internal_notes",
      "external_ref",
      "external_source",
      "archived_at",
      "is_published",
    ]) {
      expect(cols).not.toContain(forbidden);
    }
  });

  it("exposes resolved weather sensitivities per hazard (ADR 0010)", async () => {
    const rows = await anon(
      async (sql) =>
        (
          await sql<{ id: string; weather_sensitivities: unknown }>(
            "select id, weather_sensitivities from public.public_catalog_products where id = any($1)",
            [[published, train]],
          )
        ).rows,
    );
    const byId = new Map(rows.map((r) => [r.id, r.weather_sensitivities]));
    expect(byId.get(published)).toEqual([
      { hazard: "wind", threshold_value: 15, threshold_unit: "mph" },
      { hazard: "lightning", threshold_value: null, threshold_unit: null },
    ]);
    expect(byId.get(train)).toEqual([]);
  });

  it("hides media whose usage rights are unverified", async () => {
    const paths = await anon(async (sql) =>
      (
        await sql<{ storage_path: string }>(
          "select storage_path from public.public_catalog_product_media where product_id = $1",
          [published],
        )
      ).rows.map((r) => r.storage_path),
    );
    expect(paths).toEqual([`${a.id}/products/${published}/ok.jpg`]);
  });

  it("hides everything from organizations that are not active", async () => {
    const suspended = await createOrg("cat-suspended", "suspended");
    const hidden = await product(suspended, { is_published: true });
    const n = await anon(
      async (sql) =>
        (
          await sql("select count(*)::int n from public.public_catalog_products where id = $1", [
            hidden,
          ])
        ).rows[0],
    );
    expect(n).toEqual({ n: 0 });
  });
});

describe("storage policies (product-media bucket)", () => {
  const upload = (org: TestOrg, role: keyof TestOrg["users"], path: string) =>
    as(org.users[role], (sql) =>
      sql("insert into storage.objects (bucket_id, name) values ('product-media', $1)", [path]),
    );

  it("lets catalog writers upload under their own organization prefix", async () => {
    await expect(upload(a, "office", `${a.id}/products/p/1.jpg`)).resolves.toMatchObject({
      rowCount: 1,
    });
  });

  it("rejects uploads into another organization's prefix, malformed prefixes, and by staff", async () => {
    await expectDenied(upload(a, "owner", `${b.id}/products/p/1.jpg`));
    await expectDenied(upload(a, "owner", `not-a-uuid/products/p/1.jpg`));
    await expectDenied(upload(a, "staff", `${a.id}/products/p/1.jpg`));
  });

  it("does not let other organizations read objects", async () => {
    await admin("insert into storage.objects (bucket_id, name) values ('product-media', $1)", [
      `${a.id}/products/p/secret.jpg`,
    ]);
    const n = await as(
      b.users.owner,
      async (sql) =>
        (await sql("select count(*)::int n from storage.objects where name like $1", [`${a.id}/%`]))
          .rows[0],
    );
    expect(n).toEqual({ n: 0 });
  });
});
