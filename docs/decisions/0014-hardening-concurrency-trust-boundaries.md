# 0014 — Hardening: one availability lock protocol, server-only pricing writes, DST-safe local times, a single service-role gateway

**Status:** Accepted 2026-09-30 · Implemented in the hardening milestone (before M5).
Findings came from an independent review (Codex) of the M4 commit; all were reproduced before fixing.

## 1. Availability lock protocol (finding: capacity changes did not coordinate with holds)

Only `reserve_inventory` took per-variant locks. Reducing pooled quantity, retiring units, adding
blocks, confirming weather, confirming or renewing a hold could interleave with hold creation and
leave an oversold or unflagged state.

**Decision.** Every operation that can reduce availability takes the same advisory locks, always
in this order:

1. organization lock: **shared** for variant-scoped work, **exclusive** for organization-wide
   changes (blackouts, weather confirmation, organization settings, categories, weather rules);
2. one exclusive lock per affected variant, in uuid order;
3. reservation row locks only after the advisory locks (`confirm_reservation`, `renew_hold` and
   the replacement path of `reserve_inventory` read the variant ids first without a row lock).

Checks that depend on capacity run in statements that start after the locks are held, so they see
everything committed by the previous holder. Enforced in the database, as triggers and functions:

| Operation | Lock | Check |
|---|---|---|
| hold / booking (`reserve_inventory`) | org shared + variants | capacity, blocks, weather (M3) |
| confirm / renew hold | org shared + reservation's variants | hold still live |
| pooled quantity change | org shared + variant | a reduction must fit bookings + holds **+ partial blocks** at every future moment (`CAPACITY_IN_USE`, RA011) |
| tracking-mode change | org shared + variant | refused while bookings/holds exist |
| unit insert / retire / delete / move | org shared + variant(s) | a booked or held unit cannot be retired, deleted or moved |
| product or variant update (publish, archive, buffers, lead time) | org shared + its variants | — |
| product / variant / unit block | org shared + scope's variants | overlaps are flagged (M3), now also when a partial block's quantity grows |
| organization-wide blackout | org exclusive | flags overlaps |
| weather confirmation | org exclusive | flags overlaps |
| organization settings, categories, weather rules | org exclusive | — |

Blocks may still be added over existing bookings. They flag those bookings for staff and never
cancel them (ADR 0010). What can no longer happen is an overlap that nobody flagged, or a booking
that no longer fits the stock.

**Evidence.** `tests/integration/availability-locking.test.ts` has 16 deterministic races. Each
one holds transaction A open in its critical section and asserts that B is *waiting on a lock*.
There is also a randomized stress run over 5 seeds (60 mixed concurrent operations each) that
checks the invariants. With the protocol removed, all 21 fail; with it, all pass. The stress run
also found a real gap: quantity reductions ignored partial blocks. That gap is fixed.

## 2. Pricing trust boundary (finding: staff could store arbitrary calculation JSON)

- `record_pricing_calculation` and `put_cached_distance` can be executed only by `service_role`.
  No signed-in role, including owner, can store a calculation or a cached distance.
- Only server code computes and stores calculations (`runPricing` → trusted gateway): the engine
  version, input hash, totals, tax, delivery and rule revisions all come from it. The database
  also rejects inconsistent snapshots: total ≠ subtotal + tax, a currency that does not match the
  organization, an engine version mismatch, or a non-member actor.
- Pricing requests are **strict**: items, quantities, times, address, discount codes and (staff
  only) adjustments. Any other key, such as a price, total, organization id or engine version, is
  rejected.
- A manual adjustment needs a reason. The verified staff member is stamped into the snapshot
  (`authorizedBy`), the engine re-runs with it, and a `pricing.adjusted` audit row records who
  made it, the amounts and the reason.

## 3. Distance cache (finding: read-only staff could write cache entries)

Covered by §2. Members may still *read* their own organization's cache.

## 4. DST (finding: 02:30 on spring-forward day silently became 03:30)

`resolveLocalTime` (TypeScript) and `app.local_to_instant` (SQL) never normalize:

- a nonexistent time is rejected (`NONEXISTENT` / RA012);
- an ambiguous time is rejected unless the caller passes an explicit fold (`earlier` = first
  occurrence, daylight time; `later` = second, standard time). The result carries its UTC offset,
  and the stored timestamptz is that exact instant.

The admin forms offer the choice ("If the time happens twice"). The default is to reject. The two
implementations are parity-tested every 15 minutes across transition days in six zones, including
Lord Howe's 30-minute shift.

## 5. Service-role boundary (review: anonymous flows use a service-role client)

The service-role client is reachable only through `src/server/trusted/gateway.ts`, which has these
explicit methods:

- `pricing_context`, `delivery_area_context`, `tax_context`;
- get/put cached distance;
- `record_pricing_calculation`;
- the audit insert.

There is no generic table access. ESLint allows the client import only in `db/system.ts` and the
gateway. A static test (`tests/unit/service-role-inventory.test.ts`) fails if anything else
references the client or the key, or if the gateway calls anything not on that list.

Public services:

- take a `ResolvedTenant` (host-resolved), never an organization id;
- reject unknown input keys;
- are rate-limited per tenant + client before any database work (a new `publicQuery` policy with
  a Cloudflare binding);
- audit what they store.

Public availability uses the anon client and an anon-safe function, not the service role.
Cross-tenant attempts are tested through the real public pricing service against the database.

## 6. CI

The workflow ran only on `main` and pull requests, so the development branch was never verified.
It now also runs on `claude/**` pushes and on manual dispatch, against a real Supabase stack
(Postgres + Auth + PostgREST).

## 7. Round 2 (Codex re-review of `ee09fcb`): three blockers

Each blocker was first reproduced by a failing test, then fixed in the database or server
(migration `20260930000970_hardening_round2.sql`).

**B1: confirmations did not re-validate.** Confirmation checked only the expiry and weather.

- *Failure scenario:* a hold is created; afterwards a maintenance/repair/staff block, blackout, or
  product archive lands on its stock. The block correctly flags the hold, but
  `confirm_reservation` still turned it into a confirmed booking. The same happened when the
  block was being committed concurrently.
- *Fix:* `confirm_reservation`, under the reservation's variant locks, calls
  `app.hold_invalid_reasons`. It checks, for each allocation:
  - the held unit is still active, still belongs to the variant, and is unblocked;
  - no blackout, product block or variant block;
  - the product is active (and published, when the caller is the system context);
  - for pooled stock, the held quantity still fits beside every other active booking/hold and
    partial block; the hold never counts against itself.

  If any check fails, confirmation raises `BLOCKED` (RA002) or `INSUFFICIENT_AVAILABILITY` (RA001)
  and the hold stays `held`. Existing confirmed bookings are flagged as before, never cancelled.
- A held unit is not swapped automatically. Staff can re-reserve it (atomic replace).

**B2: adding a weather rule took no lock.** The shared organization-lock trigger derived the
organization from `OLD`, which is NULL on INSERT, and `pg_advisory_xact_lock(NULL)` silently does
nothing.

- *Failure scenario:* adding a category rule that makes products wind-sensitive to an
  already-confirmed wind block could interleave with hold creation. The hold was admitted without
  the rule, then the rule committed, and nothing flagged the hold.
- *Fix:*
  - the trigger uses `NEW` (or `OLD` on delete);
  - `lock_organization` refuses a NULL organization instead of silently not locking;
  - `product_categories` changes lock the product's variants (membership decides "selected"
    weather blocks);
  - `lift_weather_block` takes the exclusive organization lock;
  - every weather-rule change, category-membership change, or primary-category change flags the
    existing bookings that a confirmed weather block now covers (`app.flag_weather_conflicts`),
    never cancelling them.
- New holds, and confirmations, see the updated rules after acquiring the lock.
- Weather rules exist at organization, category and product level only. There is no variant
  level to lock.

**B3: add-on status was chosen by the caller.** The request's `kind` (`rental` or `add_on`)
decided the tax component.

- *Failure scenario:* a caller could relabel a taxable rental as an "add-on" wherever add-ons are
  not taxable.
- *Fix:* `kind` is no longer accepted (the strict schema rejects it). `pricing_context` reports
  each product's catalog add-on relations (`addonOf`), and the server marks an item as an add-on
  only when it is requested together with a product it is an add-on of.

**Pricing input classification** (the strict request schema enforces it):

- **Client-provided:** variant ids, quantities, event start/end, event address (null = pickup),
  discount-code references. Staff with `quotes.write` may also add reasoned, audited adjustments.
- **Server-authoritative (from the database after tenant resolution):**
  - organization, currency, time zone, multi-day strategy;
  - base price, included duration, overnight permission, attendants, product name and categories;
  - add-on status;
  - pricing rules and revisions;
  - delivery depot, free miles, per-mile rate, rounding, basis and service areas;
  - tax jurisdiction, rates and taxability;
  - engine version and input hash.

Twenty regression tests show each of these being rejected when a caller tries to supply it. The
rejection happens before any trusted data is read, on both the staff and the public paths.

## Not changed (disagreement or scope)

- Blocks over existing bookings stay allowed, with flags. This is deliberate (ADR 0010: never
  cancel automatically). The protocol guarantees the flag is never missed.
- Product archive/unpublish does not cancel existing bookings. It is serialized with holds, so no
  new hold can start after it.
