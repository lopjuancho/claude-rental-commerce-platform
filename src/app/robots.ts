import type { MetadataRoute } from "next";
import { robotsRules } from "@/domain/storefront/seo";
import { getSeo } from "@/server/public/site";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Per-host robots.txt (ADR 0016 §9): only the verified canonical host of a production storefront
 * is crawlable, never private paths (quote links, token-prefilled forms, admin, API).
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const tenant = await getRequestTenant();
  if (!tenant) return { rules: { userAgent: "*", disallow: "/" } };
  const seo = await getSeo(tenant);
  return {
    rules: robotsRules(seo),
    ...(seo.indexable && seo.canonicalOrigin
      ? { sitemap: `${seo.canonicalOrigin}/sitemap.xml` }
      : {}),
  };
}
