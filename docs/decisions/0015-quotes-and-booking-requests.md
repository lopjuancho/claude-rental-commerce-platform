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

## 12. Workflow boundaries, round 3 (Codex review of `0040188`)

Migration `20260930001300_m5_boundaries_round3.sql`. Each HIGH finding was reproduced by a failing
test first (`tests/integration/quote-workflow-round3.test.ts`).

1. **A confirmed booking is frozen.**
   - Once a quote is accepted, its `event_id`, `customer_id`, `pricing_calculation_id` and
     `price_request` cannot change (`RA010`).
   - Its event's date, times, fold and address cannot change either (`events_guard_booking`).
     The trigger takes the quote locks first, so an edit that waited behind a confirmation is
     refused once that confirmation commits.
   - A quote-managed reservation cannot be re-linked or replaced (so `reserve_inventory`
     replacement is refused). A confirmed one cannot be ended.
   - Notes and guest counts stay editable.
   - Changing a confirmed booking will need a separate, explicit amendment workflow (not in M5).
2. **The immutable snapshot is the authority on what was priced.**
   - Pricing input now records `destination`, the address delivery was priced for (`null` for
     pickup).
   - `app.quote_event_mismatch` compares the event with the snapshot's item periods and
     `destination`. `quotes.price_request` no longer plays any part, so rewriting it cannot make
     a stale quote valid.
   - Request, renewal and confirmation share this comparison.
   - A delivery snapshot made before `destination` existed counts as stale and must be re-priced.
3. **Expiry after the locks; a hold never outlives its quote.**
   - Every quote-expiry and hold-expiry decision uses `clock_timestamp()` after the locks are
     held. `now()` is the transaction start, which is stale after a lock wait.
   - A hold is capped at the quote's `expires_at` when it is created or extended, and whenever
     the expiry moves. So an expired quote's hold is dead at that instant, even before
     `expire_quotes` or the sweeper run.
4. **One enforced order for inventory locks.** Per organization, variant advisory locks are taken
   in ascending uuid order across the whole transaction. The lock functions record what is held.
   - Acquiring a lower variant after a higher one, or upgrading a shared organization lock to
     exclusive, raises `LOCK_ORDER_VIOLATION` (`RA014`) instead of waiting into a deadlock.
   - Operations over several quotes (`expire_quotes`, event edits) lock quotes, then booking
     requests, then the union of their variants.
   - `request_booking` locks the old hold's and the new items' variants in one call.
   - Catalog and block edits, whose row triggers fire in planner order, take the organization
     lock exclusively. So do quote row triggers when nothing was pre-locked.
   - Sweeps and `expire_quotes` process rows in id order and skip rows a live transaction holds.

   Before the fix, the reversed-order rounds deadlocked 11–12 times each. After it, they produce
   no `40P01`.

## 13. MEDIUM findings (Codex `M5-HARDENING-REVIEW.md`, reviewed commit `0040188`)

Migration `20260930001400_m5_medium_findings.sql`. Tests are in
`tests/integration/quote-workflow-medium.test.ts`.

1. **M1: generic replacement of a quote-managed hold.** Reproduced at `0040188`: the replacement
   succeeded, released the managed hold and left an unlinked one. It had already been closed in
   `20260930001300` by `reservations_guard_quote_managed`, which raises `RA010` and rolls back the
   whole call. Tests now pin that the hold, the request, its allocations and the budget are
   unchanged and that no replacement reservation survives. Manual-hold replacement still works.
   Managed replacement is not supported; the customer or staff request the booking again.
2. **M2: reciprocal links.** Every operation on a managed hold now checks that the reservation
   belongs to this request, quote and organization before changing anything
   (`app.assert_reservation_linked`, `RA013`).
   - Renewal and cancellation or decline reject a request pointing at a foreign hold. Nothing
     changes and no budget is consumed.
   - The automatic paths act only on holds that link back to the request, never on
     `booking_requests.reservation_id` blindly. These are: quote revision, cancellation and
     expiry; event edits; expiry caps; the multi-quote pre-locking.
   - `request_booking` treats a mislinked pending request as stale.
   - The links are immutable once set, so checking them after the quote and request locks is
     final.
3. **M3: scope of the public hold budget. This is a decision, not a fix.**
   `quote_hold_budgets` limits holds and extensions per quote revision (1 + `max_hold_renewals`).
   Cancelling, expiry and sweeping cannot reset it (tests in §10.6 and round 2). It is **not** a
   visitor- or customer-wide limit. A new public quote for the same contact, product and window
   starts a new budget, and the test documents that this is allowed.

   Today the only cross-quote brake is the per-tenant, per-client-IP write rate limit (20 per
   minute across quote requests, holds, renewals and cancellations). An unverified email is
   deliberately not treated as an identity. Options before public launch (owner decision):
   - **a. Accept** the per-quote scope with the rate limit as the bound. No change.
   - **b. Per-client cap on concurrent live public holds per tenant.** The server passes a hashed
     client key (IP-derived, never an email). The database counts that key's live holds and
     rejects over the cap atomically, before reserving.
   - **c. Public share cap per variant and period.** Public holds may occupy at most N units or X%
     of a variant's capacity at any moment; staff holds are unaffected.

   The owner chose (b); it is implemented in §14.

## 14. Per-visitor cap on live public holds (M3 decision)

Migration `20260930001500_m5_public_hold_cap.sql`. Tests are in
`tests/integration/public-hold-cap.test.ts` and `tests/unit/visitor-token.test.ts`.

- **Identity.** A server-issued anonymous visitor token (`src/server/visitor.ts`): 256
  random bits, base64url, no PII. The browser keeps it in the `rc_visitor` cookie: HttpOnly,
  SameSite=Lax, Secure in production, 180 days.
  - It is issued when a visitor first requests a booking.
  - A malformed cookie is replaced, never trusted.
  - The server sends only `SHA-256("rental-commerce:visitor:v1:" + token)` to the database. The
    domain prefix keeps it distinct from quote-link hashes.
  - Emails and IPs are never the identity.
- **Policy.** At most `organization_settings.max_public_holds_per_visitor` (default 2) live
  public holds per visitor per organization.
  - "Live" means `held` and not yet expired (clock time). Released, cancelled, declined, expired
    and confirmed holds do not count.
  - The count is per visitor, so a new quote does not reset it.
  - Staff holds are exempt: they carry no visitor hash.
  - Over the cap, the request fails with `PUBLIC_HOLD_LIMIT` (`RA015`), with a safe customer
    message. Nothing is created and no per-quote budget is consumed.
- **Atomic.** `request_booking` takes a per-(organization, visitor) advisory lock after the
  quote, request and variant locks, counts with `clock_timestamp()`, and creates the hold in the
  same transaction. `reserve_inventory` only re-enters variant locks already held.
  Concurrent requests from one visitor therefore cannot exceed the cap: a deterministic test
  plus three rounds of 6 parallel requests.
- **Required.** A public (non-staff) hold without a well-formed visitor hash is refused
  (`RA006`, `INVALID_INPUT`). `public_visitor_hash` is part of the hold's immutable identity.
- **Unchanged.** The per-quote renewal budget (§10.6) and the per-tenant, per-client-IP write
  rate limit still apply as separate controls.
- **Limits of this control.** A visitor who clears their cookies gets a new identity. The rate
  limit bounds how fast that can be exploited.

## Not in M5

- Payments and contracts.
- Sending quotes by email or SMS: "send" marks the quote and staff share the link.
- Editing a single quote line in place: staff edit the whole draft, which re-prices it.
- Automatic reassignment of a blocked held unit.
