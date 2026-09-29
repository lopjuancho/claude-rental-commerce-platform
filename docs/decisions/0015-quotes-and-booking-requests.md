# 0015 — Quotes on immutable snapshots, booking requests with temporary holds, a narrow public path

**Status:** Accepted 2026-09-30 · Implemented in M5 (migration `20260930001000_customers_events_quotes.sql`)

## Decisions

1. **Totals are derived, never written.** A quote references one immutable `pricing_calculations`
   row of the same organization (composite FK). Trigger `app.quotes_guard` copies subtotal,
   delivery, discounts, tax, total, `manual_review_required` and review reasons from it; any value a
   caller writes is overwritten. `quote_items` are rebuilt from the calculation's input by
   `app.quotes_sync_items` and cannot be written by anyone. Items and totals therefore always agree
   with the snapshot the customer saw.
2. **Re-pricing is explicit and only in draft.** It creates a new snapshot; the old one stays for
   the audit trail. The stored `price_request` (items, event address, codes, reasoned adjustments)
   is re-run against current rules. Sent, viewed, accepted and other quotes are fixed documents;
   "revise" moves a sent or viewed quote back to draft.
3. **State machine in the database** (`app.quote_transition_allowed`, mirrored and parity-tested in
   `src/domain/quotes/state-machine.ts`):
   - draft → sent | accepted | cancelled
   - sent / viewed → viewed | accepted | declined | expired | cancelled | draft
   - expired → draft
   - accepted, declined, cancelled are final.

   Sending stamps `expires_at` (organization `quote_valid_days`). Accepting after expiry fails with
   `QUOTE_EXPIRED`.
4. **Review gate.** A price flagged `manual_review_required` (missing tax/delivery/pricing
   configuration) cannot be sent, accepted or confirmed as a booking until a staff member records
   an approval with a note. The system context cannot approve, and re-pricing clears the approval.
   The customer sees such a price labelled "estimate".
5. **Numbering.** A per-organization counter row, incremented atomically by the insert trigger;
   prefix from `organization_settings.quote_number_prefix` (default `Q-`).
6. **Booking requests** (ADR 0002):
   - `request_booking` holds the quote's items through `reserve_inventory` (lock protocol, capacity,
     blocks, weather, lead time) for the organization's hold duration (15 minutes by default). It is
     idempotent while the hold is live, and there is one pending request per quote.
   - Renewal uses the M3 limits; cancelling releases the hold.
   - `confirm_booking_request` is staff only (the service role cannot execute it). It requires the
     review gate. A live hold is confirmed through `confirm_reservation`, which re-validates
     availability (hardening B1). An expired hold is re-reserved as confirmed, which fails cleanly if
     the stock was taken. The quote becomes accepted.
   - Declining (staff) or cancelling releases the hold. Confirmed bookings are never cancelled
     automatically.
7. **Customers** are matched by email (case-insensitive) and then by phone, serialized per
   organization. Existing values are never overwritten from public input; only empty fields are
   filled.
8. **Events** store the local date and time as given. The database derives the instants through
   `app.local_to_instant`: nonexistent local times are rejected and ambiguous ones need `time_fold`.
   An end time at or before the start time means the next day.
9. **Public path.** Visitors never write directly. The server calls:
   - the shared functions `match_or_create_customer`, `create_event` and `create_quote`, where the
     system context may only create `web`/`assistant` quotes and never internal notes;
   - the service-role-only functions `public_quote_view`, `request_booking_by_token`,
     `renew_booking_hold_by_token` and `cancel_booking_by_token`. `authenticated` and `anon` cannot
     execute these.

   All of these go through the trusted gateway (ADR 0014 §5), always with the host-resolved tenant
   and the SHA-256 of the link token. The token (256 random bits) is shown once and never stored.
   Every public write is rate-limited per tenant + client and audited as `public`.

   Bookable items for the form come from the anon-safe view `public_catalog_variants`, which holds
   ids and names only, no prices.

## Not in M5

- Payments and contracts.
- Sending quotes by email or SMS: "send" marks the quote and staff share the link.
- Editing a single quote line in place: staff edit the whole draft, which re-prices it.
- Automatic reassignment of a blocked held unit.
