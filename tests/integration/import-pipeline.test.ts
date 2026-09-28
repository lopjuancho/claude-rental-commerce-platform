import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { detectAdapter, suggestMapping } from "@/domain/import/adapters";
import { parseCsv } from "@/domain/import/csv";
import { planImport } from "@/domain/import/plan";
import { validateRow } from "@/domain/import/validate";
import { admin, as, createOrg, type TestOrg } from "./support/db";

let org: TestOrg;
beforeAll(async () => {
  org = await createOrg("pipe");
});

/** Runs parse → adapter mapping → validate → plan → stage → commit, like the import service. */
async function importFixture(): Promise<unknown> {
  const { headers, rows } = parseCsv(
    readFileSync("tests/fixtures/imports/generic-spreadsheet.csv", "utf8"),
  );
  const adapter = detectAdapter(headers);
  const mapping = suggestMapping(adapter, headers);
  const validated = rows.map((r, i) => validateRow(headers, r, mapping, i + 2));

  const existing = await admin<{ slug: string; external_ref: string | null }>(
    "select slug, external_ref from public.products where organization_id = $1",
    [org.id],
  );
  const plan = planImport(validated, {
    slugs: new Map(existing.rows.map((r) => [r.slug, r.external_ref])),
    externalRefs: new Set(existing.rows.flatMap((r) => (r.external_ref ? [r.external_ref] : []))),
  });

  const batch = await admin<{ id: string }>(
    `insert into public.import_batches (organization_id, adapter_id, external_source, headers, row_count, mapping, status)
     values ($1, $2, $3, $4, $5, $6, 'validated') returning id`,
    [org.id, adapter.id, adapter.externalSource, headers, rows.length, JSON.stringify(mapping)],
  );
  const batchId = batch.rows[0]!.id;
  for (const r of plan.rows) {
    await admin(
      `insert into public.import_rows (organization_id, batch_id, row_number, raw, mapped, action, errors, warnings)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        org.id,
        batchId,
        r.rowNumber,
        JSON.stringify(Object.fromEntries(headers.map((h, i) => [h, rows[r.rowNumber - 2]![i]]))),
        r.mapped ? JSON.stringify(r.mapped) : null,
        r.action,
        JSON.stringify(r.errors),
        JSON.stringify(r.warnings),
      ],
    );
  }
  return as(
    org.users.office,
    async (sql) =>
      (await sql<{ s: unknown }>("select public.commit_product_import($1) as s", [batchId]))
        .rows[0]!.s,
    {
      commit: true,
    },
  );
}

describe("CSV → canonical model → catalog (end to end)", () => {
  it("imports the fixture into typed catalog rows", async () => {
    expect(await importFixture()).toEqual({ created: 3, updated: 0, skipped: 0 });

    const { rows } = await admin(
      `select p.name, p.slug, p.base_price_cents::int as price, p.wet_allowed, p.ideal_event_types::text[] as ideal_event_types, p.tags,
              p.space_length_ft::float as len, p.space_height_ft::float as h, p.internal_notes,
              (select array_agg(c.slug order by c.slug) from public.product_categories pc join public.categories c on c.id = pc.category_id where pc.product_id = p.id) as cats,
              (select count(*)::int from public.inventory_units u join public.product_variants v on v.id = u.variant_id where v.product_id = p.id) as units
       from public.products p where p.organization_id = $1 order by p.name`,
      [org.id],
    );
    expect(rows).toEqual([
      {
        name: "Folding Chair",
        slug: "folding-chair",
        price: 250,
        wet_allowed: false,
        ideal_event_types: [],
        tags: [],
        len: null,
        h: null,
        internal_notes: null,
        cats: ["tables-and-chairs"],
        units: 150,
      },
      {
        name: "Rainbow Castle",
        slug: "rainbow-castle",
        price: 17500,
        wet_allowed: false,
        ideal_event_types: ["birthday", "school"],
        tags: ["castle", "toddler"],
        len: 15,
        h: 14,
        internal_notes: "repaired seam 2025",
        cats: ["bounce-houses"],
        units: 2,
      },
      {
        name: "Tropical Crush Combo, 2-lane",
        slug: "tropical-crush-combo-2-lane",
        price: 45000,
        wet_allowed: true,
        ideal_event_types: ["birthday"],
        tags: [],
        len: 32,
        h: 18,
        internal_notes: null,
        cats: ["combos", "water-slides"],
        units: 1,
      },
    ]);
  });

  it("re-importing the same file updates in place (idempotent)", async () => {
    expect(await importFixture()).toEqual({ created: 0, updated: 3, skipped: 0 });
    const { rows } = await admin(
      "select count(*)::int n from public.products where organization_id = $1",
      [org.id],
    );
    expect(rows).toEqual([{ n: 3 }]);
    const units = await admin(
      "select count(*)::int n from public.inventory_units u join public.product_variants v on v.id = u.variant_id join public.products p on p.id = v.product_id where p.slug = 'rainbow-castle' and p.organization_id = $1",
      [org.id],
    );
    expect(units.rows).toEqual([{ n: 2 }]);
  });
});
