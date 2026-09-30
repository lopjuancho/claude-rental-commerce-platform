import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import type { Storefront } from "@/domain/storefront/catalog";
import { absolute, canonicalOrigin, metaDescription } from "@/domain/storefront/seo";
import { getServerEnv } from "@/server/env";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { brandAssetUrl, getStorefront } from "./storefront";

/** Canonical origin of the tenant's storefront (see canonicalOrigin). */
export async function siteOrigin(tenant: ResolvedTenant): Promise<string> {
  const store = await getStorefront(tenant);
  return canonicalOrigin(store.profile.primaryHostname, (await headers()).get("host"));
}

/** Search engines index only production storefronts served on a tenant's own host. */
export function isIndexable(tenant: ResolvedTenant): boolean {
  return getServerEnv().APP_ENV === "production" && tenant.resolvedBy === "host";
}

export async function storefrontMetadata(opts: {
  tenant: ResolvedTenant;
  store: Storefront;
  path: string;
  title: string;
  description?: string | null;
  imagePath?: string | null;
  type?: "website" | "article";
}): Promise<Metadata> {
  const origin = await siteOrigin(opts.tenant);
  const url = absolute(origin, opts.path);
  const description = metaDescription(opts.description);
  const image = opts.imagePath
    ? absolute(origin, opts.imagePath)
    : brandAssetUrl(opts.tenant.branding.logoPath);
  const index = isIndexable(opts.tenant);
  return {
    title: opts.title,
    ...(description ? { description } : {}),
    alternates: { canonical: url },
    openGraph: {
      type: opts.type ?? "website",
      url,
      siteName: opts.tenant.name,
      title: opts.title,
      ...(description ? { description } : {}),
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card: image ? "summary_large_image" : "summary",
      title: opts.title,
      ...(description ? { description } : {}),
      ...(image ? { images: [image] } : {}),
    },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
    ...(opts.tenant.branding.faviconPath
      ? { icons: { icon: brandAssetUrl(opts.tenant.branding.faviconPath) ?? undefined } }
      : {}),
  };
}
