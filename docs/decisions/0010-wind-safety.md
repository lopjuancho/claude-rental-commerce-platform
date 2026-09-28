# 0010 — Wind safety: information plus a staff-confirmed operational rule (D16)

**Status:** Accepted 2026-09-28 · Settings columns in M2; weather blocks in M3

## Decision

### Configuration (override chain from ADR 0003: product → category → organization)
- `wind_sensitive` — category and product (product `null` = inherit from category; category `null` = not sensitive).
- `wind_threshold_mph` — organization, category and product. Replaces the earlier `max_wind_mph` name.
- Tiky Jumps initial configuration: organization `wind_threshold_mph = 15`; inflatable categories `wind_sensitive = true`.

### Weather blocks (M3)
`weather_blocks`: organization, `period tstzrange`, `reason`, `status` (`proposed` | `confirmed` | `lifted`), `source` (`staff` | `weather_api`), optional observed/forecast wind speed, and the affected scope (all wind-sensitive products, or specific categories/products through join tables). `created_by`, `confirmed_by`, `confirmed_at`.

Rules:
- Only **confirmed** blocks affect availability: wind-sensitive products overlapping a confirmed block report `WEATHER_BLOCK`.
- Blocks from weather data are created as **proposed** and only raise warnings. Staff must confirm them.
- Overlapping existing bookings are **flagged** for staff review, never automatically cancelled or refunded. Cancellation is a manual staff action.
- Customer-facing text and the assistant show the threshold as safety information. The assistant must not say a wind-sensitive unit can operate during an active block. It relays `WEATHER_BLOCK` and says staff will confirm.
