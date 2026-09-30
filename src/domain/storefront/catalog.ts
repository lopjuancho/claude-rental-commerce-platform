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

export interface Image {
  id: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
}

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
  basePriceCents: number | null;
  includedDurationMinutes: number | null;
  minimumRentalMinutes: number | null;
  primaryCategoryId: string | null;
  categoryIds: string[];
  eventTypes: string[];
  images: Image[];
  defaultVariantId: string | null;
  row: ProductRow;
}

export interface Policy {
  type: string;
  title: string;
  body: string;
  updatedAt: string | null;
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
  primaryHostname: string | null;
  serviceAreas: string[];
  policies: Policy[];
}

export interface Storefront {
  profile: StorefrontProfile;
  categories: Category[];
  products: Product[];
}

const PRICING_TYPES = new Set<string>(["per_event", "hourly", "daily", "per_unit"]);
const present = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined;
const byOrder = (a: { sort_order: number | null; name: string | null }, b: typeof a) =>
  (a.sort_order ?? 0) - (b.sort_order ?? 0) || (a.name ?? "").localeCompare(b.name ?? "");

/** Stable, tenant-scoped image URL (served by the storefront's /media route, never the bucket). */
export const mediaUrl = (mediaId: string) => `/media/${mediaId}`;

export function assembleStorefront(
  organizationId: string,
  raw: {
    settings: SettingsRow | null;
    policies: PolicyRow[];
    serviceAreas: ServiceAreaRow[];
    categories: CategoryRow[];
    products: ProductRow[];
    media: MediaRow[];
    variants: VariantRow[];
  },
): Storefront {
  // Defence in depth: the source is already filtered by organization; rows of any other are dropped.
  const mine = <T extends { organization_id: string | null }>(rows: T[]) =>
    rows.filter((r) => r.organization_id === organizationId);

  const imagesByProduct = new Map<string, Image[]>();
  const images = mine(raw.media)
    .filter((m) => m.kind === "image")
    .sort(
      (a, b) =>
        Number(b.is_primary) - Number(a.is_primary) || (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
  for (const m of images) {
    const { id, product_id: productId } = m;
    if (!id || !productId) continue;
    const list = imagesByProduct.get(productId) ?? [];
    list.push({
      id,
      url: mediaUrl(id),
      alt: m.alt_text?.trim() ?? "",
      width: m.width,
      height: m.height,
    });
    imagesByProduct.set(productId, list);
  }
  const defaultVariant = new Map<string, string>();
  for (const v of mine(raw.variants)) {
    if (!v.id || !v.product_id) continue;
    if (v.is_default || !defaultVariant.has(v.product_id)) defaultVariant.set(v.product_id, v.id);
  }

  const products: Product[] = mine(raw.products)
    .filter((p): p is ProductRow & { id: string; name: string; slug: string } =>
      Boolean(p.id && p.name && p.slug),
    )
    .sort(byOrder)
    .map((p) => ({
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
      basePriceCents: p.base_price_cents,
      includedDurationMinutes: p.included_duration_minutes,
      minimumRentalMinutes: p.minimum_rental_minutes,
      primaryCategoryId: p.primary_category_id,
      categoryIds: (p.category_ids ?? []).filter(present),
      eventTypes: (p.ideal_event_types ?? []).filter((t) => t.trim() !== ""),
      images: imagesByProduct.get(p.id) ?? [],
      defaultVariantId: defaultVariant.get(p.id) ?? null,
      row: p,
    }));

  const publishedCategoryIds = new Set(mine(raw.categories).map((c) => c.id));
  const categories: Category[] = mine(raw.categories)
    .filter((c): c is CategoryRow & { id: string; name: string; slug: string } =>
      Boolean(c.id && c.name && c.slug),
    )
    .sort(byOrder)
    .map((c) => {
      const inCategory = products.filter((p) => p.categoryIds.includes(c.id));
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description?.trim() || null,
        productCount: inCategory.length,
        image: inCategory.flatMap((p) => p.images)[0] ?? null,
      };
    });
  // Products only reference published categories (the view already drops the others).
  for (const p of products)
    p.categoryIds = p.categoryIds.filter((id) => publishedCategoryIds.has(id));

  const s = raw.settings && raw.settings.organization_id === organizationId ? raw.settings : null;
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
      primaryHostname: s?.primary_hostname ?? null,
      serviceAreas: mine(raw.serviceAreas)
        .sort(
          (a, b) =>
            (b.priority ?? 0) - (a.priority ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
        )
        .map((a) => a.name?.trim() ?? "")
        .filter(Boolean),
      policies: mine(raw.policies).flatMap(({ policy_type: type, title, body, updated_at }) =>
        type && title && body ? [{ type, title, body, updatedAt: updated_at }] : [],
      ),
    },
    categories,
    products,
  };
}

/** Human label for configured slugs/enums ("birthday" → "Birthday", "grass_turf" → "Grass turf"). */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Distinct event types across products, in first-seen order (drives "Perfect for…" sections). */
export function eventTypesOf(products: Product[]): string[] {
  return [...new Set(products.flatMap((p) => p.eventTypes))];
}

export function relatedProducts(all: Product[], product: Product, limit = 4): Product[] {
  const shared = (p: Product) =>
    p.categoryIds.filter((id) => product.categoryIds.includes(id)).length;
  return all
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
