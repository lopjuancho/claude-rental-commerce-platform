# 0010 — Weather safety: per-hazard rules plus staff-confirmed weather blocks (D16)

**Status:** Accepted 2026-09-28 · Revised 2026-09-28: generalised from wind-only to all weather hazards

## Decision

### Hazards
`wind`, `lightning`, `rain`, `severe_weather`, `temperature`, `custom` (manual safety). Wind is one hazard among several, not a special case.

### Sensitivity rules (`weather_hazard_rules`)
One row per (scope, hazard). Scope is the organization default, a category, or a product.
- `sensitive`: `true` = affected. `false` = explicitly **not** affected, e.g. a trackless train and wind.
- Optional operating limit: `threshold_value` plus `threshold_unit` (mph, km/h, °F, °C, in/h), e.g. wind 15 mph or temperature 100 °F.
- Resolution per hazard: **product → primary category → organization**; the most specific level wins. A level that says "sensitive" without a limit inherits the limit from a less specific level. No rule at any level = not sensitive.
- The same resolver is implemented in SQL (`app.product_hazard_rules`) and TypeScript (`src/domain/weather/resolve.ts`), and unit and integration tests pin both.
- These rules replace the M2 `wind_sensitive` / `wind_threshold_mph` columns; existing values were migrated.

**Why the inflatable limit sits on categories, not the organization:** an organization-wide 15 mph wind default would be inherited by any category later marked wind-sensitive (e.g. tents). Tents, foam equipment and mechanical attractions need their own manufacturer/operational limits, so a default must never leak onto them.

Tiky Jumps configuration (tenant bundle, not code):
- Bounce Houses, Water Slides, Combos, Interactives: wind, sensitive, 15 mph.
- Trackless Trains: wind, explicitly not sensitive.
- Tents, Foam Parties: no rule yet (to be confirmed).
- Mechanical/special attractions: product-level rules as needed.

### Weather blocks (M3)
`weather_blocks`: organization, hazard, `period`, `status` (`proposed` → `confirmed` → `lifted`), `source` (`staff` | `weather_api`), reason, optional observed value + unit, and scope:
- `all_sensitive`: every product whose resolved rule for that hazard is sensitive. If the block records an observed value in the same unit as the product's limit, the product is blocked only when observed ≥ limit. Without a comparable value it is blocked (conservative).
- `selected`: exactly the listed products/categories (`weather_block_targets`), regardless of sensitivity. This is the manual safety block.

Rules:
- Only **confirmed** blocks affect availability (`WEATHER_BLOCK`). **Proposed** blocks (e.g. from a weather API) only warn.
- Confirming a block **flags** overlapping reservations for staff review (`reservation_flags`). Nothing is cancelled or refunded automatically; cancellation is a manual staff action.
- The assistant never says a product can operate while a confirmed block applies to it. It relays `WEATHER_BLOCK` and says staff will confirm.
