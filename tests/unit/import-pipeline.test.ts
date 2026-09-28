import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectAdapter, getAdapter, suggestMapping } from "@/domain/import/adapters";
import { parseCsv } from "@/domain/import/csv";
import type { FieldMapping } from "@/domain/import/fields";
import { planImport } from "@/domain/import/plan";
import { missingRequiredFields, validateRow } from "@/domain/import/validate";

const fixture = parseCsv(readFileSync("tests/fixtures/imports/generic-spreadsheet.csv", "utf8"));

describe("adapters", () => {
  it("suggests a mapping onto canonical fields from plain headers", () => {
    const mapping = suggestMapping(detectAdapter(fixture.headers), fixture.headers);
    expect(mapping).toMatchObject({
      external_ref: "SKU",
      name: "Product Name",
      base_price: "Price",
      category: "Category",
      quantity: "Qty",
      wet_allowed: "Wet",
      dimensions: "Size",
      internal_notes: "Notes",
    });
  });

  it("detects ERS-like exports but keeps the ERS adapter marked unverified", () => {
    const headers = [
      "Item ID",
      "Item Name",
      "Rental Price",
      "Item Category",
      "Display On Website",
      "Item Size",
    ];
    const adapter = detectAdapter(headers);
    expect(adapter.id).toBe("ers");
    expect(adapter.verified).toBe(false);
    expect(suggestMapping(adapter, headers)).toMatchObject({
      external_ref: "Item ID",
      name: "Item Name",
      base_price: "Rental Price",
      category: "Item Category",
      is_published: "Display On Website",
      dimensions: "Item Size",
    });
  });

  it("never maps one source column to two fields", () => {
    const mapping = suggestMapping(getAdapter("generic_csv")!, ["Name", "Price"]);
    expect(Object.values(mapping)).toEqual(["Name", "Price"]);
  });

  it("reports missing required fields", () => {
    expect(missingRequiredFields({ name: "Name" })).toEqual(["base_price"]);
  });
});

describe("validateRow", () => {
  const mapping = suggestMapping(detectAdapter(fixture.headers), fixture.headers);
  const rows = fixture.rows.map((r, i) => validateRow(fixture.headers, r, mapping, i + 2));

  it("maps a full row onto the canonical product", () => {
    expect(rows[0]).toMatchObject({
      errors: [],
      mapped: {
        external_ref: "BH-1",
        name: "Rainbow Castle",
        slug: "rainbow-castle",
        base_price_cents: 17500,
        categories: [{ name: "Bounce Houses", slug: "bounce-houses" }],
        quantity: 2,
        wet_allowed: false,
        dry_allowed: true,
        minimum_age: 3,
        maximum_age: 10,
        recommended_capacity: 8,
        space_length_ft: 15,
        space_width_ft: 15,
        space_height_ft: 14,
        power_outlets_required: 1,
        ideal_event_types: ["birthday", "school"],
        tags: ["castle", "toddler"],
        internal_notes: "repaired seam 2025",
      },
    });
  });

  it("omits blank cells so re-imports never clear existing values", () => {
    expect(rows[2]!.mapped).toEqual({
      external_ref: "CH-1",
      name: "Folding Chair",
      slug: "folding-chair",
      base_price_cents: 250,
      categories: [{ name: "Tables & Chairs", slug: "tables-and-chairs" }],
      quantity: 150,
    });
  });

  it("handles multiple categories and quoted names", () => {
    expect(rows[1]!.mapped).toMatchObject({
      name: "Tropical Crush Combo, 2-lane",
      slug: "tropical-crush-combo-2-lane",
      categories: [
        { name: "Water Slides", slug: "water-slides" },
        { name: "Combos", slug: "combos" },
      ],
      ideal_event_types: ["birthday"],
    });
  });

  const one = (cells: Record<string, string>) => {
    const headers = Object.keys(cells);
    const m: FieldMapping = {};
    for (const h of headers) (m as Record<string, string>)[h] = h;
    return validateRow(headers, Object.values(cells), m, 2);
  };

  it.each([
    [{ name: "", base_price: "10" }, "name"],
    [{ name: "X", base_price: "" }, "base_price"],
    [{ name: "X", base_price: "ten" }, "base_price"],
    [{ name: "X", base_price: "10", minimum_age: "10", maximum_age: "5" }, "maximum_age"],
    [{ name: "X", base_price: "10", wet_allowed: "no", dry_allowed: "no" }, "dry_allowed"],
    [{ name: "X", base_price: "10", quantity: "-1" }, "quantity"],
    [{ name: "X", base_price: "10", tracking_mode: "bulk" }, "tracking_mode"],
    [{ name: "X", base_price: "10", water_required: "sometimes" }, "water_required"],
    [{ name: "!!!", base_price: "10" }, "slug"],
  ])("rejects %j (error on %s)", (cells, field) => {
    const r = one(cells);
    expect(r.mapped).toBeNull();
    expect(r.errors.map((e) => e.field)).toContain(field);
  });

  it("warns about unknown event types instead of failing", () => {
    const r = one({ name: "X", base_price: "10", event_types: "birthday; bar mitzvah" });
    expect(r.mapped?.ideal_event_types).toEqual(["birthday"]);
    expect(r.warnings[0]?.message).toMatch(/bar mitzvah/);
  });
});

describe("planImport", () => {
  const row = (
    n: number,
    mapped: Record<string, unknown> | null,
    errors: { field: "row"; message: string }[] = [],
  ) => ({
    rowNumber: n,
    mapped: mapped as never,
    errors,
    warnings: [],
  });

  it("creates new, updates by source ref, skips invalid", () => {
    const { rows, summary } = planImport(
      [
        row(2, { external_ref: "A", name: "A", slug: "a", base_price_cents: 1 }),
        row(3, { external_ref: "B", name: "B", slug: "b", base_price_cents: 1 }),
        row(4, null, [{ field: "row", message: "bad" }]),
      ],
      { slugs: new Map([["b", "B"]]), externalRefs: new Set(["B"]) },
    );
    expect(rows.map((r) => r.action)).toEqual(["create", "update", "skip"]);
    expect(summary).toEqual({ create: 1, update: 1, skip: 1, errors: 1 });
  });

  it("gives new products a unique slug when the name collides", () => {
    const { rows } = planImport(
      [row(2, { external_ref: "N", name: "Castle", slug: "castle", base_price_cents: 1 })],
      {
        slugs: new Map([["castle", null]]),
        externalRefs: new Set(),
      },
    );
    expect(rows[0]!.mapped!.slug).toBe("castle-2");
    expect(rows[0]!.warnings[0]!.message).toMatch(/castle-2/);
  });

  it("matches rows without a source ref by slug", () => {
    const { rows } = planImport([row(2, { name: "Castle", slug: "castle", base_price_cents: 1 })], {
      slugs: new Map([["castle", null]]),
      externalRefs: new Set(),
    });
    expect(rows[0]!.action).toBe("update");
  });

  it("rejects duplicates within the same file", () => {
    const { rows } = planImport(
      [
        row(2, { external_ref: "A", name: "A", slug: "a", base_price_cents: 1 }),
        row(3, { external_ref: "A", name: "A again", slug: "a-again", base_price_cents: 1 }),
        row(4, { name: "Same", slug: "same", base_price_cents: 1 }),
        row(5, { name: "Same", slug: "same", base_price_cents: 1 }),
      ],
      { slugs: new Map(), externalRefs: new Set() },
    );
    expect(rows.map((r) => r.action)).toEqual(["create", "skip", "create", "skip"]);
  });
});
