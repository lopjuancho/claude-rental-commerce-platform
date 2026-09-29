# 0013 — Deterministic pricing engine, immutable calculation snapshots, and review-first gaps

**Status:** Accepted 2026-09-29 · Implemented in M4

## Context

Prices are shown to customers by staff, the storefront and (in M7) the AI assistant. A price must be reproducible and auditable. It must not drift when configuration changes later (a quoted $475 must not become $525 because the product changed). Where the tenant has not configured something, the price must not be guessed.

## Decision

1. **Pure engine.** `calculatePrice(input) → PriceResult` (`src/domain/pricing/engine.ts`) has no I/O and no clock reads. All amounts are integer cents; percentages are basis points; rounding is half-up (`divideRoundHalfUp`). The server gathers context (`pricing_context`, `tax_context`, `delivery_area_context` SQL functions, which are tenant-checked by `app.assert_can_act`) and the delivery quote, then calls the engine.
2. **Rule precedence.** A rule's scope decides its specificity: variant > product > category > organization. Ties are broken by `priority`, then by id. Only one rule of each duration type (`extra_hour`, `overnight`, `additional_day`, `attendant_fee`, `minimum_charge`) applies per line. Fees and discounts stack. Included duration and `overnight_allowed` follow the same override chain as the rest of the catalog (variant → product → primary category → organization).
3. **Duration model.** Billable days = max(1, ceil(duration / 24 h)).
   - A single day on the same local date gives base plus extra hours beyond the included duration.
   - A single day that crosses local midnight applies the overnight rule.
   - More than one day gives base plus `additional_day` × (days − 1), e.g. +25 % of base per day.
4. **Missing configuration means review, never $0.** Examples: extra time with no `extra_hour` rule, overnight with no rule or not permitted, delivery that cannot be priced, and an unresolved tax jurisdiction or taxability. Each sets `manual_review_required` with machine-readable reason codes (`src/domain/pricing/reasons.ts` has the staff-facing text). The total shown is then provisional.
5. **Delivery** (ADR 0009) is computed before the engine and passed in as a `DeliveryResult`:
   - Google Routes API road distance, one-way from the depot, with the first N miles free and billable miles rounded up.
   - Results are cached per (org, provider, provider version, sha256 of normalized origin|destination) for at most 30 days.
   - Failures are not cached; they produce `manual_review`.
6. **Tax** (ADR 0004):
   - The jurisdiction is resolved from the event address (the depot for pickups). A state + ZIP match beats a statewide match.
   - Taxability is set per component (rental, add_on, delivery, labor, fee, discount, adjustment) and per jurisdiction. A missing component rule triggers review.
   - Jurisdictions have a `test` / `active` status, and `test` always requires review. No platform-wide rates are seeded.
7. **Snapshots.** `pricing_calculations` stores the full engine input (including every rule and base price used), the output, `sha256(canonicalJson(input))` and the engine version. The table is immutable (trigger). `verifyStoredCalculation` re-runs the engine on the stored input and compares.
   - Rules carry a `revision` that a trigger bumps on every real change. Applied rules are recorded as id + revision.
   - Direct writes to `revision` are ignored.
8. **Public channel.** Unpublished products are NOT_FOUND. Manual adjustments are FORBIDDEN. The AI (M7) may only present totals returned by the engine.

## Consequences

- Rates Tiky Jumps has not provided yet (extra hour, overnight, attendant, tax) show up as review reasons rather than wrong prices. `docs/pricing-review.md` is generated from the real engine and bundle, and CI checks that it stays current.
- Quote (M5) totals will reference a `pricing_calculations` row rather than recomputing.
- Declarative quantity tiers and date surcharges are not implemented. They would be new `pricing_rule_type` values with a Zod schema and a DB CHECK.
