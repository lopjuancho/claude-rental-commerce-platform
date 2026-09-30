import { normalizeHost } from "@/domain/tenancy/host";
import type { Product, StorefrontProfile } from "./catalog";

/**
 * Structured data and metadata for the storefront (ADR 0016). Only authoritative, configured values
 * are emitted: no ratings, reviews, availability, service areas or prices that are not configured.
 */

export interface TenantFacts {
  name: string;
  currency: string;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
}

export type JsonLd = Record<string, unknown>;

const compact = (o: JsonLd): JsonLd =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0),
    ),
  );

const isLocal = (host: string) => host === "localhost" || host.endsWith(".localhost");

export interface SeoInput {
  /** APP_ENV === "production". Nothing else is ever indexable. */
  production: boolean;
  /** How the tenant was resolved; the development slug fallback is never indexable. */
  resolvedBy: "host" | "dev-slug";
  /** The raw Host header of this request. */
  requestHost: string | null;
  /** The tenant's VERIFIED domains only. */
  domains: { hostname: string; isPrimary: boolean }[];
}

export interface SeoDecision {
  /** Origin for canonical URLs and structured data, or null when no verified host exists. */
  canonicalOrigin: string | null;
  /** index,follow and a populated sitemap. */
  indexable: boolean;
  /** Robots meta when not indexable: a verified alias keeps links followable (they lead to the canonical host). */
  follow: boolean;
}

/**
 * Search-engine policy for one storefront request (ADR 0016 §9):
 * - The canonical host is the verified primary domain; without one, the request host if it is
 *   itself verified; otherwise there is no canonical URL. An unverified host is never canonical.
 * - A request is indexable only in production, resolved by host, on the canonical host.
 * - A verified alias (not the canonical host) is noindex,follow with its canonical pointing to the
 *   primary; an unverified host is noindex,nofollow.
 * Local development hosts (*.localhost) use http and keep the request's port.
 */
export function seoDecision(input: SeoInput): SeoDecision {
  const host = normalizeHost(input.requestHost);
  const verified = new Set(input.domains.map((d) => d.hostname.toLowerCase()));
  const primary = input.domains.find((d) => d.isPrimary)?.hostname.toLowerCase() ?? null;
  const canonicalHost = primary ?? (host && verified.has(host) ? host : null);
  const port = input.requestHost?.match(/:(\d{1,5})$/)?.[1];
  const canonicalOrigin = canonicalHost
    ? isLocal(canonicalHost)
      ? `http://${canonicalHost}${port ? `:${port}` : ""}`
      : `https://${canonicalHost}`
    : null;
  const onCanonicalHost = host !== null && host === canonicalHost;
  const indexable = input.production && input.resolvedBy === "host" && onCanonicalHost;
  return {
    canonicalOrigin,
    indexable,
    follow: indexable || (host !== null && verified.has(host)),
  };
}

/** Robots meta for a page; `isPrivate` pages (customer-specific) are never indexed or followed. */
export function robotsDirectives(
  seo: SeoDecision,
  isPrivate = false,
): { index: boolean; follow: boolean } {
  if (seo.indexable && !isPrivate) return { index: true, follow: true };
  return { index: false, follow: !isPrivate && seo.follow };
}

/** Paths that must never be crawled (customer quote links and token-prefilled forms included). */
export const PRIVATE_PATHS = ["/q/", "/quote?from=", "/admin", "/api/", "/auth/"];

export function robotsRules(decision: SeoDecision): {
  userAgent: string;
  allow?: string;
  disallow: string | string[];
} {
  return decision.indexable
    ? { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS }
    : { userAgent: "*", disallow: "/" };
}

export function absolute(origin: string, path: string) {
  return new URL(path, origin).toString();
}

/** LocalBusiness from the tenant's configured profile. */
export function localBusinessJsonLd(
  origin: string,
  tenant: TenantFacts,
  profile: StorefrontProfile,
): JsonLd {
  const a = profile.address;
  const address =
    a.line1 || a.city || a.state || a.postalCode
      ? compact({
          "@type": "PostalAddress",
          streetAddress: a.line1,
          addressLocality: a.city,
          addressRegion: a.state,
          postalCode: a.postalCode,
        })
      : null;
  return compact({
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    "@id": absolute(origin, "/#business"),
    name: tenant.name,
    url: absolute(origin, "/"),
    telephone: tenant.phone,
    email: tenant.email,
    logo: tenant.logoUrl,
    image: tenant.logoUrl,
    address,
    // Only configured service areas; never inferred from the delivery radius.
    areaServed: profile.serviceAreas.map((name) => ({ "@type": "Place", name })),
  });
}

/**
 * Product. An Offer is included only for a fixed per-event base rate (the configured price for one
 * event), never for hourly/daily/per-unit rates, and never with availability.
 */
export function productJsonLd(
  origin: string,
  tenant: TenantFacts,
  product: Product,
  path: string,
): JsonLd {
  // One truthful price only: a per-event product whose bookable variants all start from the same
  // engine price. Differing variant prices or unknown prices → no Offer (never an average).
  const offer =
    product.pricingType === "per_event" &&
    product.startingPriceCents !== null &&
    !product.priceVaries
      ? {
          "@type": "Offer",
          price: (product.startingPriceCents / 100).toFixed(2),
          priceCurrency: tenant.currency,
          url: absolute(origin, path),
          seller: { "@type": "Organization", name: tenant.name },
        }
      : null;
  return compact({
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: product.shortDescription ?? product.description,
    url: absolute(origin, path),
    image: product.images.map((i) => absolute(origin, i.url)),
    offers: offer,
  });
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbJsonLd(origin: string, crumbs: Crumb[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: absolute(origin, c.path),
    })),
  };
}

/** Safe for a <script type="application/ld+json"> body (no `</script>` break-out). */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

/** One-line, length-capped meta description from configured text. */
export function metaDescription(...candidates: (string | null | undefined)[]): string | undefined {
  const text = candidates
    .find((c) => c && c.trim() !== "")
    ?.replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length <= 160 ? text : `${text.slice(0, 157).replace(/\s+\S*$/, "")}…`;
}

/**
 * Public pages of an indexable storefront: never customer quote links, token-prefilled forms,
 * or anything unpublished (the inputs come from the published views only).
 */
export function sitemapPaths(
  shell: {
    categories: { slug: string; productCount: number }[];
    profile: { policies: { type: string }[] };
  },
  productSlugs: string[],
): string[] {
  return [
    "/",
    "/rentals",
    "/quote",
    ...shell.categories.filter((c) => c.productCount > 0).map((c) => `/categories/${c.slug}`),
    ...productSlugs.map((slug) => `/rentals/${encodeURIComponent(slug)}`),
    ...shell.profile.policies.map((p) => `/policies/${p.type}`),
  ];
}
