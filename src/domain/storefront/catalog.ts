/**
 * Storefront catalog model (ADR 0016). Pure: turns rows of the anon-safe public views into what
 * the storefront renders. Nothing here invents data — every field is either configured by the
 * tenant or absent, and absent fields are simply not shown.
 */

export type PricingType = "per_event" | "hourly" | "daily" | "per_unit";

export interface CategoryRow {
  id: string | null;
  organization_id: string | null;
  parent_id: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  sort_order: number | null;
}

export interface CategorySummaryRow {
  category_id: string | null;
  organization_id: string | null;
  product_count: number | null;
  cover_media_id: string | null;
  cover_alt_text: string | null;
  cover_width: number | null;
  cover_height: number | null;
}

export interface ProductRow {
  id: string | null;
  organization_id: string | null;
  primary_category_id: string | null;
  name: string | null;
  slug: string | null;
  short_description: string | null;
  description: string | null;
  is_featured: boolean | null;
  sort_order: number | null;
  pricing_type: string | null;
  base_price_cents: number | null;
  included_duration_minutes: number | null;
  minimum_rental_minutes: number | null;
  wet_allowed: boolean | null;
  dry_allowed: boolean | null;
  minimum_age: number | null;
  maximum_age: number | null;
  recommended_capacity: number | null;
  max_rider_weight_lbs: number | null;
  ideal_event_types: string[] | null;
  indoor_allowed: boolean | null;
  outdoor_allowed: boolean | null;
  allowed_surfaces: string[] | null;
  space_length_ft: number | null;
  space_width_ft: number | null;
  space_height_ft: number | null;
  power_outlets_required: number | null;
  power_notes: string | null;
  water_required: boolean | null;
  operator_required: boolean | null;
  attendants_required: number | null;
  setup_requirements: string | null;
  anchoring_methods: string[] | null;
  tags: string[] | null;
  extra_specs: unknown;
  weather_sensitivities: unknown;
  category_ids: string[] | null;
}

export interface MediaRow {
  id: string | null;
  organization_id: string | null;
  product_id: string | null;
  kind: string | null;
  storage_path: string | null;
  alt_text: string | null;
  width: number | null;
  height: number | null;
  sort_order: number | null;
  is_primary: boolean | null;
}

export interface VariantRow {
  id: string | null;
  organization_id: string | null;
  product_id: string | null;
  name: string | null;
  is_default: boolean | null;
  /** coalesce(variant override, product base): what the pricing engine starts from. */
  effective_base_price_cents: number | null;
}

export interface SettingsRow {
  organization_id: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  free_delivery_miles: number | null;
  maximum_delivery_miles: number | null;
  primary_hostname: string | null;
}

export interface DomainRow {
  organization_id: string | null;
  hostname: string | null;
  is_primary: boolean | null;
}

export interface PolicyRow {
  id: string | null;
  organization_id: string | null;
  policy_type: string | null;
  title: string | null;
  body: string | null;
  updated_at: string | null;
}

export interface ServiceAreaRow {
  organization_id: string | null;
  name: string | null;
  priority: number | null;
}

export interface EventTypeRow {
  organization_id: string | null;
  event_type: string | null;
  product_count: number | null;
}

export interface Image {
  id: string;
  url: string;
  /** Width-bounded variants for responsive loading, when image derivatives are enabled. */
  srcSet: string | null;
  alt: string;
  width: number | null;
  height: number | null;
}

/** Builds the tenant-scoped URLs for a media id (the storefront's /media route, never the bucket). */
export type ImageUrls = (mediaId: string) => { url: string; srcSet: string | null };

export const mediaUrl = (mediaId: string) => `/media/${mediaId}`;
export const plainImageUrls: ImageUrls = (id) => ({ url: mediaUrl(id), srcSet: null });

export interface Category {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  productCount: number;
  image: Image | null;
}

export interface Product {
  id: string;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  featured: boolean;
  pricingType: PricingType | null;
  /**
   * Lowest price the pricing engine starts from across the product's bookable variants, or null
   * when it cannot be stated truthfully (no bookable variant, or any variant without a price).
   */
  startingPriceCents: number | null;
  /** Bookable variants start from different prices ("From …"; no single structured Offer). */
  priceVaries: boolean;
  includedDurationMinutes: number | null;
  minimumRentalMinutes: number | null;
  primaryCategoryId: string | null;
  categoryIds: string[];
  eventTypes: string[];
  images: Image[];
  defaultVariantId: string | null;
  /** Bookable variants (default first), with the price the pricing engine starts from. */
  variants: { id: string; name: string; isDefault: boolean; priceCents: number | null }[];
  row: ProductRow;
}

export interface Policy {
  type: string;
  title: string;
  body: string;
  updatedAt: string | null;
}

export interface VerifiedDomain {
  hostname: string;
  isPrimary: boolean;
}

export interface StorefrontProfile {
  address: {
    line1: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
  };
  freeDeliveryMiles: number | null;
  maximumDeliveryMiles: number | null;
  /** Verified hostnames only (unverified domains never drive SEO). */
  domains: VerifiedDomain[];
  serviceAreas: string[];
  policies: Policy[];
}

/** Tenant-wide storefront data that does not grow with the catalog. */
export interface StorefrontShell {
  profile: StorefrontProfile;
  categories: Category[];
  eventTypes: string[];
}

const PRICING_TYPES = new Set<string>(["per_event", "hourly", "daily", "per_unit"]);
const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;
const byOrder = (a: { sort_order: number | null; name: string | null }, b: typeof a) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.name ?? "").localeCompare(b.name ?? "");
const mine =
  (organizationId: string) =>
  <T extends { organization_id: string | null }>(rows: T[]) =>
    rows.filter((r) => r.organization_id === organizationId);

function image(
  urls: ImageUrls,
  id: string,
  alt: string | null,
  width: number | null,
  height: number | null,
): Image {
  return { id, ...urls(id), alt: alt?.trim() ?? "", width, height };
}

/**
 * What the product can truthfully be advertised from: the engine's starting price of each
 * bookable variant. Unknown when there is no bookable variant or any of them has no price.
 */
export function variantPricing(variants: VariantRow[]): {
  startingPriceCents: number | null;
  priceVaries: boolean;
} {
  const prices = variants.map((v) => v.effective_base_price_cents);
  if (prices.length === 0 || prices.some((p) => p === null || p <= 0)) {
    return { startingPriceCents: null, priceVaries: false };
  }
  const known = prices as number[];
  return { startingPriceCents: Math.min(...known), priceVaries: new Set(known).size > 1 };
}

/** Products (one page of them, or one) with their images and bookable-variant pricing. */
export function assembleProducts(
  organizationId: string,
  raw: { products: ProductRow[]; media: MediaRow[]; variants: VariantRow[] },
  urls: ImageUrls = plainImageUrls,
): Product[] {
  // Defence in depth: the queries are already filtered by organization; others are dropped.
  const own = mine(organizationId);
  const imagesByProduct = new Map<string, Image[]>();
  const images = own(raw.media)
    .filter((m) => m.kind === "image")
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) ||
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    );
  for (const m of images) {
    const { id, product_id: productId } = m;
    if (!id || !productId) continue;
    const list = imagesByProduct.get(productId) ?? [];
    list.push(image(urls, id, m.alt_text, m.width, m.height));
    imagesByProduct.set(productId, list);
  }
  const variantsByProduct = new Map<string, VariantRow[]>();
  for (const v of own(raw.variants)) {
    if (!v.id || !v.product_id) continue;
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  return own(raw.products)
    .filter((p): p is ProductRow & { id: string; name: string; slug: string } =>
      Boolean(p.id && p.name && p.slug),
    )
    .map((p) => {
      const variants = variantsByProduct.get(p.id) ?? [];
      const defaultVariant = variants.find((v) => v.is_default) ?? variants[0];
      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        shortDescription: p.short_description?.trim() || null,
        description: p.description?.trim() || null,
        featured: p.is_featured === true,
        pricingType:
          p.pricing_type && PRICING_TYPES.has(p.pricing_type)
            ? (p.pricing_type as PricingType)
            : null,
        ...variantPricing(variants),
        includedDurationMinutes: p.included_duration_minutes,
        minimumRentalMinutes: p.minimum_rental_minutes,
        primaryCategoryId: p.primary_category_id,
        // The view lists published categories only.
        categoryIds: (p.category_ids ?? []).filter(present),
        eventTypes: (p.ideal_event_types ?? []).filter((t) => t.trim() !== ""),
        images: imagesByProduct.get(p.id) ?? [],
        defaultVariantId: defaultVariant?.id ?? null,
        variants: variants
          .map((v) => ({
            id: v.id ?? "",
            name: v.name ?? "",
            isDefault: v.is_default === true,
            priceCents: v.effective_base_price_cents,
          }))
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.id.localeCompare(b.id)),
        row: p,
      };
    });
}

/** Profile, categories and event types of one tenant. */
export function assembleShell(
  organizationId: string,
  raw: {
    settings: SettingsRow | null;
    domains: DomainRow[];
    policies: PolicyRow[];
    serviceAreas: ServiceAreaRow[];
    categories: CategoryRow[];
    summaries: CategorySummaryRow[];
    eventTypes: EventTypeRow[];
  },
  urls: ImageUrls = plainImageUrls,
): StorefrontShell {
  const own = mine(organizationId);
  const summaries = new Map(
    own(raw.summaries).flatMap((s) => (s.category_id ? [[s.category_id, s] as const] : [])),
  );
  const categories: Category[] = own(raw.categories)
    .filter((c): c is CategoryRow & { id: string; name: string; slug: string } =>
      Boolean(c.id && c.name && c.slug),
    )
    .sort(byOrder)
    .map((c) => {
      const s = summaries.get(c.id);
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description?.trim() || null,
        productCount: s?.product_count ?? 0,
        image: s?.cover_media_id
          ? image(urls, s.cover_media_id, s.cover_alt_text, s.cover_width, s.cover_height)
          : null,
      };
    });

  const s = raw.settings && raw.settings.organization_id === organizationId ? raw.settings : null;
  const domains = own(raw.domains).flatMap((d) =>
    d.hostname ? [{ hostname: d.hostname.toLowerCase(), isPrimary: d.is_primary === true }] : [],
  );
  return {
    profile: {
      address: {
        line1: s?.address_line1 ?? null,
        city: s?.city ?? null,
        state: s?.state ?? null,
        postalCode: s?.postal_code ?? null,
      },
      freeDeliveryMiles: s?.free_delivery_miles ?? null,
      maximumDeliveryMiles: s?.maximum_delivery_miles ?? null,
      domains,
      serviceAreas: own(raw.serviceAreas)
        .sort(
          (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
        )
        .map((a) => a.name?.trim() ?? "")
        .filter(Boolean),
      policies: own(raw.policies).flatMap(({ policy_type: type, title, body, updated_at }) =>
        type && title && body ? [{ type, title, body, updatedAt: updated_at }] : [],
      ),
    },
    categories,
    eventTypes: own(raw.eventTypes)
      .filter((e): e is EventTypeRow & { event_type: string } => Boolean(e.event_type))
      .sort(
        (a, b) =>
          (b.product_count ?? 0) - (a.product_count ?? 0) ||
          a.event_type.localeCompare(b.event_type),
      )
      .map((e) => e.event_type),
  };
}

/** Human label for configured slugs/enums ("birthday" → "Birthday", "grass_turf" → "Grass turf"). */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Rank candidates sharing categories with the product (primary category counts double). */
export function relatedProducts(candidates: Product[], product: Product, limit = 4): Product[] {
  const shared = (p: Product) =>
    p.categoryIds.filter((id) => product.categoryIds.includes(id)).length;
  return candidates
    .filter((p) => p.id !== product.id)
    .map((p) => ({
      p,
      score: (p.primaryCategoryId === product.primaryCategoryId ? 2 : 0) + shared(p),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);
}
