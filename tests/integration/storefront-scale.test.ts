import { beforeAll, expect, it } from "vitest";
import { loadQuoteForm } from "@/server/public/quote-form";
import {
  listBookableVariants,
  listProductSlugs,
  loadProductBySlug,
  loadProductPage,
  loadShell,
  PRODUCTS_PER_PAGE,
} from "@/server/public/storefront";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { admin, adminGated, createOrg, type TestOrg } from "./support/db";
import { describeRest } from "./support/rest";

/**
 * M6 review M4 (ADR 0016 §12): a catalog larger than the API's per-response cap (Supabase
 * `max_rows` = 1000) through the real PostgREST boundary. Nothing may 404, drop out of the sitemap
 * or the quote options, or lose media/variants because a single response was truncated.
 */
const ITEMS = 1050;
const GALLERY = 1005;
const OTHER = 40;
const tenantOf = (organizationId: string) => ({ organizationId }) as ResolvedTenant;

let big: TestOrg;
let other: TestOrg;
let categoryId: string;

async function bulkCatalog(org: TestOrg, prefix: string, count: number) {
  await adminGated(
    org.id,
    `insert into public.products (organization_id, name, slug, base_price_cents, is_published, sort_order, ideal_event_types)
     select $1, 'Item ' || lpad(g::text, 4, '0'), $2 || lpad(g::text, 4, '0'), 10000 + g, true, g, '{birthday}'
     from generate_series(1, $3::int) g`,
    [org.id, prefix, count],
  );
}

beforeAll(async () => {
  big = await createOrg("scale-a");
  other = await createOrg("scale-b");
  await bulkCatalog(big, "item-", ITEMS);
  await bulkCatalog(other, "other-", OTHER);
  const cat = await admin<{ id: string }>(
    "insert into public.categories (organization_id, name, slug) values ($1, 'Big', 'big') returning id",
    [big.id],
  );
  categoryId = cat.rows[0]!.id;
  await adminGated(
    big.id,
    `insert into public.product_categories (organization_id, product_id, category_id)
     select organization_id, id, $2 from public.products where organization_id = $1 and slug like 'item-%'`,
    [big.id, categoryId],
  );
  // One product with more images than a single response can carry.
  await adminGated(
    big.id,
    `insert into public.products (organization_id, name, slug, base_price_cents, is_published, sort_order)
     values ($1, 'Gallery', 'gallery', 5000, true, 99999)`,
    [big.id],
  );
  await adminGated(
    big.id,
    `insert into public.product_media (organization_id, product_id, storage_path, source, rights_status, sort_order)
     select p.organization_id, p.id, p.organization_id::text || '/g/' || g || '.jpg', 'upload', 'owned', g
     from public.products p, generate_series(1, $2::int) g
     where p.organization_id = $1 and p.slug = 'gallery'`,
    [big.id, GALLERY],
  );
}, 120_000);

describeRest("M4: catalogs beyond the API response cap", () => {
  const all = ITEMS + 1; // + gallery

  it("every published product resolves by slug, including those past the first 1000", async () => {
    for (const slug of ["item-0001", "item-1001", "item-1050", "gallery"]) {
      expect((await loadProductBySlug(tenantOf(big.id), slug))?.slug).toBe(slug);
    }
    expect(await loadProductBySlug(tenantOf(big.id), "other-0001")).toBeNull();
  }, 60_000);

  it("listing pages reach the end of the catalog with exact counts", async () => {
    const first = await loadProductPage(tenantOf(big.id), { page: 1 });
    expect(first.total).toBe(all);
    expect(first.pageCount).toBe(Math.ceil(all / PRODUCTS_PER_PAGE));
    const last = await loadProductPage(tenantOf(big.id), { page: first.pageCount });
    expect(last.products.map((p) => p.slug).at(-1)).toBe("gallery");
    expect(last.products).toHaveLength(all - (first.pageCount - 1) * PRODUCTS_PER_PAGE);
    const inCategory = await loadProductPage(tenantOf(big.id), { page: 44, categoryId });
    expect(inCategory.total).toBe(ITEMS);
    expect(inCategory.products.map((p) => p.slug)).toContain("item-1050");
    const byEvent = await loadProductPage(tenantOf(big.id), { page: 1, eventType: "birthday" });
    expect(byEvent.total).toBe(ITEMS);
  }, 60_000);

  it("the sitemap source lists every published product exactly once", async () => {
    const slugs = await listProductSlugs(tenantOf(big.id));
    expect(slugs).toHaveLength(all);
    expect(new Set(slugs).size).toBe(all);
    expect(slugs).toEqual(expect.arrayContaining(["item-0001", "item-1050", "gallery"]));
    expect(slugs.some((s) => s.startsWith("other-"))).toBe(false);
  }, 60_000);

  it("category counts come from the database, not a truncated enumeration", async () => {
    const shell = await loadShell(tenantOf(big.id));
    expect(shell.categories).toMatchObject([{ slug: "big", productCount: ITEMS }]);
    expect(shell.eventTypes).toEqual(["birthday"]);
  }, 60_000);

  it("more than 1000 variants and media rows are all read", async () => {
    const variants = await listBookableVariants(tenantOf(big.id));
    expect(variants).toHaveLength(all);
    expect(new Set(variants.map((v) => v.variantId)).size).toBe(all);
    const gallery = await loadProductBySlug(tenantOf(big.id), "gallery");
    expect(gallery?.images).toHaveLength(GALLERY);
    expect(new Set(gallery?.images.map((i) => i.id)).size).toBe(GALLERY);
  }, 60_000);

  it("quote preselection works for an item far past the first 500 options", async () => {
    const expected = await admin<{ id: string }>(
      `select v.id from public.product_variants v join public.products p on p.id = v.product_id
         where p.organization_id = $1 and p.slug = 'item-0777' and v.is_default`,
      [big.id],
    );
    const form = await loadQuoteForm(tenantOf(big.id), { item: "item-0777" });
    expect(form.options).toHaveLength(all);
    expect(form.prefill.items).toEqual([{ variantId: expected.rows[0]!.id, quantity: 1 }]);
    const tail = await loadQuoteForm(tenantOf(big.id), { item: "item-1050" });
    expect(tail.prefill.items).toHaveLength(1);
    // Another tenant's slug never preselects anything.
    expect((await loadQuoteForm(tenantOf(big.id), { item: "other-0001" })).prefill.items).toEqual(
      [],
    );
  }, 60_000);

  it("tenant isolation holds across every page", async () => {
    const otherSlugs = await listProductSlugs(tenantOf(other.id));
    expect(otherSlugs).toHaveLength(OTHER);
    expect(otherSlugs.every((s) => s.startsWith("other-"))).toBe(true);
    const variants = await listBookableVariants(tenantOf(other.id));
    expect(variants).toHaveLength(OTHER);
    const lastBig = await loadProductPage(tenantOf(big.id), { page: 44 });
    expect(lastBig.products.every((p) => p.row.organization_id === big.id)).toBe(true);
  }, 60_000);
});
