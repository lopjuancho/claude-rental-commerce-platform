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
     (See §10: requests are bound to the quote revision, and the hold budget is per attempt.)
   - Renewal uses the M3 limits; cancelling releases the hold.
   - `confirm_booking_request` is staff only (the service role cannot execute it). It requires the
     review gate and the integrity checks of §10. Only a live hold can be confirmed; an expired hold
     requires a new request. Availability is re-validated (hardening B1). The quote becomes
     accepted.
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

## 10. Workflow boundaries (Codex review of `b59a7ea`)

Migration `20260930001100_m5_workflow_boundaries.sql`. Each item below was reproduced by a failing
test first (`tests/integration/quote-workflow-boundaries.test.ts`).

1. **A hold is bound to what it was granted for.** A booking request records:
   - the quote `revision`;
   - the `pricing_calculation_id`;
   - a signature of the held items (variant, period, quantity);
   - a signature of the event (times, address).

   A quote's revision increments whenever its snapshot, price request, event or customer changes,
   and when it is revised back to draft. Callers cannot write it. A new revision closes the pending
   request and releases its hold.
2. **One confirmation path.** `confirm_booking_request` is the only way to confirm a quote's hold.
   - `confirm_reservation`, `renew_hold` and `release_reservation` refuse reservations that belong
     to a quote or booking request (`RA010`). They remain only for staff manual holds that are not
     quotes.
   - The service role cannot execute `confirm_reservation`.
   - The internals are `app.*` functions that no client can call.
3. **Cancelling, declining or expiring a quote** closes its pending request and releases the hold,
   atomically with the status change. Renew, confirm and a new request are then refused.
4. **Canonical lock order**, used by every workflow function and trigger:
   1. quote row;
   2. booking-request row;
   3. organization advisory lock, then variant advisory locks in uuid order;
   4. reservation rows.

   Functions given a booking-request id read it without a lock, lock the quote, then lock and
   re-read the request. Before the fix, 40 concurrent mixed operations produced deadlocks (`40P01`);
   after it, three rounds produce none.
5. **No enrichment from anonymous input.** A public submission may reuse an existing customer
   matched by email or phone, but never changes it. What the visitor typed is stored in
   `quotes.submitted_contact` (immutable) for staff to review. Staff may still fill empty fields.
6. **The renewal budget belongs to the booking attempt.** For public and assistant callers,
   `quote_hold_budgets` (quote, revision) counts every hold granted and every extension. The cap is
   `1 + max_hold_renewals`, so cancelling and requesting again cannot roll holds forever. Staff
   holds are not limited. A new revision (a staff action) starts a new attempt.
7. **Final integrity check** in `confirm_booking_request`. Each of these is verified, and nothing
   is "fixed up":
   - the quote is confirmable (draft, sent or viewed) and not expired;
   - the revision and snapshot match;
   - the review is approved when required;
   - the held items equal the quote's items and the reservation's allocations;
   - the event is unchanged;
   - the hold is live;
   - availability is re-validated.

   A mismatch raises `STALE_BOOKING_REQUEST` (`RA013`), `HOLD_EXPIRED` (`RA004`) or the
   availability error. The customer or staff must request the booking again.

## 11. Workflow boundaries, round 2 (re-verification before M6)

Migration `20260930001200_m5_boundaries_round2.sql`. Re-checking items 1–7 against the code found
four remaining gaps. Each was reproduced by a failing test first (the "round 2" blocks in
`tests/integration/quote-workflow-boundaries.test.ts`).

1. **The priced items are bound to the event.** `app.quote_event_mismatch` compares the quote's
   item periods with the event's instants, and the priced delivery address with the event's
   address. If the event is edited after pricing, the quote is stale: request, renewal and
   confirmation raise `STALE_BOOKING_REQUEST` (`RA013`) until the quote is re-priced for the new
   event. Editing an event also releases the pending hold of every open quote on it at once
   (trigger `events_release_holds`).
2. **Only confirmation accepts a quote.** Staff could previously set `status = 'accepted'`
   directly, which skipped the hold, snapshot and availability checks. The trigger
   `quotes_require_booking` now allows `accepted` only when a confirmed booking request of the
   same revision and snapshot exists, with its confirmed reservation. `confirm_booking_request`
   confirms the request first, then accepts the quote. The admin "Mark accepted" button is gone.
3. **Renewal re-verifies the attempt.** Renewal now runs the same `app.assert_booking_current`
   check as confirmation:
   - the booking request is pending;
   - the quote is open and not expired;
   - the revision, snapshot, customer and event links match;
   - the event and the items are unchanged.

   A quote that expired by time, before the sweeper ran, can no longer keep a hold alive.
4. **Lock order step 0.** An event UPDATE locks the event row first, then the quotes on it (ordered
   by id), then steps 1–4. No function holding a quote lock locks an event row; they only read it.
   Deterministic tests show that an event edit waits behind a confirmation, and a request waits
   behind an event edit, with no deadlock. Three rounds of 48 mixed concurrent operations produce
   no `40P01`. Those operations include event edits, quote cancel/expire, the hold sweeper, declines
   and direct-accept attempts.
5. **Confirmation also verifies the links.** The reservation must belong to this booking request
   and quote (`RA013` otherwise), in addition to everything in §10.7.

Items 5 and 6 of §10 (customers, renewal budget) were re-verified with additional regression tests
and needed no change. Those tests cover opt-in and company fields, swept holds, and a quote being
viewed.

## Not in M5

- Payments and contracts.
- Sending quotes by email or SMS: "send" marks the quote and staff share the link.
- Editing a single quote line in place: staff edit the whole draft, which re-prices it.
- Automatic reassignment of a blocked held unit.
