import { describe, expect, it } from "vitest";
import { hazardRuleInputSchema } from "@/domain/weather/hazards";
import { type HazardRule, isBlockedByWeather, resolveHazardRules } from "@/domain/weather/resolve";

const wind = (sensitive: boolean, thresholdValue: number | null = null): HazardRule => ({
  hazard: "wind",
  sensitive,
  thresholdValue,
  thresholdUnit: thresholdValue === null ? null : "mph",
});

describe("resolveHazardRules", () => {
  it("inflatable category: wind sensitive at 15 mph", () => {
    expect(resolveHazardRules({ category: [wind(true, 15)] })).toEqual([
      {
        hazard: "wind",
        sensitive: true,
        thresholdValue: 15,
        thresholdUnit: "mph",
        source: "category",
      },
    ]);
  });

  it("tents with no rule anywhere are not sensitive (the inflatable rule is not assumed)", () => {
    expect(resolveHazardRules({ category: [] })).toEqual([]);
  });

  it("trackless train category explicitly not wind sensitive beats an organization default", () => {
    const [rule] = resolveHazardRules({ organization: [wind(true, 25)], category: [wind(false)] });
    expect(rule).toMatchObject({ sensitive: false, source: "category" });
  });

  it("product (manufacturer) rule overrides the category", () => {
    const [rule] = resolveHazardRules({ category: [wind(true, 15)], product: [wind(true, 20)] });
    expect(rule).toMatchObject({ sensitive: true, thresholdValue: 20, source: "product" });
  });

  it("product can opt out entirely", () => {
    const [rule] = resolveHazardRules({ category: [wind(true, 15)], product: [wind(false)] });
    expect(rule?.sensitive).toBe(false);
  });

  it("sensitivity without a threshold inherits the category threshold", () => {
    const [rule] = resolveHazardRules({ category: [wind(true, 15)], product: [wind(true)] });
    expect(rule).toMatchObject({ thresholdValue: 15, source: "product" });
  });

  it("resolves each hazard independently", () => {
    const rules = resolveHazardRules({
      category: [
        wind(true, 15),
        { hazard: "lightning", sensitive: true, thresholdValue: null, thresholdUnit: null },
      ],
      product: [
        {
          hazard: "temperature",
          sensitive: true,
          thresholdValue: 100,
          thresholdUnit: "fahrenheit",
        },
      ],
    });
    expect(rules.map((r) => r.hazard)).toEqual(["lightning", "temperature", "wind"]);
  });
});

describe("isBlockedByWeather", () => {
  const rules = resolveHazardRules({ category: [wind(true, 15)] });
  const block = (patch: Partial<Parameters<typeof isBlockedByWeather>[0]> = {}) => ({
    hazard: "wind" as const,
    scope: "all_sensitive" as const,
    observedValue: null,
    observedUnit: null,
    targeted: false,
    ...patch,
  });

  it("blocks sensitive products when no observed value is recorded", () => {
    expect(isBlockedByWeather(block(), rules)).toBe(true);
  });
  it("respects the product's threshold when an observed value is recorded", () => {
    expect(isBlockedByWeather(block({ observedValue: 12, observedUnit: "mph" }), rules)).toBe(
      false,
    );
    expect(isBlockedByWeather(block({ observedValue: 15, observedUnit: "mph" }), rules)).toBe(true);
  });
  it("is conservative when units differ", () => {
    expect(isBlockedByWeather(block({ observedValue: 5, observedUnit: "kph" }), rules)).toBe(true);
  });
  it("does not affect products insensitive to the hazard", () => {
    expect(isBlockedByWeather(block({ hazard: "lightning" }), rules)).toBe(false);
    expect(isBlockedByWeather(block(), resolveHazardRules({ category: [wind(false)] }))).toBe(
      false,
    );
  });
  it("selected scope blocks exactly the targeted items regardless of sensitivity", () => {
    expect(
      isBlockedByWeather(block({ hazard: "custom", scope: "selected", targeted: true }), []),
    ).toBe(true);
    expect(
      isBlockedByWeather(block({ hazard: "custom", scope: "selected", targeted: false }), rules),
    ).toBe(false);
  });
});

describe("hazardRuleInputSchema", () => {
  it("requires value and unit together", () => {
    expect(
      hazardRuleInputSchema.safeParse({ hazard: "wind", sensitive: true, thresholdValue: 15 })
        .success,
    ).toBe(false);
    expect(
      hazardRuleInputSchema.safeParse({
        hazard: "wind",
        sensitive: true,
        thresholdValue: 15,
        thresholdUnit: "mph",
      }).success,
    ).toBe(true);
    expect(hazardRuleInputSchema.safeParse({ hazard: "hail", sensitive: true }).success).toBe(
      false,
    );
  });
});
