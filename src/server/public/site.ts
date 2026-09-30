import "server-only";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { cache } from "react";
import {
  absolute,
  metaDescription,
  robotsDirectives,
  type SeoDecision,
  seoDecision,
} from "@/domain/storefront/seo";
import { getServerEnv } from "@/server/env";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { brandAssetUrl, getShell } from "./storefront";

/**
 * Search-engine policy for this request (ADR 0016 §9): decided from the ACTUAL request host
 * against the tenant's verified domains only. Cached per request.
 */
export const getSeo = cache(async (tenant: ResolvedTenant): Promise<SeoDecision> => {
  const shell = await getShell(tenant);
  return seoDecision({
    production: getServerEnv().APP_ENV === "production",
    resolvedBy: tenant.resolvedBy,
    requestHost: (await headers()).get("host"),
    domains: shell.profile.domains,
  });
});

/**
 * Page metadata. Canonical URLs and absolute share URLs exist only when there is a verified
 * canonical host; `path` never carries tokens, filters or preselections (only a page number).
 */
export async function storefrontMetadata(opts: {
  tenant: ResolvedTenant;
  path: string;
  title: string;
  description?: string | null;
  imagePath?: string | null;
  type?: "website" | "article";
  /** Customer-specific pages (e.g. a form prefilled from a quote link): noindex,nofollow. */
  private?: boolean;
}): Promise<Metadata> {
  const seo = await getSeo(opts.tenant);
  const origin = seo.canonicalOrigin;
  const url = origin ? absolute(origin, opts.path) : null;
  const description = metaDescription(opts.description);
  const image =
    origin && opts.imagePath && !opts.private
      ? absolute(origin, opts.imagePath)
      : brandAssetUrl(opts.tenant.branding.logoPath);
  return {
    title: opts.title,
    ...(description ? { description } : {}),
    ...(url ? { alternates: { canonical: url } } : {}),
    openGraph: {
      type: opts.type ?? "website",
      ...(url ? { url } : {}),
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
    robots: robotsDirectives(seo, opts.private),
    ...(opts.tenant.branding.faviconPath
      ? { icons: { icon: brandAssetUrl(opts.tenant.branding.faviconPath) ?? undefined } }
      : {}),
  };
}
