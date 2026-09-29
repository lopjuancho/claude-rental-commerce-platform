import { divideRoundHalfUp, percentOf } from "@/domain/money";
import { codeMatches, isValidOn, parseRuleParams, selectRule, specificity } from "./rules";
import {
  ENGINE_VERSION,
  type PriceLine,
  type PriceResult,
  type PriceSummary,
  type PricingInput,
  type PricingItem,
  type PricingRule,
  type TaxComponent,
  type TaxLine,
} from "./types";

/**
 * The pricing engine (ADR 0013). Pure and deterministic: the same input always yields the same
 * output, with no clock, randomness or I/O. It never guesses: whenever something needed for a
 * safe price is missing it still returns a provisional breakdown but sets
 * manualReviewRequired with machine-readable reasons, and callers (including the assistant) must
 * not present that total as final.
 *
 * Duration model, per item:
 *   billable days = ceil(duration / 24 h), minimum 1
 *   1 day, same local date     → base (+ extra hours beyond the included duration)
 *   1 day, crosses midnight    → base + overnight rule (no extra hours)
 *   > 1 day                    → base + additional-day rule × (days − 1)
 */

const MINUTE = 60_000;

function localDate(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
}

interface ItemCharges {
  item: PricingItem;
  lines: PriceLine[];
  /** Charges discounts may apply to (base, time-based charges). */
  discountableCents: number;
}

export function calculatePrice(input: PricingInput): PriceResult {
  const reviewReasons = new Set<string>();
  const warnings = new Set<string>();
  const applied = new Map<string, PricingRule>();
  const rules = [...input.rules].sort((a, b) => a.id.localeCompare(b.id));
  const codes = input.discountCodes.map((c) => c.trim()).filter(Boolean);

  const markApplied = (rule: PricingRule) => {
    applied.set(rule.id, rule);
    return rule;
  };
  const invalidRule = (rule: PricingRule) => {
    reviewReasons.add(`RULE_INVALID:${rule.id}`);
  };

  if (input.items.length === 0) reviewReasons.add("NO_ITEMS");

  const itemCharges: ItemCharges[] = [];
  for (const item of input.items) {
    const component: TaxComponent = item.kind === "add_on" ? "add_on" : "rental";
    const lines: PriceLine[] = [];
    const push = (
      line: Omit<PriceLine, "lineId" | "component" | "taxable"> & { component?: TaxComponent },
    ) => {
      lines.push({
        lineId: item.lineId,
        taxable: null,
        ...line,
        component: line.component ?? component,
      });
    };

    const start = Date.parse(item.start);
    const end = Date.parse(item.end);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      !Number.isSafeInteger(item.quantity) ||
      item.quantity < 1
    ) {
      reviewReasons.add(`INVALID_ITEM:${item.lineId}`);
      continue;
    }
    if (!item.active) reviewReasons.add(`ITEM_UNAVAILABLE:${item.lineId}`);

    const qty = item.quantity;
    const durationMinutes = Math.round((end - start) / MINUTE);
    const billableDays = Math.max(1, Math.ceil(durationMinutes / 1440));
    const startDate = localDate(start, input.timeZone);
    const crossesMidnight = localDate(end - 1, input.timeZone) !== startDate;

    push({
      kind: "base",
      label: item.name,
      quantity: qty,
      amountCents: item.basePriceCents * qty,
      ruleId: null,
      ruleRevision: null,
    });
    let discountable = item.basePriceCents * qty;

    if (billableDays > 1) {
      const rule = selectRule(rules, "additional_day", item, startDate, codes);
      const params = rule ? parseRuleParams("additional_day", rule.params) : null;
      if (!rule) {
        reviewReasons.add(`ADDITIONAL_DAY_PRICING_NOT_CONFIGURED:${item.lineId}`);
      } else if (!params) {
        invalidRule(rule);
      } else {
        markApplied(rule);
        const extraDays = billableDays - 1;
        const perDay =
          "amount_cents" in params
            ? params.amount_cents
            : percentOf(item.basePriceCents, params.percent_of_base_bps);
        const amount = perDay * extraDays * qty;
        push({
          kind: "additional_days",
          label: `${item.name}: ${extraDays} additional day${extraDays === 1 ? "" : "s"}`,
          quantity: qty,
          amountCents: amount,
          ruleId: rule.id,
          ruleRevision: rule.revision,
        });
        discountable += amount;
      }
    } else if (crossesMidnight) {
      if (!item.overnightAllowed) {
        reviewReasons.add(`OVERNIGHT_NOT_PERMITTED:${item.lineId}`);
      }
      const rule = selectRule(rules, "overnight", item, startDate, codes);
      const params = rule ? parseRuleParams("overnight", rule.params) : null;
      if (!rule) {
        reviewReasons.add(`OVERNIGHT_PRICING_NOT_CONFIGURED:${item.lineId}`);
      } else if (!params) {
        invalidRule(rule);
      } else {
        markApplied(rule);
        const unit =
          "amount_cents" in params
            ? params.amount_cents
            : percentOf(item.basePriceCents, params.percent_of_base_bps);
        push({
          kind: "overnight",
          label: `${item.name}: overnight`,
          quantity: qty,
          amountCents: unit * qty,
          ruleId: rule.id,
          ruleRevision: rule.revision,
        });
        discountable += unit * qty;
      }
    } else if (durationMinutes > item.includedDurationMinutes) {
      const rule = selectRule(rules, "extra_hour", item, startDate, codes);
      const params = rule ? parseRuleParams("extra_hour", rule.params) : null;
      if (!rule) {
        reviewReasons.add(`EXTRA_HOURS_PRICING_NOT_CONFIGURED:${item.lineId}`);
      } else if (!params) {
        invalidRule(rule);
      } else {
        markApplied(rule);
        const increments = Math.ceil(
          (durationMinutes - item.includedDurationMinutes) / params.increment_minutes,
        );
        const amount = params.amount_cents * increments * qty;
        const unit = params.increment_minutes === 60 ? "hour" : `${params.increment_minutes} min`;
        push({
          kind: "extra_hours",
          label: `${item.name}: ${increments} extra ${unit}${increments === 1 ? "" : "s"}`,
          quantity: qty,
          amountCents: amount,
          ruleId: rule.id,
          ruleRevision: rule.revision,
        });
        discountable += amount;
      }
    }

    if (item.attendantsRequired > 0) {
      const rule = selectRule(rules, "attendant_fee", item, startDate, codes);
      const params = rule ? parseRuleParams("attendant_fee", rule.params) : null;
      if (!rule) {
        reviewReasons.add(`ATTENDANT_PRICING_NOT_CONFIGURED:${item.lineId}`);
      } else if (!params) {
        invalidRule(rule);
      } else {
        markApplied(rule);
        const hours = params.per === "hour" ? Math.ceil(durationMinutes / 60) : 1;
        const amount = params.amount_cents * hours * item.attendantsRequired * qty;
        push({
          kind: "labor",
          label: `${item.name}: ${item.attendantsRequired} attendant${item.attendantsRequired === 1 ? "" : "s"}${params.per === "hour" ? ` × ${hours} h` : ""}`,
          quantity: qty,
          amountCents: amount,
          component: "labor",
          ruleId: rule.id,
          ruleRevision: rule.revision,
        });
      }
    }

    for (const rule of rules.filter(
      (r) => r.type === "fee" && specificity(r, item) > 0 && isValidOn(r, startDate),
    )) {
      const params = parseRuleParams("fee", rule.params);
      if (!params) {
        invalidRule(rule);
        continue;
      }
      if (params.per !== "unit") continue; // per-order fees are added once below
      markApplied(rule);
      push({
        kind: "fee",
        label: params.label ?? rule.name,
        quantity: qty,
        amountCents: params.amount_cents * qty,
        component: "fee",
        ruleId: rule.id,
        ruleRevision: rule.revision,
      });
    }

    itemCharges.push({ item, lines, discountableCents: discountable });
  }

  const lines: PriceLine[] = itemCharges.flatMap((c) => c.lines);
  const firstDate = itemCharges[0]
    ? localDate(Date.parse(itemCharges[0].item.start), input.timeZone)
    : "";

  // Per-order fees: once per order if any item is in scope.
  for (const rule of rules.filter((r) => r.type === "fee")) {
    const params = parseRuleParams("fee", rule.params);
    if (!params || params.per !== "order") continue;
    if (!itemCharges.some((c) => specificity(rule, c.item) > 0) || !isValidOn(rule, firstDate))
      continue;
    markApplied(rule);
    lines.push({
      kind: "fee",
      label: params.label ?? rule.name,
      lineId: null,
      quantity: 1,
      amountCents: params.amount_cents,
      component: "fee",
      taxable: null,
      ruleId: rule.id,
      ruleRevision: rule.revision,
    });
  }

  // Discounts: each applicable rule is computed on its in-scope discountable charges; the total can
  // never exceed what is discountable. Code-only rules apply only when that code was entered.
  const eligibleTotal = itemCharges.reduce((s, c) => s + c.discountableCents, 0);
  let discountTotal = 0;
  const discountRules = rules
    .filter(
      (r) =>
        (r.type === "discount_percent" || r.type === "discount_fixed") &&
        isValidOn(r, firstDate) &&
        codeMatches(r, codes),
    )
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const rule of discountRules) {
    const inScope = itemCharges.filter((c) => specificity(rule, c.item) > 0);
    if (inScope.length === 0) continue;
    const base = inScope.reduce((s, c) => s + c.discountableCents, 0);
    let amount: number;
    if (rule.type === "discount_percent") {
      const params = parseRuleParams("discount_percent", rule.params);
      if (!params) {
        invalidRule(rule);
        continue;
      }
      const scopeQty = inScope.reduce((s, c) => s + c.item.quantity, 0);
      if (params.min_quantity !== undefined && scopeQty < params.min_quantity) continue;
      amount = percentOf(base, params.percent_bps);
    } else {
      const params = parseRuleParams("discount_fixed", rule.params);
      if (!params) {
        invalidRule(rule);
        continue;
      }
      amount = Math.min(params.amount_cents, base);
    }
    amount = Math.min(amount, eligibleTotal - discountTotal);
    if (amount <= 0) continue;
    discountTotal += amount;
    markApplied(rule);
    lines.push({
      kind: "discount",
      label: rule.name,
      lineId: null,
      quantity: 1,
      amountCents: -amount,
      component: "discount",
      taxable: null,
      ruleId: rule.id,
      ruleRevision: rule.revision,
    });
  }
  for (const code of codes) {
    if (
      !rules.some(
        (r) => r.discountCode?.toLowerCase() === code.toLowerCase() && isValidOn(r, firstDate),
      )
    ) {
      warnings.add(`DISCOUNT_CODE_NOT_APPLICABLE:${code.toUpperCase()}`);
    }
  }

  // Minimum rental charge (organization-level), after discounts.
  const minimumRule = rules
    .filter(
      (r) =>
        r.type === "minimum_charge" &&
        !r.categoryId &&
        !r.productId &&
        !r.variantId &&
        isValidOn(r, firstDate),
    )
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))[0];
  if (minimumRule && itemCharges.length > 0) {
    const params = parseRuleParams("minimum_charge", minimumRule.params);
    if (!params) invalidRule(minimumRule);
    else {
      const rentalNet = eligibleTotal - discountTotal;
      if (rentalNet < params.amount_cents) {
        markApplied(minimumRule);
        lines.push({
          kind: "minimum_charge",
          label: minimumRule.name,
          lineId: null,
          quantity: 1,
          amountCents: params.amount_cents - rentalNet,
          component: "fee",
          taxable: null,
          ruleId: minimumRule.id,
          ruleRevision: minimumRule.revision,
        });
      }
    }
  }

  // Delivery.
  if (input.delivery.status === "priced") {
    lines.push({
      kind: "delivery",
      label: input.delivery.label,
      lineId: null,
      quantity: 1,
      amountCents: input.delivery.feeCents,
      component: "delivery",
      taxable: null,
      ruleId: input.delivery.serviceAreaId,
      ruleRevision: input.delivery.serviceAreaRevision,
    });
  } else if (input.delivery.status === "manual_review") {
    reviewReasons.add(`DELIVERY:${input.delivery.reason}`);
  }

  // Manual adjustments (staff).
  for (const adj of input.adjustments) {
    if (!Number.isSafeInteger(adj.amountCents)) {
      reviewReasons.add("INVALID_ADJUSTMENT");
      continue;
    }
    lines.push({
      kind: "adjustment",
      label: adj.label,
      lineId: null,
      quantity: 1,
      amountCents: adj.amountCents,
      component: "adjustment",
      taxable: null,
      ruleId: null,
      ruleRevision: null,
    });
  }

  // Tax: jurisdiction from the event address; taxability per component; one rounding per rate.
  const taxLines: TaxLine[] = [];
  let taxableSubtotal = 0;
  let taxInfo: PriceResult["tax"] = null;
  if (input.tax.status === "unresolved") {
    if (lines.length > 0) reviewReasons.add("TAX_JURISDICTION_UNRESOLVED");
  } else {
    const t = input.tax;
    taxInfo = {
      jurisdictionId: t.jurisdiction.id,
      revision: t.jurisdiction.revision,
      name: t.jurisdiction.name,
      status: t.jurisdiction.status,
    };
    if (t.jurisdiction.status === "test") {
      reviewReasons.add("TAX_TEST_CONFIGURATION");
      warnings.add("TAX_TEST_CONFIGURATION");
    }
    if (t.jurisdiction.boundaryReview) reviewReasons.add("TAX_BOUNDARY_REVIEW");
    if (t.rates.length === 0) reviewReasons.add("TAX_RATES_NOT_CONFIGURED");
    for (const line of lines) {
      const taxable = t.taxability[line.component];
      if (taxable === undefined) {
        reviewReasons.add(`TAX_TAXABILITY_NOT_CONFIGURED:${line.component}`);
        line.taxable = null;
      } else {
        line.taxable = taxable;
        if (taxable) taxableSubtotal += line.amountCents;
      }
    }
    taxableSubtotal = Math.max(0, taxableSubtotal);
    for (const rate of t.rates) {
      taxLines.push({
        rateId: rate.id,
        name: rate.name,
        rateBps: rate.rateBps,
        taxableBaseCents: taxableSubtotal,
        amountCents: divideRoundHalfUp(taxableSubtotal * rate.rateBps, 10_000),
      });
    }
  }

  const sum = (pred: (l: PriceLine) => boolean) =>
    lines.filter(pred).reduce((s, l) => s + l.amountCents, 0);
  const rentalOnly = (kind: PriceLine["kind"]) => (l: PriceLine) =>
    l.kind === kind && l.component === "rental";
  const subtotal = sum(() => true);
  const tax = taxLines.reduce((s, l) => s + l.amountCents, 0);
  const manualReviewRequired = reviewReasons.size > 0;

  const summary: PriceSummary = {
    base: sum(rentalOnly("base")),
    extra_hours: sum(rentalOnly("extra_hours")),
    overnight: sum(rentalOnly("overnight")),
    additional_days: sum(rentalOnly("additional_days")),
    quantity: itemCharges
      .filter((c) => c.item.kind === "rental")
      .reduce((s, c) => s + c.item.quantity, 0),
    add_ons: sum((l) => l.component === "add_on"),
    labor: sum((l) => l.component === "labor"),
    fees: sum((l) => l.component === "fee"),
    delivery: sum((l) => l.component === "delivery"),
    discounts: sum((l) => l.component === "discount"),
    adjustments: sum((l) => l.component === "adjustment"),
    subtotal,
    taxable_subtotal: taxableSubtotal,
    tax,
    total: subtotal + tax,
    manual_review_required: manualReviewRequired,
  };

  return {
    engineVersion: ENGINE_VERSION,
    currency: input.currency,
    lines,
    taxLines,
    summary,
    manualReviewRequired,
    reviewReasons: [...reviewReasons].sort(),
    warnings: [...warnings].sort(),
    appliedRules: [...applied.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => ({ id: r.id, revision: r.revision, type: r.type, name: r.name })),
    tax: taxInfo,
    delivery: input.delivery,
  };
}

/** Stable JSON (sorted keys) used for input hashing and reproducibility checks. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
