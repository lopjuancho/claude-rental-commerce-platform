import { z } from "zod";
import type { PricingItem, PricingRule, PricingRuleType } from "./types";

const cents = z.int().min(0).max(100_000_000);
const bps = z.int().min(0).max(100_000); // up to 1000 %

/** Parameter schema per rule type (the database CHECK enforces the same required keys). */
export const RULE_PARAM_SCHEMAS = {
  extra_hour: z.object({
    amount_cents: cents,
    increment_minutes: z.int().min(1).max(1440).default(60),
  }),
  overnight: z.union([
    z.object({ amount_cents: cents }).strict(),
    z.object({ percent_of_base_bps: bps }).strict(),
  ]),
  additional_day: z.union([
    z.object({ amount_cents: cents }).strict(),
    z.object({ percent_of_base_bps: bps }).strict(),
  ]),
  attendant_fee: z.object({ amount_cents: cents, per: z.enum(["event", "hour"]) }),
  fee: z.object({
    amount_cents: cents,
    per: z.enum(["order", "unit"]),
    label: z.string().max(120).optional(),
  }),
  discount_percent: z.object({
    percent_bps: z.int().min(0).max(10_000),
    min_quantity: z.int().min(1).optional(),
  }),
  discount_fixed: z.object({ amount_cents: cents }),
  minimum_charge: z.object({ amount_cents: cents }),
} satisfies Record<PricingRuleType, z.ZodType>;

export type RuleParams<T extends PricingRuleType> = z.infer<(typeof RULE_PARAM_SCHEMAS)[T]>;

export function parseRuleParams<T extends PricingRuleType>(
  type: T,
  params: unknown,
): RuleParams<T> | null {
  const result = RULE_PARAM_SCHEMAS[type].safeParse(params);
  return result.success ? (result.data as RuleParams<T>) : null;
}

/** Specificity (ADR 0003): variant 4 > product 3 > category 2 > organization 1; 0 = not applicable. */
export function specificity(rule: PricingRule, item: PricingItem): number {
  if (rule.variantId) return rule.variantId === item.variantId ? 4 : 0;
  if (rule.productId) return rule.productId === item.productId ? 3 : 0;
  if (rule.categoryId)
    return item.categoryIds.includes(rule.categoryId) || rule.categoryId === item.primaryCategoryId
      ? 2
      : 0;
  return 1;
}

export function isValidOn(rule: PricingRule, localDate: string): boolean {
  return (
    (!rule.validFrom || rule.validFrom <= localDate) && (!rule.validTo || rule.validTo >= localDate)
  );
}

export function codeMatches(rule: PricingRule, codes: readonly string[]): boolean {
  return (
    rule.discountCode === null ||
    codes.some((c) => c.toLowerCase() === rule.discountCode?.toLowerCase())
  );
}

/** Deterministic ordering: most specific, then highest priority, then id. */
export function byPrecedence(item: PricingItem) {
  return (a: PricingRule, b: PricingRule) =>
    specificity(b, item) - specificity(a, item) ||
    b.priority - a.priority ||
    a.id.localeCompare(b.id);
}

/** The single applicable rule of a type for an item (single-valued types). */
export function selectRule(
  rules: readonly PricingRule[],
  type: PricingRuleType,
  item: PricingItem,
  localDate: string,
  codes: readonly string[],
) {
  return rules
    .filter(
      (r) =>
        r.type === type &&
        specificity(r, item) > 0 &&
        isValidOn(r, localDate) &&
        codeMatches(r, codes),
    )
    .sort(byPrecedence(item))[0];
}
