# 0002 — Draft quotes, temporary holds, confirmed reservations (D2)

**Status:** Accepted 2026-09-28

## Decision
Three states, in order:

| State | Holds inventory? | Record |
|---|---|---|
| Draft quote | **No** | `quotes.status = 'draft'` |
| Booking request / checkout started | **Yes, temporary** — default **15 minutes** | `booking_requests` row + `reservations.status = 'held'` with `hold_expires_at` |
| Confirmed booking | **Yes, firm** | `reservations.status = 'confirmed'` |

- Hold duration comes from `organization_settings.booking_hold_minutes` (platform default **15**). The column exists now so each organization can change it later without a migration; the Phase 1 admin UI may expose it read-only.
- Expired holds release inventory **automatically and immediately**: every availability read ignores holds with `hold_expires_at <= now()`, and `reserve_inventory` releases expired holds for the variant inside its own transaction before allocating. A periodic sweeper marks them `released` and the booking request `expired` for housekeeping only; correctness never depends on it.
- Staff-created manual holds: `reservations.source = 'manual'` with `status = 'held'` and a staff-chosen expiry. The schema supports it now; the UI comes later.
- Creating a hold and confirming a booking both go through `app.reserve_inventory` / `app.confirm_reservation`, which are race-safe (see DATABASE.md §6).

## Consequences
- The storefront must show a visible countdown during checkout and handle "your hold expired, items are no longer available" gracefully.
- The quote status enum gains no hold-related values; the hold lives on the booking request/reservation so quotes stay a pricing document.
