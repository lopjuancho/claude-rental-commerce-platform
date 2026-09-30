import type { MetadataRoute } from "next";
import { isIndexable, siteOrigin } from "@/server/public/site";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

/** Per-host robots.txt (ADR 0016): only a production tenant host is crawlable, never private paths. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const tenant = await getRequestTenant();
  if (!tenant || !isIndexable(tenant)) return { rules: { userAgent: "*", disallow: "/" } };
  const origin = await siteOrigin(tenant);
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/q/", "/admin", "/api/", "/auth/"] },
    sitemap: `${origin}/sitemap.xml`,
  };
}
