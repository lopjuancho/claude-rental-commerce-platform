import { describe, expect, it } from "vitest";
import { readableOn } from "@/components/tenant-theme";
import {
  assembleProducts,
  assembleShell,
  humanize,
  type ProductRow,
  relatedProducts,
  type VariantRow,
  variantPricing,
} from "@/domain/storefront/catalog";
import {
  PRICE_QUALIFIER,
  priceSummary,
  specGroups,
  weatherNotes,
} from "@/domain/storefront/present";
import {
  localDateTime,
  localToday,
  normalizeItems,
  prefillFromQuote,
  QUOTE_ITEM_ROWS,
} from "@/domain/storefront/quote-prefill";
import { quoteNextStep, STALE_MESSAGE } from "@/domain/storefront/quote-step";
import {
  breadcrumbJsonLd,
  localBusinessJsonLd,
  metaDescription,
  PRIVATE_PATHS,
  productJsonLd,
  robotsDirectives,
  robotsRules,
  seoDecision,
  serializeJsonLd,
  sitemapPaths,
} from "@/domain/storefront/seo";
import { collectPages } from "@/lib/paginate";

const A = "10000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000001";

function productRow(over: Partial<ProductRow> = {}): ProductRow {
  return {
    id: "p1",
    organization_id: A,
    primary_category_id: "c1",
    name: "Castle Bouncer",
    slug: "castle-bouncer",
    short_description: "A bouncy castle.",
    description: null,
    is_featured: false,
    sort_order: 0,
    pricing_type: "per_event",
    base_price_cents: 17500,
    included_duration_minutes: 240,
    minimum_rental_minutes: null,
    wet_allowed: null,
    dry_allowed: null,
    minimum_age: null,
    maximum_age: null,
    recommended_capacity: null,
    max_rider_weight_lbs: null,
    ideal_event_types: [],
    indoor_allowed: null,
    outdoor_allowed: null,
    allowed_surfaces: null,
    space_length_ft: null,
    space_width_ft: null,
    space_height_ft: null,
    power_outlets_required: null,
    power_notes: null,
    water_required: null,
    operator_required: null,
    attendants_required: null,
    setup_requirements: null,
    anchoring_methods: null,
    tags: null,
    extra_specs: null,
    weather_sensitivities: null,
    category_ids: ["c1"],
    ...over,
  };
}

/** A bookable variant as the public view returns it (effective = override ?? product base). */
const variant = (
  id: string,
  effective: number | null,
  over: Partial<VariantRow> = {},
): VariantRow => ({
  id,
  organization_id: A,
  product_id: "p1",
  name: id,
  is_default: false,
  effective_base_price_cents: effective,
  ...over,
});

/** One product with the given row overrides and bookable variants (default: one at the base). */
function product(over: Partial<ProductRow> = {}, variants?: VariantRow[]) {
  const row = productRow(over);
  const vs = variants ?? [variant("v1", row.base_price_cents, { is_default: true })];
  const [p] = assembleProducts(A, { products: [row], media: [], variants: vs });
  if (!p) throw new Error("product not assembled");
  return p;
}

describe("assembleProducts / assembleShell", () => {
  it("drop every row that belongs to another organization", () => {
    const products = assembleProducts(A, {
      products: [productRow(), productRow({ id: "p2", organization_id: B, slug: "theirs" })],
      media: [
        {
          id: "mB",
          organization_id: B,
          product_id: "p1",
          kind: "image",
          storage_path: null,
          alt_text: null,
          width: null,
          height: null,
          sort_order: 0,
          is_primary: true,
        },
      ],
      variants: [variant("vB", 100, { organization_id: B })],
    });
    expect(products.map((p) => p.slug)).toEqual(["castle-bouncer"]);
    expect(products[0]?.images).toEqual([]);
    expect(products[0]?.defaultVariantId).toBeNull();

    const shell = assembleShell(A, {
      settings: {
        organization_id: B,
        address_line1: "1 Other St",
        city: null,
        state: null,
        postal_code: null,
        free_delivery_miles: null,
        maximum_delivery_miles: null,
        primary_hostname: "other.example",
      },
      domains: [{ organization_id: B, hostname: "other.example", is_primary: true }],
      policies: [
        {
          id: "x",
          organization_id: B,
          policy_type: "safety",
          title: "T",
          body: "B",
          updated_at: null,
        },
      ],
      serviceAreas: [{ organization_id: B, name: "Elsewhere", priority: 1 }],
      categories: [
        {
          id: "cB",
          organization_id: B,
          parent_id: null,
          name: "Theirs",
          slug: "theirs",
          description: null,
          sort_order: 0,
        },
      ],
      summaries: [],
      eventTypes: [{ organization_id: B, event_type: "birthday", product_count: 3 }],
    });
    expect(shell.profile.policies).toEqual([]);
    expect(shell.profile.serviceAreas).toEqual([]);
    expect(shell.profile.address.line1).toBeNull();
    expect(shell.profile.domains).toEqual([]);
    expect(shell.categories).toEqual([]);
    expect(shell.eventTypes).toEqual([]);
  });

  it("categories carry database-computed counts and covers; event types by popularity", () => {
    const shell = assembleShell(A, {
      settings: null,
      domains: [{ organization_id: A, hostname: "Shop.Example.com", is_primary: true }],
      policies: [],
      serviceAreas: [],
      categories: [
        {
          id: "c1",
          organization_id: A,
          parent_id: null,
          name: "Bouncers",
          slug: "bouncers",
          description: null,
          sort_order: 0,
        },
      ],
      summaries: [
        {
          category_id: "c1",
          organization_id: A,
          product_count: 1234,
          cover_media_id: "m1",
          cover_alt_text: " Castle ",
          cover_width: 800,
          cover_height: 600,
        },
      ],
      eventTypes: [
        { organization_id: A, event_type: "school", product_count: 2 },
        { organization_id: A, event_type: "birthday", product_count: 9 },
      ],
    });
    expect(shell.categories).toMatchObject([
      { slug: "bouncers", productCount: 1234, image: { url: "/media/m1", alt: "Castle" } },
    ]);
    expect(shell.eventTypes).toEqual(["birthday", "school"]);
    expect(shell.profile.domains).toEqual([{ hostname: "shop.example.com", isPrimary: true }]);
  });

  it("orders images primary-first, uses the tenant media route, picks the default variant", () => {
    const [p] = assembleProducts(A, {
      products: [productRow()],
      media: [
        {
          id: "m2",
          organization_id: A,
          product_id: "p1",
          kind: "image",
          storage_path: null,
          is_primary: false,
          sort_order: 0,
          alt_text: null,
          width: null,
          height: null,
        },
        {
          id: "m1",
          organization_id: A,
          product_id: "p1",
          kind: "image",
          storage_path: null,
          is_primary: true,
          sort_order: 5,
          alt_text: " Front ",
          width: 800,
          height: 600,
        },
        {
          id: "v",
          organization_id: A,
          product_id: "p1",
          kind: "video",
          storage_path: null,
          is_primary: false,
          sort_order: 0,
          alt_text: null,
          width: null,
          height: null,
        },
      ],
      variants: [variant("var-b", 17500), variant("var-a", 17500, { is_default: true })],
    });
    expect(p?.images.map((i) => i.url)).toEqual(["/media/m1", "/media/m2"]);
    expect(p?.images[0]?.alt).toBe("Front");
    expect(p?.images[0]?.srcSet).toBeNull();
    expect(p?.defaultVariantId).toBe("var-a");
  });

  it("image URLs come from the injected builder (width-bounded srcset when enabled)", () => {
    const [p] = assembleProducts(
      A,
      {
        products: [productRow()],
        media: [
          {
            id: "m1",
            organization_id: A,
            product_id: "p1",
            kind: "image",
            storage_path: null,
            is_primary: true,
            sort_order: 0,
            alt_text: null,
            width: null,
            height: null,
          },
        ],
        variants: [],
      },
      (id) => ({ url: `/media/${id}`, srcSet: `/media/${id}?w=320 320w` }),
    );
    expect(p?.images[0]?.srcSet).toBe("/media/m1?w=320 320w");
  });

  it("related products rank by shared categories", () => {
    const base = product({ ideal_event_types: ["birthday", "school"] });
    const slide = product({ id: "p2", slug: "slide" });
    const other = product({
      id: "p3",
      slug: "other",
      primary_category_id: null,
      category_ids: [],
    });
    expect(relatedProducts([base, slide, other], base).map((p) => p.slug)).toEqual(["slide"]);
    expect(humanize("school_event")).toBe("School event");
  });
});

describe("M2: advertised price comes from bookable variants (what the engine starts from)", () => {
  const card = (p: ReturnType<typeof product>) => priceSummary(p, "USD");

  it("no override → the product base is shown and offered", () => {
    const p = product();
    expect(card(p)).toMatchObject({ prefix: "From", amount: "$175", unit: "per event" });
    expect(p.priceVaries).toBe(false);
    expect(productJsonLd("https://x.test", facts, p, "/rentals/x")).toMatchObject({
      offers: { price: "175.00" },
    });
  });

  it("one active override → the override is shown and offered, never the product base", () => {
    const p = product({}, [variant("v1", 30000, { is_default: true })]);
    expect(card(p)?.amount).toBe("$300");
    expect(productJsonLd("https://x.test", facts, p, "/x")).toMatchObject({
      offers: { price: "300.00" },
    });
    expect(JSON.stringify(productJsonLd("https://x.test", facts, p, "/x"))).not.toContain("175");
  });

  it("several bookable variants with the same price → that single price", () => {
    const p = product({}, [variant("v1", 30000), variant("v2", 30000)]);
    expect(p).toMatchObject({ startingPriceCents: 30000, priceVaries: false });
    expect(productJsonLd("https://x.test", facts, p, "/x")).toHaveProperty("offers");
  });

  it("variants with different prices → 'From' the lowest, and no structured Offer", () => {
    const p = product({}, [variant("v1", 45000), variant("v2", 30000)]);
    expect(card(p)).toMatchObject({ prefix: "From", amount: "$300", varies: true });
    expect(productJsonLd("https://x.test", facts, p, "/x")).not.toHaveProperty("offers");
  });

  it("no bookable variant, or any variant without a price → no price and no Offer", () => {
    for (const p of [
      product({}, []),
      product({}, [variant("v1", 30000), variant("v2", null)]),
      product({ base_price_cents: null }, [variant("v1", null)]),
      product({ base_price_cents: 0 }, [variant("v1", 0)]),
    ]) {
      expect(card(p)).toBeNull();
      expect(productJsonLd("https://x.test", facts, p, "/x")).not.toHaveProperty("offers");
    }
    expect(variantPricing([])).toEqual({ startingPriceCents: null, priceVaries: false });
  });

  it("only per-event pricing is offered; unknown pricing types show no price", () => {
    const hourly = product({ pricing_type: "hourly" }, [variant("v1", 5050)]);
    expect(card(hourly)).toMatchObject({ amount: "$50.50", unit: "per hour", detail: null });
    expect(productJsonLd("https://x.test", facts, hourly, "/x")).not.toHaveProperty("offers");
    expect(card(product({ pricing_type: "mystery" }))).toBeNull();
  });

  it("every price carries the same qualification (prefix + quote qualifier)", () => {
    const shown = [product(), product({}, [variant("a", 100), variant("b", 200)])].map(card);
    for (const s of shown) {
      expect(s?.prefix).toBe("From");
      expect(s?.qualifier).toBe(PRICE_QUALIFIER);
    }
    expect(card(product())?.detail).toBe("up to 4 hours");
  });
});

describe("specifications", () => {
  it("are built from configured fields only (nothing invented for blanks)", () => {
    expect(specGroups(product({}))).toEqual([]);
    const groups = specGroups(
      product({
        dry_allowed: true,
        minimum_age: 3,
        space_length_ft: 15,
        space_width_ft: 15,
        power_outlets_required: 1,
        attendants_required: 1,
        extra_specs: { blower: "1.5 HP", nested: { no: 1 } },
      }),
    );
    expect(groups).toEqual([
      {
        title: "Use",
        specs: [
          { label: "Use", value: "Dry" },
          { label: "Ages", value: "3+ years" },
        ],
      },
      {
        title: "Space & setup",
        specs: [
          { label: "Space needed", value: "15 ft × 15 ft" },
          { label: "Power", value: "1 outlet" },
        ],
      },
      { title: "Staffing", specs: [{ label: "Attendants", value: "1 adult attendant required" }] },
      { title: "Details", specs: [{ label: "Blower", value: "1.5 HP" }] },
    ]);
  });

  it("weather notes come only from configured sensitivities", () => {
    expect(weatherNotes(product({}))).toEqual([]);
    expect(
      weatherNotes(
        product({
          weather_sensitivities: [
            { hazard: "wind", threshold_value: 20, threshold_unit: "mph" },
            { bogus: 1 },
          ],
        }),
      ),
    ).toEqual([
      { hazard: "wind", text: "Weather-sensitive: may not operate in wind over 20 mph." },
    ]);
  });
});

const facts = {
  name: "Acme Rentals",
  currency: "USD",
  phone: "+19015550100",
  email: null,
  logoUrl: null,
};

describe("structured data", () => {
  const origin = "https://rentals.example";

  it("Product never states availability, ratings or reviews", () => {
    const ld = productJsonLd(origin, facts, product(), "/rentals/castle-bouncer");
    expect(ld).toMatchObject({
      "@type": "Product",
      name: "Castle Bouncer",
      url: "https://rentals.example/rentals/castle-bouncer",
      offers: { "@type": "Offer", price: "175.00", priceCurrency: "USD" },
    });
    const json = JSON.stringify(ld);
    for (const key of ["availability", "aggregateRating", "review", "brand", "sku"]) {
      expect(json).not.toContain(key);
    }
  });

  it("LocalBusiness includes address and areas only when configured", () => {
    const bare = assembleShell(A, {
      settings: null,
      domains: [],
      policies: [],
      serviceAreas: [],
      categories: [],
      summaries: [],
      eventTypes: [],
    }).profile;
    const ld = localBusinessJsonLd(origin, facts, bare);
    expect(ld).toMatchObject({
      "@type": "LocalBusiness",
      name: "Acme Rentals",
      telephone: "+19015550100",
    });
    expect(ld).not.toHaveProperty("address");
    expect(ld).not.toHaveProperty("areaServed");
    expect(ld).not.toHaveProperty("email");
    const full = localBusinessJsonLd(origin, facts, {
      ...bare,
      address: { line1: null, city: "Springfield", state: "IL", postalCode: null },
      serviceAreas: ["Springfield"],
    });
    expect(full).toMatchObject({
      address: { "@type": "PostalAddress", addressLocality: "Springfield", addressRegion: "IL" },
      areaServed: [{ "@type": "Place", name: "Springfield" }],
    });
    expect(full.address).not.toHaveProperty("streetAddress");
  });

  it("breadcrumbs are absolute and ordered; serialization cannot break out of the script tag", () => {
    expect(
      breadcrumbJsonLd(origin, [
        { name: "Home", path: "/" },
        { name: "Rentals", path: "/rentals" },
      ]),
    ).toMatchObject({
      itemListElement: [
        { position: 1, item: "https://rentals.example/" },
        { position: 2, item: "https://rentals.example/rentals" },
      ],
    });
    const out = serializeJsonLd({ name: "</script><script>alert(1)</script> & co" });
    expect(out).not.toMatch(/[<>&]/);
    expect(JSON.parse(out)).toEqual({ name: "</script><script>alert(1)</script> & co" });
  });

  it("meta descriptions are single-line and capped", () => {
    expect(metaDescription(null, "  a\n b  ")).toBe("a b");
    expect(metaDescription("")).toBeUndefined();
    const long = metaDescription("word ".repeat(100));
    expect(long?.length).toBeLessThanOrEqual(160);
    expect(long?.endsWith("…")).toBe(true);
  });
});

describe("M1: indexing and canonical URLs depend on the verified request host", () => {
  const primary = { hostname: "shop.example.com", isPrimary: true };
  const alias = { hostname: "www.shop.example.com", isPrimary: false };
  const decide = (
    requestHost: string,
    domains: { hostname: string; isPrimary: boolean }[],
    production = true,
    resolvedBy: "host" | "dev-slug" = "host",
  ) => seoDecision({ production, resolvedBy, requestHost, domains });

  it("verified primary host in production → indexable, canonical on itself (https)", () => {
    const d = decide("shop.example.com", [primary, alias]);
    expect(d).toEqual({
      canonicalOrigin: "https://shop.example.com",
      indexable: true,
      follow: true,
    });
    expect(robotsDirectives(d)).toEqual({ index: true, follow: true });
    expect(robotsRules(d)).toEqual({ userAgent: "*", allow: "/", disallow: PRIVATE_PATHS });
  });

  it("verified alias → noindex,follow; canonical points at the primary; robots.txt closed", () => {
    const d = decide("www.shop.example.com", [primary, alias]);
    expect(d).toEqual({
      canonicalOrigin: "https://shop.example.com",
      indexable: false,
      follow: true,
    });
    expect(robotsDirectives(d)).toEqual({ index: false, follow: true });
    expect(robotsRules(d)).toEqual({ userAgent: "*", disallow: "/" });
  });

  it("unverified alias (a verified primary exists elsewhere) → noindex,nofollow", () => {
    // `domains` holds verified domains only; the request host is not among them.
    const d = decide("unverified.example.net", [primary]);
    expect(d.indexable).toBe(false);
    expect(robotsDirectives(d)).toEqual({ index: false, follow: false });
    expect(d.canonicalOrigin).toBe("https://shop.example.com");
  });

  it("no verified domain at all → no canonical URL, never indexable, closed robots", () => {
    const d = decide("unverified.example.net", []);
    expect(d).toEqual({ canonicalOrigin: null, indexable: false, follow: false });
    expect(robotsRules(d)).toEqual({ userAgent: "*", disallow: "/" });
  });

  it("the canonical is never an unverified hostname (no primary: a verified request host only)", () => {
    expect(decide("evil.example", [alias]).canonicalOrigin).toBeNull();
    expect(decide("www.shop.example.com", [alias])).toMatchObject({
      canonicalOrigin: "https://www.shop.example.com",
      indexable: true,
    });
    expect(decide("<script>", [alias]).canonicalOrigin).toBeNull();
  });

  it("outside production, or via the dev slug, nothing is indexable (canonical still verified)", () => {
    for (const d of [
      decide("shop.example.com", [primary], false),
      decide("shop.example.com", [primary], true, "dev-slug"),
    ]) {
      expect(d.indexable).toBe(false);
      expect(d.canonicalOrigin).toBe("https://shop.example.com");
      expect(robotsRules(d)).toEqual({ userAgent: "*", disallow: "/" });
    }
  });

  it("local development hosts use http and keep the request port", () => {
    expect(
      decide("acme.localhost:3000", [{ hostname: "acme.localhost", isPrimary: true }], false)
        .canonicalOrigin,
    ).toBe("http://acme.localhost:3000");
  });
});

describe("M3: customer-specific pages are private", () => {
  const indexable = { canonicalOrigin: "https://shop.example.com", indexable: true, follow: true };

  it("a private page is noindex,nofollow even on the indexable canonical host", () => {
    expect(robotsDirectives(indexable, true)).toEqual({ index: false, follow: false });
    expect(robotsDirectives(indexable, false)).toEqual({ index: true, follow: true });
  });

  it("robots.txt keeps quote links and token-prefilled forms out", () => {
    expect(PRIVATE_PATHS).toEqual(expect.arrayContaining(["/q/", "/quote?from="]));
  });

  it("the sitemap lists public pages only — never a quote link or a token", () => {
    const paths = sitemapPaths(
      {
        categories: [
          { slug: "bouncers", productCount: 3 },
          { slug: "empty", productCount: 0 },
        ],
        profile: { policies: [{ type: "safety" }] },
      },
      ["castle", "slide"],
    );
    expect(paths).toEqual([
      "/",
      "/rentals",
      "/quote",
      "/categories/bouncers",
      "/rentals/castle",
      "/rentals/slide",
      "/policies/safety",
    ]);
    expect(paths.join(" ")).not.toMatch(/\/q\/|from=|token/);
  });
});

describe("M4: collectPages reads every row even when the server caps a page", () => {
  const source = Array.from({ length: 2345 }, (_, i) => i);
  /** A server whose max_rows is below the requested page size. */
  const capped =
    (maxRows: number) =>
    (from: number, to: number): Promise<number[]> =>
      Promise.resolve(source.slice(from, Math.min(to + 1, from + maxRows)));

  it("pages until an empty page, starting after the rows actually received", async () => {
    expect(await collectPages(capped(1000))).toEqual(source);
    expect(await collectPages(capped(7), { pageSize: 1000 })).toEqual(source);
    expect(await collectPages(() => Promise.resolve([]))).toEqual([]);
  });

  it("refuses to run away", async () => {
    await expect(collectPages(capped(1000), { maxRows: 2000 })).rejects.toThrow(/exceeds/);
  });
});

describe("quote next step", () => {
  const base = {
    status: "sent",
    expired: false,
    stale: false,
    canRequestBooking: true,
    booking: null,
  };
  const pending = { status: "pending", holdActive: true, holdExpiresAt: "2026-10-01T00:00:00Z" };

  it("a stale quote never offers Request booking", () => {
    expect(quoteNextStep({ ...base, stale: true })).toEqual({ kind: "stale" });
    expect(quoteNextStep({ ...base, stale: true, canRequestBooking: true }).kind).toBe("stale");
    expect(STALE_MESSAGE).toBe(
      "Your event details changed, so we need to recalculate availability and pricing.",
    );
  });

  it("expired quotes are re-quoted; fresh ones can be requested", () => {
    expect(quoteNextStep({ ...base, expired: true }).kind).toBe("expired");
    expect(quoteNextStep(base).kind).toBe("request");
    expect(quoteNextStep({ ...base, canRequestBooking: false }).kind).toBe("none");
  });

  it("L1: expiry wins over an unconfirmed pending request (hold active or not)", () => {
    expect(
      quoteNextStep({ ...base, expired: true, booking: { ...pending, holdActive: false } }).kind,
    ).toBe("expired");
    expect(quoteNextStep({ ...base, expired: true, booking: pending }).kind).toBe("expired");
    expect(quoteNextStep({ ...base, status: "expired", booking: pending }).kind).toBe("expired");
  });

  it("a stale pending request cannot be confirmed either → re-quote", () => {
    expect(quoteNextStep({ ...base, stale: true, booking: pending }).kind).toBe("stale");
  });

  it("a live pending request keeps its hold controls; final states always win", () => {
    expect(quoteNextStep({ ...base, booking: pending })).toEqual({
      kind: "holding",
      until: "2026-10-01T00:00:00Z",
    });
    expect(quoteNextStep({ ...base, booking: { ...pending, holdActive: false } }).kind).toBe(
      "awaiting_review",
    );
    expect(quoteNextStep({ ...base, status: "accepted", expired: true, stale: true }).kind).toBe(
      "confirmed",
    );
    expect(
      quoteNextStep({ ...base, expired: true, booking: { ...pending, status: "confirmed" } }).kind,
    ).toBe("confirmed");
    expect(quoteNextStep({ ...base, status: "declined", expired: true })).toEqual({
      kind: "closed",
      status: "declined",
    });
  });
});

describe("quote prefill", () => {
  it("converts instants to the organization's local date and time", () => {
    expect(localDateTime("2026-07-04T17:00:00Z", "America/Chicago")).toEqual({
      date: "2026-07-04",
      time: "12:00",
    });
    expect(localDateTime("not a date", "America/Chicago")).toBeNull();
    expect(localToday("America/Chicago", new Date("2026-07-05T03:00:00Z"))).toBe("2026-07-04");
  });

  it("keeps only offered variants, merges duplicates and caps rows", () => {
    const offered = new Set(["a", "b"]);
    expect(
      normalizeItems(
        [
          { variantId: "a", quantity: 1 },
          { variantId: "x", quantity: 1 },
          { variantId: "a", quantity: 2 },
          { variantId: "b", quantity: 0 },
        ],
        offered,
      ),
    ).toEqual([{ variantId: "a", quantity: 3 }]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      variantId: `v${String(i)}`,
      quantity: 1,
    }));
    expect(normalizeItems(many, new Set(many.map((m) => m.variantId)))).toHaveLength(
      QUOTE_ITEM_ROWS,
    );
  });

  it("prefills items, the event's local window (multi-day end date) and the fulfilment", () => {
    const p = prefillFromQuote(
      {
        items: [
          { variantId: "a", quantity: 2 },
          { variantId: null, quantity: 1 },
        ],
        event: { startsAt: "2026-07-04T15:00:00Z", endsAt: "2026-07-05T21:00:00Z", address: null },
      },
      "America/Chicago",
      new Set(["a"]),
    );
    expect(p).toEqual({
      items: [{ variantId: "a", quantity: 2 }],
      event: { date: "2026-07-04", startTime: "10:00", endTime: "16:00", endDate: "2026-07-05" },
      delivery: "pickup",
    });
    expect(
      prefillFromQuote(
        {
          items: [],
          event: { startsAt: null, endsAt: null, address: "1 Main St, Memphis, TN 38127" },
        },
        "UTC",
        new Set(),
      ).delivery,
    ).toBe("delivery");
    expect(prefillFromQuote({ items: [], event: null }, "UTC", new Set())).toEqual({
      items: [],
      event: null,
    });
  });
});

describe("brand contrast", () => {
  it("picks the readable foreground for the configured brand color", () => {
    expect(readableOn("#ffffff")).toBe("#111827");
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(readableOn("#facc15")).toBe("#111827");
  });
});
