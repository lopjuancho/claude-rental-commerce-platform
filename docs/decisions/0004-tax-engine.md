# 0004 — Location-based tax with per-component taxability (D4)

**Status:** Accepted 2026-09-28

## Decision
- Tax jurisdiction is determined from the **event / service location** (full address, state, postal code), not from matching city names in free text. "Germantown" for Tiky Jumps means Germantown, **Tennessee**; the platform never guesses a state.
- No universal or hard-coded tax rate. Rates and taxability are organization configuration.
- Every priced component has a **tax component class**, and taxability is configured per jurisdiction × component class:

  | Component class | Examples |
  |---|---|
  | `rental` | product rental lines, extra hours, overnight, additional days |
  | `delivery` | delivery / mileage fees |
  | `labor` | attendants / operators |
  | `fee` | cleaning, generator, other fees |
  | `discount` | discounts (configurable: reduces taxable base of the lines it applies to, or not) |
  | `adjustment` | manual staff adjustments (taxability chosen per adjustment) |

- Data model (DATABASE.md §8):
  - `tax_jurisdictions` — organization-owned, name, state, match rules (postal codes; later address-level via provider), priority.
  - `tax_rates` — one or more rate components per jurisdiction (e.g. state + local), `rate_bps`.
  - `tax_component_rules` — per jurisdiction × component class: `taxable boolean`.
- Engine: `src/domain/pricing/tax.ts` is pure; it receives the resolved jurisdiction + rules as input. Resolution happens in a `TaxResolver` interface; Phase 1 implementation = configured jurisdictions matched by state + postal code. An external tax-rate provider can implement the same interface later.
- If no jurisdiction matches, pricing returns a `TAX_JURISDICTION_UNRESOLVED` warning, the quote cannot move beyond `draft` without staff review, and the AI must say tax will be confirmed.

## Before production
The exact Tennessee treatment (state + Shelby County/municipal local rates, taxability of delivery, labor and fees, any single-article rules) will be validated separately and entered as Tiky Jumps configuration. Postal codes can straddle municipal boundaries; boundary ZIPs should be flagged for manual review until an address-level provider is used.
