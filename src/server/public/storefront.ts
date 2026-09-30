import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import { cache } from "react";
import {
  assembleProducts,
  assembleShell,
  type ImageUrls,
  mediaUrl,
  type Product,
  type ProductRow,
  relatedProducts,
  type StorefrontShell,
} from "@/domain/storefront/catalog";
import { collectPages } from "@/lib/paginate";
import { fromDbError } from "@/server/catalog/errors";
import { createPublicClient, type PublicClient } from "@/server/db/public";
import { getServerEnv } from "@/server/env";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Storefront reads (ADR 0016): the anon-safe public views only — published data of active
 * organizations, always filtered by the host-resolved tenant. No service role, no session.
 *
 * Nothing here relies on a single capped list (§12): pages and details query exactly what they
 * show (slug lookups, one page of products, a product's own media), and anything that must be
 * complete (sitemap, quote options) is read with deterministic range pagination.
 */

type Result<T> = { data: T[] | null; error: PostgrestError | null };

function rowsOf<T>(res: Result<T>, what: string): T[] {
  if (res.error) throw fromDbError(res.error, what);
  return res.data ?? [];
}

/** Every row of a query ordered by a unique key, page by page (never assumes one response is all). */
function all<T>(what: string, page: (from: number, to: number) => PromiseLike<Result<T>>) {
  return collectPages(async (from, to) => rowsOf(await page(from, to), what));
}

/** Width-bounded image variants served by /media/[id]?w= (only when transformations are on). */
export const IMAGE_WIDTHS = [320, 640, 960, 1280] as const;

export function imageUrls(): ImageUrls {
  const transforms = getServerEnv().STOREFRONT_IMAGE_TRANSFORMS === "on";
  return (id) => ({
    url: mediaUrl(id),
    srcSet: transforms
      ? IMAGE_WIDTHS.map((w) => `${mediaUrl(id)}?w=${String(w)} ${String(w)}w`).join(", ")
      : null,
  });
}

const orderProducts = <
  Q extends { order: (column: string, options?: { ascending?: boolean }) => Q },
>(
  q: Q,
) => q.order("sort_order").order("name").order("id");

/** Profile, verified domains, policies, areas, categories (with counts) and event types. */
export async function loadShell(
  tenant: ResolvedTenant,
  db: PublicClient = createPublicClient(),
): Promise<StorefrontShell> {
  const org = tenant.organizationId;
  const [settings, domains, policies, serviceAreas, categories, summaries, eventTypes] =
    await Promise.all([
      db
        .from("public_storefront_settings")
        .select("*")
        .eq("organization_id", org)
        .limit(1)
        .then((r) => rowsOf(r, "Store")[0] ?? null),
      all("Store", (from, to) =>
        db
          .from("public_storefront_domains")
          .select("*")
          .eq("organization_id", org)
          .order("hostname")
          .range(from, to),
      ),
      all("Policy", (from, to) =>
        db
          .from("public_storefront_policies")
          .select("id, organization_id, policy_type, title, body, updated_at")
          .eq("organization_id", org)
          .order("id")
          .range(from, to),
      ),
      all("Service area", (from, to) =>
        db
          .from("public_service_areas")
          .select("id, organization_id, name, priority")
          .eq("organization_id", org)
          .order("id")
          .range(from, to),
      ),
      all("Category", (from, to) =>
        db
          .from("public_catalog_categories")
          .select("*")
          .eq("organization_id", org)
          .order("id")
          .range(from, to),
      ),
      all("Category", (from, to) =>
        db
          .from("public_catalog_category_summaries")
          .select("*")
          .eq("organization_id", org)
          .order("category_id")
          .range(from, to),
      ),
      all("Category", (from, to) =>
        db
          .from("public_catalog_event_types")
          .select("*")
          .eq("organization_id", org)
          .order("event_type")
          .range(from, to),
      ),
    ]);
  return assembleShell(
    org,
    { settings, domains, policies, serviceAreas, categories, summaries, eventTypes },
    imageUrls(),
  );
}

/** Per-request cache keyed by tenant (a request only ever serves one tenant). */
export const getShell = cache((tenant: ResolvedTenant) => loadShell(tenant));

/** Images and bookable variants of the given products (one page at most), then the model. */
async function withDetails(org: string, rows: ProductRow[], db: PublicClient): Promise<Product[]> {
  const ids = rows.flatMap((r) => (r.id ? [r.id] : []));
  if (ids.length === 0) return [];
  const [media, variants] = await Promise.all([
    all("Media", (from, to) =>
      db
        .from("public_catalog_product_media")
        .select("*")
        .eq("organization_id", org)
        .in("product_id", ids)
        .order("id")
        .range(from, to),
    ),
    all("Product", (from, to) =>
      db
        .from("public_catalog_variants")
        .select("*")
        .eq("organization_id", org)
        .in("product_id", ids)
        .order("id")
        .range(from, to),
    ),
  ]);
  return assembleProducts(org, { products: rows, media, variants }, imageUrls());
}

export const PRODUCTS_PER_PAGE = 24;

/** One page of the published catalog, optionally within a category or for an event type. */
export async function loadProductPage(
  tenant: ResolvedTenant,
  opts: { page: number; categoryId?: string; eventType?: string; pageSize?: number },
  db: PublicClient = createPublicClient(),
): Promise<{ products: Product[]; total: number; pageCount: number }> {
  const org = tenant.organizationId;
  const size = opts.pageSize ?? PRODUCTS_PER_PAGE;
  const from = (Math.max(1, opts.page) - 1) * size;
  let q = db
    .from("public_catalog_products")
    .select("*", { count: "exact" })
    .eq("organization_id", org);
  if (opts.categoryId) q = q.contains("category_ids", [opts.categoryId]);
  if (opts.eventType) q = q.contains("ideal_event_types", [opts.eventType as never]);
  const res = await orderProducts(q).range(from, from + size - 1);
  const rows = rowsOf(res, "Product");
  const total = res.count ?? rows.length;
  return {
    products: await withDetails(org, rows, db),
    total,
    pageCount: Math.max(1, Math.ceil(total / size)),
  };
}

export async function loadFeaturedProducts(
  tenant: ResolvedTenant,
  limit: number,
  db: PublicClient = createPublicClient(),
): Promise<Product[]> {
  const org = tenant.organizationId;
  const res = await orderProducts(
    db
      .from("public_catalog_products")
      .select("*")
      .eq("organization_id", org)
      .eq("is_featured", true),
  ).limit(limit);
  return withDetails(org, rowsOf(res, "Product"), db);
}

/** A published product of this tenant by slug (direct lookup), or null. */
export async function loadProductBySlug(
  tenant: ResolvedTenant,
  slug: string,
  db: PublicClient = createPublicClient(),
): Promise<Product | null> {
  const org = tenant.organizationId;
  const res = await db
    .from("public_catalog_products")
    .select("*")
    .eq("organization_id", org)
    .eq("slug", slug)
    .limit(1);
  const [product] = await withDetails(org, rowsOf(res, "Product"), db);
  return product ?? null;
}

/** Up to `limit` products sharing a category with the product, best matches first. */
export async function loadRelatedProducts(
  tenant: ResolvedTenant,
  product: Product,
  limit = 4,
  db: PublicClient = createPublicClient(),
): Promise<Product[]> {
  if (product.categoryIds.length === 0) return [];
  const org = tenant.organizationId;
  const res = await orderProducts(
    db
      .from("public_catalog_products")
      .select("*")
      .eq("organization_id", org)
      .overlaps("category_ids", product.categoryIds)
      .neq("id", product.id),
  ).limit(limit * 3);
  return relatedProducts(await withDetails(org, rowsOf(res, "Product"), db), product, limit);
}

/** Every published product slug of the tenant (sitemap), paginated deterministically. */
export async function listProductSlugs(
  tenant: ResolvedTenant,
  db: PublicClient = createPublicClient(),
): Promise<string[]> {
  const rows = await all("Product", (from, to) =>
    db
      .from("public_catalog_products")
      .select("id, slug")
      .eq("organization_id", tenant.organizationId)
      .order("id")
      .range(from, to),
  );
  return rows.flatMap((r) => (r.slug ? [r.slug] : []));
}

/** Every bookable variant (with its product name) of the tenant, paginated deterministically. */
export async function listBookableVariants(
  tenant: ResolvedTenant,
  db: PublicClient = createPublicClient(),
): Promise<{ variantId: string; productId: string; label: string }[]> {
  const org = tenant.organizationId;
  const [products, variants] = await Promise.all([
    all("Product", (from, to) =>
      db
        .from("public_catalog_products")
        .select("id, name")
        .eq("organization_id", org)
        .order("id")
        .range(from, to),
    ),
    all("Product", (from, to) =>
      db
        .from("public_catalog_variants")
        .select("id, product_id, name, is_default")
        .eq("organization_id", org)
        .order("id")
        .range(from, to),
    ),
  ]);
  const names = new Map(products.map((p) => [p.id, p.name]));
  return variants.flatMap((v) => {
    const product = v.product_id ? names.get(v.product_id) : undefined;
    if (!v.id || !v.product_id || !product) return [];
    return [
      {
        variantId: v.id,
        productId: v.product_id,
        label: v.is_default ? product : `${product} — ${v.name ?? ""}`,
      },
    ];
  });
}

/** Public URL of a tenant brand asset (the brand-assets bucket is public by design). */
export function brandAssetUrl(path: string | null): string | null {
  if (!path) return null;
  const base = getServerEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/brand-assets/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export interface ProductSearch {
  query?: string | undefined;
  categoryId?: string | undefined;
  categoryIdsMatchingQuery?: string[] | undefined;
  eventType?: string | undefined;
  minCapacity?: number | undefined;
  wet?: boolean | undefined;
  limit: number;
}

/**
 * Plain search words from free text: letters and digits only (nothing can reach the PostgREST
 * filter syntax), common filler words dropped, plurals folded ("slides" → "slide"), at most five.
 */
const STOP_WORDS = new Set(
  "a an and any are can do for from have i in is it me my need of on or our some the this to we what with you your want would rent rental".split(
    " ",
  ),
);

export function searchWords(query: string | undefined): string[] {
  return [
    ...new Set(
      (query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
        .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
    ),
  ].slice(0, 5);
}

/**
 * Published products of the tenant matching structured filters and (optionally) search words in
 * the name or short description, or in a matching category. Assistant `search_products`.
 */
export async function searchProducts(
  tenant: ResolvedTenant,
  search: ProductSearch,
  db: PublicClient = createPublicClient(),
): Promise<Product[]> {
  const org = tenant.organizationId;
  let q = db.from("public_catalog_products").select("*").eq("organization_id", org);
  const words = searchWords(search.query);
  if (words.length) {
    const clauses = words.flatMap((w) => [`name.ilike.*${w}*`, `short_description.ilike.*${w}*`]);
    const cats = (search.categoryIdsMatchingQuery ?? []).filter((id) => /^[0-9a-f-]{36}$/.test(id));
    if (cats.length) clauses.push(`category_ids.ov.{${cats.join(",")}}`);
    q = q.or(clauses.join(","));
  }
  if (search.categoryId) q = q.contains("category_ids", [search.categoryId]);
  if (search.eventType) q = q.contains("ideal_event_types", [search.eventType as never]);
  if (search.minCapacity !== undefined) q = q.gte("recommended_capacity", search.minCapacity);
  if (search.wet === true) q = q.eq("wet_allowed", true);
  if (search.wet === false) q = q.eq("dry_allowed", true);
  const res = await orderProducts(q).limit(Math.min(Math.max(search.limit, 1), 12));
  return withDetails(org, rowsOf(res, "Product"), db);
}
