import type { MetadataRoute } from "next";
import { absolute, sitemapPaths } from "@/domain/storefront/seo";
import { getSeo } from "@/server/public/site";
import { getShell, listProductSlugs } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Per-host sitemap: every published page of the tenant (products read with deterministic
 * pagination), only on the verified canonical host of a production storefront; empty otherwise.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const tenant = await getRequestTenant();
  if (!tenant) return [];
  const seo = await getSeo(tenant);
  const origin = seo.canonicalOrigin;
  if (!seo.indexable || !origin) return [];
  const [shell, slugs] = await Promise.all([getShell(tenant), listProductSlugs(tenant)]);
  return sitemapPaths(shell, slugs).map((path) => ({ url: absolute(origin, path) }));
}
