import type { ThresholdUnit, WeatherHazard } from "./hazards";

export interface HazardRule {
  hazard: WeatherHazard;
  sensitive: boolean;
  thresholdValue: number | null;
  thresholdUnit: ThresholdUnit | null;
}

export interface EffectiveHazardRule extends HazardRule {
  /** Where the sensitivity decision came from. */
  source: "product" | "category" | "organization";
}

/**
 * Effective hazard rules for one product. Most specific level wins per hazard
 * (product → primary category → organization); a threshold is inherited from a less specific
 * level when the winning level declares sensitivity without one. Hazards with no rule at any
 * level are absent (= not sensitive). Mirrors SQL app.product_hazard_rules.
 */
export function resolveHazardRules(levels: {
  organization?: readonly HazardRule[];
  category?: readonly HazardRule[];
  product?: readonly HazardRule[];
}): EffectiveHazardRule[] {
  const ordered: [EffectiveHazardRule["source"], readonly HazardRule[]][] = [
    ["product", levels.product ?? []],
    ["category", levels.category ?? []],
    ["organization", levels.organization ?? []],
  ];
  const hazards = new Set(ordered.flatMap(([, rules]) => rules.map((r) => r.hazard)));
  const result: EffectiveHazardRule[] = [];
  for (const hazard of hazards) {
    const chain = ordered.flatMap(([source, rules]) =>
      rules.filter((r) => r.hazard === hazard).map((r) => ({ ...r, source })),
    );
    const winner = chain[0];
    if (!winner) continue;
    const withThreshold = chain.find((r) => r.thresholdValue !== null);
    result.push({
      hazard,
      sensitive: winner.sensitive,
      source: winner.source,
      thresholdValue: withThreshold?.thresholdValue ?? null,
      thresholdUnit: withThreshold?.thresholdUnit ?? null,
    });
  }
  return result.sort((a, b) => a.hazard.localeCompare(b.hazard));
}

export interface WeatherBlockLike {
  hazard: WeatherHazard;
  /** all_sensitive: every product sensitive to the hazard; selected: listed products/categories only. */
  scope: "all_sensitive" | "selected";
  observedValue: number | null;
  observedUnit: ThresholdUnit | null;
  targeted: boolean;
}

/**
 * Whether a confirmed weather block makes a product unavailable (ADR 0010, M3).
 * - Selected scope: listed products/categories are blocked regardless of sensitivity (a staff decision).
 * - All-sensitive scope: only products sensitive to the hazard. If the block records an observed
 *   value in the same unit as the product's threshold, the product is blocked only when
 *   observed ≥ threshold; otherwise (no value, no threshold, or different units) it is blocked.
 */
export function isBlockedByWeather(
  block: WeatherBlockLike,
  rules: readonly EffectiveHazardRule[],
): boolean {
  if (block.scope === "selected") return block.targeted;
  const rule = rules.find((r) => r.hazard === block.hazard);
  if (!rule?.sensitive) return false;
  if (
    block.observedValue === null ||
    rule.thresholdValue === null ||
    block.observedUnit !== rule.thresholdUnit
  )
    return true;
  return block.observedValue >= rule.thresholdValue;
}
