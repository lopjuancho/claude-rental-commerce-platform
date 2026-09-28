# 0003 — Rental rules are tenant configuration with an override hierarchy (D3)

**Status:** Accepted 2026-09-28

## Decision
No tenant's business rules are hard-coded. Operational parameters resolve through one hierarchy, most specific wins:

```
variant  →  product  →  category (primary category)  →  organization settings  →  platform default
```

Implemented once in `src/domain/config/resolve.ts` (pure function) and mirrored in SQL where the DB needs it (buffers inside `reserve_inventory`).

| Parameter | Levels | Platform default |
|---|---|---|
| Setup buffer (min) | variant, product, category, org | 60 |
| Teardown / pickup buffer (min) | variant, product, category, org | 60 |
| Included rental duration (min) | product, category, org | 360 |
| Minimum booking lead time (min) | product, org | **720 (12 h)** |
| Overnight allowed | product, category, org | false |
| Max safe wind speed (mph) | product, category, org | null (no threshold) |
| Attendants required (count) | product | 0 |
| Setup requirements (text/structured) | product | — |

Pricing rules (extra hours, overnight, additional days, delivery) are rows in `pricing_rules` / delivery config, scoped to org / category / product / variant.

### Tiky Jumps initial configuration (data, loaded by its tenant import bundle)
- Water Slides category: included duration **4 hours** (240 min).
- Overnight: allowed where configured; pickup next day (`overnight` pricing rule + `overnight_allowed`).
- Multi-day: `additional_day` rule, **+25 % of base rental price per additional day** (`percent_of_base_bps = 2500`).
- Delivery: **first 5 miles free, then $4.00/mile** (`mileage` delivery rule: `free_miles = 5`, `per_mile_cents = 400`). See open questions below.
- Wind safety threshold: **15 mph** at organization level; surfaced as policy/safety information (weather integration is future work).
- Buffers 60/60 at org level; attractions may override.
- Lead time 12 h at org level, editable in admin settings. Staff same-day override is a later permission (`availability.override_lead_time`).

## Open questions (new, from this decision)
- **D15 — Mileage delivery needs a distance source.** Which provider (Google Maps, Mapbox, others), measured from which depot address, one-way or round trip, driving or straight-line, how miles are rounded, and a maximum service distance. Until a provider is chosen, `check_service_area` returns `requires_manual_review = true` with no fee for addresses outside explicitly configured ZIP/city zones. The AI must not quote a mileage fee without a computed distance.
- Is the wind threshold informational only, or should staff be able to mark a date "weather hold" that blocks wind-sensitive products? (Maps to an `availability_blocks` reason later.)
