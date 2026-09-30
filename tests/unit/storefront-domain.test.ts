import { describe, expect, it } from "vitest";
import { readableOn } from "@/components/tenant-theme";
import {
  assembleStorefront,
  eventTypesOf,
  humanize,
  type ProductRow,
  relatedProducts,
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
  canonicalOrigin,
  localBusinessJsonLd,
  metaDescription,
  productJsonLd,
  serializeJsonLd,
} from "@/domain/storefront/seo";

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

const empty = {
  settings: null,
  policies: [],
  serviceAreas: [],
  categories: [],
  products: [],
  media: [],
  variants: [],
};

function store(
  products: ProductRow[],
  over: Partial<Parameters<typeof assembleStorefront>[1]> = {},
) {
  return assembleStorefront(A, {
    ...empty,
    categories: [
      {
        id: "c1",
        organization_id: A,
        name: "Bouncers",
        slug: "bouncers",
        description: null,
        sort_order: 0,
      },
    ],
    products,
    ...over,
  } as Parameters<typeof assembleStorefront>[1]);
}

describe("assembleStorefront", () => {
  it("drops every row that belongs to another organization", () => {
    const s = store([productRow(), productRow({ id: "p2", organization_id: B, slug: "theirs" })], {
      policies: [
        {
          id: "x",
          organization_id: B,
          policy_type: "safety",
          title: "T",
          body: "B",
          version: 1,
          updated_at: null,
        },
      ],
      serviceAreas: [{ organization_id: B, name: "Elsewhere", priority: 1 }],
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
    } as never);
    expect(s.products.map((p) => p.slug)).toEqual(["castle-bouncer"]);
    expect(s.profile.policies).toEqual([]);
    expect(s.profile.serviceAreas).toEqual([]);
    expect(s.profile.address.line1).toBeNull();
    expect(s.profile.primaryHostname).toBeNull();
  });

  it("only links products to published categories and counts them", () => {
    const s = store([productRow({ category_ids: ["c1", "unpublished"] })]);
    expect(s.products[0]?.categoryIds).toEqual(["c1"]);
    expect(s.categories).toMatchObject([{ slug: "bouncers", productCount: 1 }]);
  });

  it("orders images primary-first, uses the tenant media route, and picks the default variant", () => {
    const s = store([productRow()], {
      media: [
        {
          id: "m2",
          organization_id: A,
          product_id: "p1",
          kind: "image",
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
          is_primary: false,
          sort_order: 0,
          alt_text: null,
          width: null,
          height: null,
        },
      ],
      variants: [
        { id: "var-b", organization_id: A, product_id: "p1", name: "B", is_default: false },
        { id: "var-a", organization_id: A, product_id: "p1", name: "A", is_default: true },
      ],
    } as never);
    const p = s.products[0];
    expect(p?.images.map((i) => i.url)).toEqual(["/media/m1", "/media/m2"]);
    expect(p?.images[0]?.alt).toBe("Front");
    expect(p?.defaultVariantId).toBe("var-a");
  });

  it("event types and related products come only from configured data", () => {
    const s = store([
      productRow({ ideal_event_types: ["birthday", "school_event"] }),
      productRow({ id: "p2", slug: "slide", ideal_event_types: ["birthday"] }),
      productRow({ id: "p3", slug: "other", primary_category_id: null, category_ids: [] }),
    ]);
    expect(eventTypesOf(s.products)).toEqual(["birthday", "school_event"]);
    const [first] = s.products;
    if (!first) throw new Error("missing product");
    expect(relatedProducts(s.products, first).map((p) => p.slug)).toEqual(["slide"]);
    expect(humanize("school_event")).toBe("School event");
  });
});

describe("price and specification presentation", () => {
  const product = (over: Partial<ProductRow>) => store([productRow(over)]).products[0]!;

  it("shows only a configured, positive base rate with its unit and the quote qualifier", () => {
    expect(priceSummary(product({}), "USD")).toEqual({
      amount: "$175",
      unit: "per event",
      detail: "up to 4 hours",
      qualifier: PRICE_QUALIFIER,
    });
    expect(
      priceSummary(product({ pricing_type: "hourly", base_price_cents: 5050 }), "USD"),
    ).toMatchObject({
      amount: "$50.50",
      unit: "per hour",
      detail: null,
    });
    expect(priceSummary(product({ base_price_cents: null }), "USD")).toBeNull();
    expect(priceSummary(product({ base_price_cents: 0 }), "USD")).toBeNull();
    expect(priceSummary(product({ pricing_type: "mystery" }), "USD")).toBeNull();
  });

  it("builds spec groups from configured fields only (nothing invented for blanks)", () => {
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

describe("structured data", () => {
  const origin = "https://rentals.example";
  const tenant = {
    name: "Acme Rentals",
    currency: "USD",
    phone: "+19015550100",
    email: null,
    logoUrl: null,
  };
  const product = (over: Partial<ProductRow>) => store([productRow(over)]).products[0]!;

  it("Product has an Offer only for a configured per-event price and never availability or ratings", () => {
    const ld = productJsonLd(origin, tenant, product({}), "/rentals/castle-bouncer");
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
    expect(
      productJsonLd(origin, tenant, product({ pricing_type: "hourly" }), "/x"),
    ).not.toHaveProperty("offers");
    expect(
      productJsonLd(origin, tenant, product({ base_price_cents: null }), "/x"),
    ).not.toHaveProperty("offers");
  });

  it("LocalBusiness includes address and areas only when configured", () => {
    const bare = store([]).profile;
    const ld = localBusinessJsonLd(origin, tenant, bare);
    expect(ld).toMatchObject({
      "@type": "LocalBusiness",
      name: "Acme Rentals",
      telephone: "+19015550100",
    });
    expect(ld).not.toHaveProperty("address");
    expect(ld).not.toHaveProperty("areaServed");
    expect(ld).not.toHaveProperty("email");
    const full = localBusinessJsonLd(origin, tenant, {
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

describe("canonical origin", () => {
  it("prefers the verified primary domain over the request host, always https", () => {
    expect(canonicalOrigin("rentals.example.com", "tenant.platform.test")).toBe(
      "https://rentals.example.com",
    );
    expect(canonicalOrigin(null, "tenant.platform.test:443")).toBe("https://tenant.platform.test");
  });
  it("keeps http and the port for local development hosts", () => {
    expect(canonicalOrigin("acme.localhost", "acme.localhost:3000")).toBe(
      "http://acme.localhost:3000",
    );
    expect(canonicalOrigin(null, "localhost:3000")).toBe("http://localhost:3000");
  });
  it("never echoes a malformed Host header", () => {
    expect(canonicalOrigin(null, "evil.example/<script>")).toBe("http://localhost");
    expect(canonicalOrigin("shop.example.com", "evil.example")).toBe("https://shop.example.com");
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

  it("a stale quote never offers Request booking", () => {
    expect(quoteNextStep({ ...base, stale: true })).toEqual({ kind: "stale" });
    // Even if the server's flag were inconsistent, stale wins over request.
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

  it("a request already with the team keeps its hold controls; final states win", () => {
    const pending = { status: "pending", holdActive: true, holdExpiresAt: "2026-10-01T00:00:00Z" };
    expect(quoteNextStep({ ...base, stale: true, booking: pending })).toEqual({
      kind: "holding",
      until: "2026-10-01T00:00:00Z",
    });
    expect(quoteNextStep({ ...base, booking: { ...pending, holdActive: false } }).kind).toBe(
      "awaiting_review",
    );
    expect(quoteNextStep({ ...base, status: "accepted", stale: true }).kind).toBe("confirmed");
    expect(quoteNextStep({ ...base, status: "declined" })).toEqual({
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

  it("prefills from an earlier quote with its event's local window (multi-day keeps the end date)", () => {
    const p = prefillFromQuote(
      {
        items: [
          { variantId: "a", quantity: 2 },
          { variantId: null, quantity: 1 },
        ],
        event: { startsAt: "2026-07-04T15:00:00Z", endsAt: "2026-07-05T21:00:00Z" },
      },
      "America/Chicago",
      new Set(["a"]),
    );
    expect(p).toEqual({
      items: [{ variantId: "a", quantity: 2 }],
      event: { date: "2026-07-04", startTime: "10:00", endTime: "16:00", endDate: "2026-07-05" },
    });
    expect(prefillFromQuote({ items: [], event: null }, "UTC", new Set()).event).toBeNull();
  });
});

describe("brand contrast", () => {
  it("picks the readable foreground for the configured brand color", () => {
    expect(readableOn("#ffffff")).toBe("#111827");
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(readableOn("#facc15")).toBe("#111827");
  });
});
