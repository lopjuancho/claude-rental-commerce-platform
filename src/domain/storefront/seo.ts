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

/**
 * Canonical origin of a tenant storefront: its verified primary domain (always https), else the
 * host the request was served on. Local development hosts (*.localhost) keep http and their port.
 */
export function canonicalOrigin(
  primaryHostname: string | null,
  requestHost: string | null,
): string {
  const primary = normalizeHost(primaryHostname);
  if (primary && !isLocal(primary)) return `https://${primary}`;
  const host = normalizeHost(requestHost) ?? primary ?? "localhost";
  if (!isLocal(host)) return `https://${host}`;
  const port = requestHost?.match(/:(\d{1,5})$/)?.[1];
  return `http://${host}${port ? `:${port}` : ""}`;
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
  const offer =
    product.pricingType === "per_event" &&
    product.basePriceCents !== null &&
    product.basePriceCents > 0
      ? {
          "@type": "Offer",
          price: (product.basePriceCents / 100).toFixed(2),
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
