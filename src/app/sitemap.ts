import type { MetadataRoute } from "next";
import { absolute } from "@/domain/storefront/seo";
import { isIndexable, siteOrigin } from "@/server/public/site";
import { getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

/** Per-host sitemap of the tenant's published storefront pages (empty when not indexable). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const tenant = await getRequestTenant();
  if (!tenant || !isIndexable(tenant)) return [];
  const store = await getStorefront(tenant);
  const origin = await siteOrigin(tenant);
  const paths = [
    "/",
    "/rentals",
    "/quote",
    ...store.categories.filter((c) => c.productCount > 0).map((c) => `/categories/${c.slug}`),
    ...store.products.map((p) => `/rentals/${p.slug}`),
    ...store.profile.policies.map((p) => `/policies/${p.type}`),
  ];
  return paths.map((path) => ({ url: absolute(origin, path) }));
}
