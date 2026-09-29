import "server-only";
import { fromDbError } from "@/server/catalog/errors";
import { createPublicClient } from "@/server/db/public";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Bookable items for the public quote form, read through the anon-safe catalog views (no service
 * role). Only published products of the host-resolved tenant. Prices are NOT shown here: the
 * quote itself is priced by the engine.
 */
export async function listQuoteOptions(tenant: ResolvedTenant) {
  const db = createPublicClient();
  const [products, variants] = await Promise.all([
    db
      .from("public_catalog_products")
      .select("id, name")
      .eq("organization_id", tenant.organizationId)
      .order("sort_order")
      .limit(500),
    db
      .from("public_catalog_variants")
      .select("id, product_id, name, is_default")
      .eq("organization_id", tenant.organizationId)
      .limit(2000),
  ]);
  if (products.error) throw fromDbError(products.error, "Product");
  if (variants.error) throw fromDbError(variants.error, "Product");
  const names = new Map(products.data.map((p) => [p.id, p.name]));
  return variants.data
    .filter((v) => v.id && v.product_id && names.has(v.product_id))
    .map((v) => ({
      variantId: v.id as string,
      label: v.is_default
        ? (names.get(v.product_id as string) ?? "")
        : `${names.get(v.product_id as string) ?? ""} — ${v.name ?? ""}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
