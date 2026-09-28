import { describe, expect, it } from "vitest";
import { productInputSchema } from "@/domain/catalog/schemas";
import { slugify, uniqueSlug } from "@/domain/catalog/slug";
import { resolveRentalConfig } from "@/domain/config/resolve";

describe("slugify", () => {
  it.each([
    ["Tropical Crush Combo!", "tropical-crush-combo"],
    ["Tables & Chairs", "tables-and-chairs"],
    ["  Jurássic   Dino  ", "jurassic-dino"],
    ["!!!", ""],
  ])("%j → %j", (input, slug) => {
    expect(slugify(input)).toBe(slug);
  });
  it("uniqueSlug appends the first free suffix", () => {
    expect(uniqueSlug("castle", new Set(["castle", "castle-2"]))).toBe("castle-3");
    expect(uniqueSlug("slide", new Set())).toBe("slide");
  });
});

describe("productInputSchema", () => {
  const base = { name: "Castle", slug: "castle", basePriceCents: 17500 };

  it("applies safe defaults", () => {
    expect(productInputSchema.parse(base)).toMatchObject({
      isPublished: false,
      dryAllowed: true,
      wetAllowed: false,
      outdoorAllowed: true,
    });
  });

  it.each([
    [{ wetAllowed: false, dryAllowed: false }, "dryAllowed"],
    [{ indoorAllowed: false, outdoorAllowed: false }, "outdoorAllowed"],
    [{ minimumAge: 12, maximumAge: 3 }, "maximumAge"],
    [{ basePriceCents: -1 }, "basePriceCents"],
    [{ basePriceCents: 10.5 }, "basePriceCents"],
    [{ slug: "Not A Slug" }, "slug"],
    [{ allowedSurfaces: ["lava"] }, "allowedSurfaces"],
    [
      { primaryCategoryId: "6a1a3d8e-7a2b-4c1e-9f00-000000000001", categoryIds: [] },
      "primaryCategoryId",
    ],
  ])("rejects %j", (patch, path) => {
    const r = productInputSchema.safeParse({ ...base, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toContain(path);
  });
});

describe("resolveRentalConfig (ADR 0003 override chain)", () => {
  const organization = {
    defaultSetupBufferMinutes: 60,
    defaultTeardownBufferMinutes: 60,
    defaultRentalDurationMinutes: 360,
    minBookingLeadTimeMinutes: 720,
    overnightAllowed: false,
  };

  it("falls back to organization settings", () => {
    expect(resolveRentalConfig({ organization })).toEqual({
      setupBufferMinutes: 60,
      teardownBufferMinutes: 60,
      includedDurationMinutes: 360,
      minBookingLeadTimeMinutes: 720,
      overnightAllowed: false,
    });
  });

  it("category overrides organization (Water Slides = 4 hours)", () => {
    const r = resolveRentalConfig({ organization, category: { includedDurationMinutes: 240 } });
    expect(r.includedDurationMinutes).toBe(240);
  });

  it("product overrides category; variant overrides product for buffers", () => {
    const r = resolveRentalConfig({
      organization,
      category: { setupBufferMinutes: 90, overnightAllowed: true },
      product: { setupBufferMinutes: 30, overnightAllowed: false },
      variant: { setupBufferMinutes: 45 },
    });
    expect(r.setupBufferMinutes).toBe(45);
    expect(r.overnightAllowed).toBe(false);
  });

  it("zero is a real value, not 'inherit'", () => {
    expect(
      resolveRentalConfig({ organization, product: { setupBufferMinutes: 0 } }).setupBufferMinutes,
    ).toBe(0);
  });

  it("uses platform defaults when nothing is configured", () => {
    expect(resolveRentalConfig({})).toMatchObject({
      setupBufferMinutes: 60,
      minBookingLeadTimeMinutes: 720,
    });
  });
});
