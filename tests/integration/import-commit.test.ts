import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, createOrg, expectDenied, type TestOrg } from "./support/db";

let a: TestOrg;
let b: TestOrg;

interface Row {
  action: "create" | "update" | "skip";
  mapped?: Record<string, unknown>;
  errors?: unknown[];
}

async function batch(org: TestOrg, rows: Row[], status = "validated") {
  const { rows: created } = await admin<{ id: string }>(
    `insert into public.import_batches (organization_id, adapter_id, external_source, headers, row_count, status)
     values ($1, 'generic_csv', 'ers', '{Name}', $2, $3) returning id`,
    [org.id, rows.length, status],
  );
  const id = created[0]!.id;
  for (const [i, r] of rows.entries()) {
    await admin(
      `insert into public.import_rows (organization_id, batch_id, row_number, raw, mapped, action, errors)
       values ($1, $2, $3, '{}', $4, $5, $6)`,
      [
        org.id,
        id,
        i + 1,
        r.mapped ? JSON.stringify(r.mapped) : null,
        r.action,
        JSON.stringify(r.errors ?? []),
      ],
    );
  }
  return id;
}

const commitAs = (org: TestOrg, role: keyof TestOrg["users"], batchId: string) =>
  as(
    org.users[role],
    async (sql) =>
      (await sql<{ s: unknown }>("select public.commit_product_import($1) as s", [batchId]))
        .rows[0]!.s,
    {
      commit: true,
    },
  );

const castle = {
  external_ref: "ERS-100",
  name: "Castle Combo",
  slug: "castle-combo",
  base_price_cents: 25000,
  wet_allowed: true,
  dry_allowed: true,
  minimum_age: 3,
  maximum_age: 12,
  ideal_event_types: ["birthday", "school"],
  tags: ["combo", "slide"],
  categories: [{ slug: "combos", name: "Combos" }],
  quantity: 2,
};

beforeAll(async () => {
  a = await createOrg("imp-a");
  b = await createOrg("imp-b");
});

describe("commit_product_import", () => {
  it("creates products, categories, default variant units and links, in one transaction", async () => {
    const id = await batch(a, [{ action: "create", mapped: castle }, { action: "skip" }]);
    expect(await commitAs(a, "office", id)).toEqual({ created: 1, updated: 0, skipped: 1 });

    const { rows } = await admin<{
      id: string;
      external_source: string;
      category: string;
      units: number;
    }>(
      `select p.id, p.external_source, c.slug as category,
              (select count(*)::int from public.inventory_units u join public.product_variants v on v.id = u.variant_id where v.product_id = p.id) as units
       from public.products p join public.categories c on c.id = p.primary_category_id
       where p.organization_id = $1 and p.external_ref = 'ERS-100'`,
      [a.id],
    );
    expect(rows).toEqual([
      { id: expect.any(String) as string, external_source: "ers", category: "combos", units: 2 },
    ]);
    const batchRow = await admin("select status from public.import_batches where id = $1", [id]);
    expect(batchRow.rows).toEqual([{ status: "committed" }]);
  });

  it("re-importing the same source ref updates instead of duplicating, and never clears values", async () => {
    const id = await batch(a, [
      {
        action: "update",
        mapped: {
          external_ref: "ERS-100",
          name: "Castle Combo XL",
          base_price_cents: 27500,
          quantity: 3,
        },
      },
    ]);
    expect(await commitAs(a, "office", id)).toEqual({ created: 0, updated: 1, skipped: 0 });
    const { rows } = await admin(
      `select name, base_price_cents::int as price, minimum_age, tags,
              (select count(*)::int from public.inventory_units u join public.product_variants v on v.id = u.variant_id where v.product_id = p.id) as units
       from public.products p where organization_id = $1 and external_ref = 'ERS-100'`,
      [a.id],
    );
    expect(rows).toEqual([
      { name: "Castle Combo XL", price: 27500, minimum_age: 3, tags: ["combo", "slide"], units: 3 },
    ]);
  });

  it("supports pooled inventory for new products", async () => {
    const id = await batch(a, [
      {
        action: "create",
        mapped: {
          external_ref: "ERS-200",
          name: "Folding Chair",
          slug: "folding-chair",
          base_price_cents: 300,
          tracking_mode: "pooled",
          quantity: 150,
        },
      },
    ]);
    await commitAs(a, "office", id);
    const { rows } = await admin(
      "select v.tracking_mode, v.pooled_quantity from public.product_variants v join public.products p on p.id = v.product_id where p.external_ref = 'ERS-200' and p.organization_id = $1",
      [a.id],
    );
    expect(rows).toEqual([{ tracking_mode: "pooled", pooled_quantity: 150 }]);
  });

  it("the same source ref in another organization is a separate product", async () => {
    const id = await batch(b, [{ action: "create", mapped: castle }]);
    expect(await commitAs(b, "owner", id)).toEqual({ created: 1, updated: 0, skipped: 0 });
    const { rows } = await admin(
      "select count(*)::int n from public.products where external_ref = 'ERS-100'",
    );
    expect(rows).toEqual([{ n: 2 }]);
  });

  it("cannot commit another organization's batch (invisible through RLS)", async () => {
    const id = await batch(b, [
      { action: "create", mapped: { ...castle, external_ref: "ERS-300", slug: "x-300" } },
    ]);
    await expectDenied(commitAs(a, "owner", id), ["P0002"]);
  });

  it("requires catalog.write", async () => {
    const id = await batch(a, [
      { action: "create", mapped: { ...castle, external_ref: "ERS-400", slug: "x-400" } },
    ]);
    await expectDenied(commitAs(a, "staff", id), ["P0002"]);
  });

  it("requires a validated batch and refuses to re-commit", async () => {
    const parsed = await batch(
      a,
      [{ action: "create", mapped: { ...castle, external_ref: "ERS-500", slug: "x-500" } }],
      "parsed",
    );
    await expectDenied(commitAs(a, "owner", parsed), ["23514"]);
    const done = await batch(a, [{ action: "skip" }]);
    await commitAs(a, "owner", done);
    await expectDenied(commitAs(a, "owner", done), ["23514"]);
  });

  it("rows with validation errors can never be marked for writing", async () => {
    await expectDenied(
      batch(a, [
        { action: "create", mapped: castle, errors: [{ field: "name", message: "required" }] },
      ]),
      ["23514"],
    );
  });

  it("rolls back everything when any row violates a constraint", async () => {
    const id = await batch(a, [
      {
        action: "create",
        mapped: { external_ref: "ERS-600", name: "Good", slug: "good-600", base_price_cents: 100 },
      },
      {
        action: "create",
        mapped: {
          external_ref: "ERS-601",
          name: "Bad",
          slug: "bad-601",
          base_price_cents: 100,
          minimum_age: 9,
          maximum_age: 2,
        },
      },
    ]);
    await expectDenied(commitAs(a, "owner", id), ["23514"]);
    const { rows } = await admin(
      "select count(*)::int n from public.products where external_ref in ('ERS-600','ERS-601')",
    );
    expect(rows).toEqual([{ n: 0 }]);
    const status = await admin("select status from public.import_batches where id = $1", [id]);
    expect(status.rows).toEqual([{ status: "validated" }]);
  });

  it("committed batches are immutable", async () => {
    const id = await batch(a, [{ action: "skip" }]);
    await commitAs(a, "owner", id);
    await expectDenied(
      admin("update public.import_batches set status = 'validated' where id = $1", [id]),
      ["23514"],
    );
  });
});
