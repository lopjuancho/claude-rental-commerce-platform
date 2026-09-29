# MVP — Phase 1 Plan

> Status: **Accepted** (decisions recorded in [`docs/decisions/`](./docs/decisions/README.md)). Architecture in [`ARCHITECTURE.md`](./ARCHITECTURE.md), schema in [`DATABASE.md`](./DATABASE.md).

## 1. Phase 1 goal

A tenant (first: Tiky Jumps Inflatables LLC) can:

1. Manage its catalog, inventory, service areas, pricing rules, branding and policies in an admin dashboard.
2. Publish a mobile-first storefront where customers browse by category **or** describe their event to an AI assistant.
3. Have the assistant recommend suitable products using only real data, check real availability, compute real prices and delivery, and create a draft quote tied to a customer and an event.
4. Have staff review conversations and quotes, and confirm bookings (which reserves inventory race-safely).

And the platform can onboard a second tenant with **zero code changes**.

### Definition of done for Phase 1

- Two tenants running side by side in staging with no data leakage (proven by the automated isolation matrix).
- Availability and pricing engines covered by unit + integration tests, including concurrency.
- The assistant never states a price/availability/delivery fee that did not come from a tool result in automated evals.
- CI green: typecheck, lint, unit, integration, build.

## 2. In scope

Multi-tenant orgs · auth & roles (owner/admin/office/staff) · categories · products · variants · media · inventory (serialized + pooled) · availability rules/blocks · reservations (holds + confirmed) · pricing engine · tax · service areas (ZIP/city/zone/flat fee) · customers · events · quotes + items + charges · conversations · AI tool layer · public catalog · AI assistant UI · basic admin · audit logging · rate-limiting architecture · tenant import tooling.

## 3. Explicitly out of scope (with the seam that keeps the door open)

| Not building | Seam |
|---|---|
| Stripe / payments / deposits | Quote `accepted` transition; `orders`/`payments` tables later |
| Contracts / e-signatures | Versioned `organization_policies`; acceptance snapshot |
| Driver routing, scheduling | Event lat/lng; extensible `org_role` |
| Warehouse management | `inventory_units` status/condition; maintenance blocks |
| Employee scheduling, payroll, accounting | — |
| Full CRM, marketing automation | Customer consent flags; conversation `channel` |
| Native apps | Server-side services/API usable by any client |
| Complex reporting | `audit_logs`, `ai_actions` capture raw data |
| Website builder | Branding config + storefront theming only |
| Customer accounts / portal | Decision D1 (anonymous → real auth later) |
| Email/SMS sending of quotes | "Send" in Phase 1 = mark sent + shareable signed quote link; delivery channel later (see Q-list) |

## 4. Milestones

Each milestone ends with: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && pnpm build`, a written report of what was implemented, what is incomplete, and any failures — nothing skipped silently.

### M1 — Foundation, auth, organizations, tenant isolation

**Status: implemented 2026-09-28** — see the M1 report in the commit history / PR. Deferred items are listed under "M1 follow-ups" below.
- Next.js + TS strict + Tailwind + shadcn/ui scaffold; ESLint import-boundary rules; Vitest; Playwright; GitHub Actions CI.
- Supabase local setup; migrations `0001–0003`; generated types.
- Env config schema (Zod), `.env.example`, secret-safe client factories (user/public/system).
- Tenant resolution middleware (host → org; dev path fallback).
- Sign-in, sign-out, invitation acceptance, org switcher; `requirePermission()`.
- Audit log writer + triggers on members/settings.
- **Tests:** RLS isolation matrix for tenancy tables; permission checks per role; invitation expiry/reuse rejected; cross-tenant composite FK rejection; system-context tenant guard.
- **Acceptance:** user of org A cannot read/write any org B row via PostgREST directly with their JWT.

### M2 — Catalog, categories, media, inventory

**Status: implemented 2026-09-28.** See §8 for follow-ups.
- Migration `0004`; category & product CRUD (admin) with Zod-validated forms; variants (default auto-created); inventory units / pooled quantity; media upload to Storage with org-prefixed paths.
- Public catalog views excluding internal fields.
- CSV import pipeline (ADR 0006, 0011): upload → staging → adapter-suggested field mapping onto the canonical model (ERS is one adapter) → validation → preview → idempotent transactional commit; manual product creation uses the same validation.
- Wind configuration columns (ADR 0010) and delivery mileage settings (ADR 0009) on organization/category/product.
- Media rights metadata; unverified media cannot be published.
- Tenant configuration bundle + `import-tenant.ts` for settings/categories/service areas/pricing (Tiky Jumps' initial rules from ADR 0003 are data here).
- **Tests:** RLS matrix for catalog tables + storage; anon cannot see unpublished products, `internal_notes` or unverified media; import re-run updates instead of duplicating; invalid CSV rows reported, not imported; cross-org media path rejected; slug uniqueness per org (same slug allowed in two orgs); invalid specs rejected (max_age < min_age, neither wet nor dry).

### M3 — Availability engine

**Status: implemented 2026-09-28.** See §9 for follow-ups.
- `domain/availability` (intervals, buffers, peak capacity) — pure and exhaustively tested.
- Weather blocks (ADR 0010): staff-confirmed, flag overlapping bookings, `WEATHER_BLOCK` for wind-sensitive products.
- Migration `0005`; `check_availability` and `reserve_inventory` SQL functions; holds with expiry; blocks; rules (lead time, closed days).
- Admin: blocks/maintenance management, simple per-product calendar list.
- **Tests:** all scenarios in DATABASE.md §6.3 including the concurrency race and DST.

### M4 — Pricing engine (+ service areas, tax)

**Status: implemented 2026-09-29** (ADR 0013). Outputs for review are in `docs/pricing-review.md`. See §10 for follow-ups.
- `domain/pricing` rule engine with itemized output; migration `0006`; service-area resolution + road-distance mileage via `DistanceProvider` with caching (ADR 0009); location-based tax with per-component taxability (ADR 0004).
- Admin: pricing rules, tax jurisdictions/rates/taxability, service areas (ZIP/city lists, mileage rule).
- **Tests:** base, extra hours, overnight, multi-day (+25 % of base per extra day), mileage (≤5 mi free, 5.1 mi, beyond max), quantity, discount percent/fixed/code, min charge, delivery, taxability per component (rental/delivery/labor/fee/discount), unresolved jurisdiction warning, rounding, negative totals prevented, unknown rule type rejected, deterministic output snapshot tests.

### Hardening (between M4 and M5)

**Status: implemented 2026-09-30** (ADR 0014). Addresses the independent review:

- one availability lock protocol for every capacity-reducing change, with race tests;
- server-only pricing and distance-cache writes;
- DST-safe local times;
- a single, enumerated service-role gateway;
- CI on `claude/**` branches.

M5 work is paused on a local WIP branch until this is reviewed.

### M5 — Customers, events, quotes
- Migration `0007`; services for customer match/create, event create/update, quote create/add item/re-price/transition; per-org quote numbering.
- Booking flow (ADR 0002): draft quote (no hold) → booking request (15-min hold, org-configurable) → staff confirmation (firm reservation); expired holds release automatically.
- Admin: customers, events, quotes list/detail, status actions, print-friendly quote view.
- **Tests:** quote totals equal engine output; stored totals CHECK; illegal status transitions rejected; booking request for unavailable items fails cleanly; expired hold no longer blocks and cannot be confirmed; duplicate customers deduplicated; staff role cannot edit quotes.

### M6 — Public catalog (storefront)
- Tenant-themed, mobile-first storefront: hero "What are you planning?" input, category rails, category pages, product detail (gallery, specs, requirements), "Check availability" (date/time → `check_availability`), "Get quote" form, "Ask AI about this item".
- SEO basics (metadata, sitemap per tenant), image optimization, accessibility (WCAG AA targets).
- **Tests:** E2E browse → product → availability check; unpublished product 404; tenant B host shows tenant B catalog only.

### M7 — AI Event Assistant + tool calling
- Migration `0008`; `LlmProvider` + OpenAI implementation; tool registry with the Phase 1 tools; orchestrator loop with budgets; structured final output; grounding validator; streaming endpoint; Turnstile + rate limits.
- Assistant UI: chat, event summary chip bar (date · place · kids · budget), recommendation cards rendered from tool facts, "needs confirmation" badges, "Create my quote" flow.
- **Tests:** tool arg validation failures; injected `organizationId` ignored; unknown tool; budget exhaustion; idempotent writes; validator rejects fabricated price / unconfirmed "available"; mock-provider conversation E2E; on-demand live eval suite.

### M8 — Admin interface polish
- Dashboard summary (new conversations, quotes created, quotes awaiting action, upcoming events); conversation viewer with tool trace; settings (branding, contact, policies, defaults, assistant toggle); member management.
- **Tests:** permission-gated navigation and actions per role; audit entries for settings/pricing/member changes.

## 5. Customer experience targets (M6–M7)

- Mobile first (375px baseline), LCP < 2.5s on 4G for the home page, product images responsive.
- Home: one conversational input as the hero, suggestion chips ("Birthday for 30 kids", "School field day", "Water slide for July 4th"), then category browsing (Bounce Houses, Water Slides, Interactives, Trackless Trains, Foam Parties, Tents, Tables & Chairs — **these are Tiky Jumps' categories as data, not hard-coded**).
- Product card: photo, name, "from $X" (engine-computed starting price), short description, "Check date", "Get quote", "Ask AI".
- Recommendation card: product, status pill ("Available Jun 20" only when confirmed), itemized price from the engine, 2–3 reasons each tied to a product attribute, "Add to quote".
- Visual direction: modern e-commerce (clean cards, generous imagery, sticky bottom CTA on mobile) — explicitly not modeled on existing rental-software layouts.

## 6. Open questions for Tiky Jumps / product owner

Answered 2026-09-28: D1, D2, D3, D4 (validation of Tennessee treatment pending), D11, D13 — see `docs/decisions/`.

Answered 2026-09-28 (second round): D15 (ADR 0009), D16 (ADR 0010); import adapters (ADR 0011).

Still open:

1. Exact Tennessee tax configuration (rates, taxability of delivery/labor/fees) — before production.
2. A sample ERS CSV export (a few rows) to verify the ERS adapter's header mapping.
3. ~~Distance provider, depot, maximum distance~~: answered for M4 (Google Maps; 2560 Overton Crossing St, Memphis TN 38127; no maximum). The Google Maps API key is still needed.
4. Do they sell packages/bundles today (D5)?
5. ZIP/city delivery zones, if any, in addition to mileage.
6. Discounts in use today (weekday, multi-item, promo codes)?
7. Who on the team gets which role?
8. How should "send quote" reach the customer in Phase 1 (copy link, their own email, platform email)?
9. Platform/brand name and domain for the SaaS (D7).

## 7. M1 follow-ups (carried forward)

- **System-context runtime tests:** there are no public write paths yet; the `ResolvedTenant` branded type and the ESLint allow-list guard them now. Runtime tests that system-context repositories reject mismatched tenants land with the first public write path (M5/M7).
- **Auth flows against a real Supabase Auth server** (sign-in, sign-up, invitation acceptance, org switching end-to-end) run only in CI; the build sandbox could not pull Supabase images.
- **MFA enforcement UI** for owner/admin (D9) — M8.
- **Accessibility linting** (jsx-a11y is not ESLint-10 compatible) — replace with axe checks in Playwright at M6.
- **Organization self-service onboarding** is intentionally absent; organizations are created by platform tooling (`create_organization`, service role).

## 8. M2 follow-ups (carried forward)

- **ERS adapter unverified** until tested with a real ERS export (header synonyms are guesses; staff can remap every field).
- **Media upload and signed URLs** run against Supabase Storage; they are exercised in CI only (the build sandbox cannot run the Storage API). Storage RLS policies are tested at the database level.
- **Variants UI:** every product has its default variant; creating additional variants (sizes/colours) has schema support but no admin UI yet.
- **Product relations (add-ons)** have schema + RLS but no admin UI yet (needed with pricing in M4).
- **Import size:** 5,000 rows / 5 MB per file, processed in the request. Larger catalogs would need a background job.
- **Tiky Jumps bundle:** owner email, domains, branding, depot address, maximum delivery distance, wind sensitivity for tents/trains/foam, and policies still to be filled in (`seeds/tenants/tiky-jumps/README.md`).

## 9. M3 follow-ups (carried forward)

- **Booking requests** (`booking_requests` table, public "request booking" flow creating 15-minute holds through the system context) are M5. The engine already supports system-context holds, renewal and atomic replacement.
- **Quote/event links** on reservations are plain columns until those tables exist (M5 adds the foreign keys).
- **Overnight rules** (`overnight_allowed`, next-day pickup) and **multi-day pricing** are pricing/quote rules (M4/M5). Availability already handles overnight and multi-day periods as ranges, capped by `max_rental_days` (org setting, default 14).
- **Declarative availability rules** (closed weekdays, max events per day) are not implemented. Blackout blocks cover closures for now.
- **Hold sweeper schedule:** `sweep_expired_holds()` exists. A Cloudflare cron trigger to call it is deployment work. Correctness never depends on it.
- **Weather data feed:** blocks from a weather API would be created as `proposed` by the system context. Only staff can confirm (enforced).
- **Calendar view:** the admin shows an upcoming list, a checker, blocks and weather. A visual calendar is M8.

## 10. M4 follow-ups (carried forward)

- **Pricing outputs await product-owner review** (`docs/pricing-review.md`) before M5 starts.
- **Missing Tiky Jumps configuration**, which currently yields manual review:
  - extra-hour rates, overnight charge (and `overnight_allowed`), attendant fees;
  - Tennessee tax jurisdictions, rates and taxability;
  - optional service areas or a maximum delivery distance.
- **Google Maps API key** (`GOOGLE_MAPS_API_KEY`, server-only). Without it, every delivery goes to review. The Routes adapter is tested with a mocked `fetch` only, because the sandbox has no network access to Google.
- **Depot geocoding:** the depot is sent as an address. Stored coordinates would save a geocode per request.
- **Quantity tiers and date surcharges** are not rule types yet.
- **Add-ons:** the engine prices `add_on` items (their own tax component). Product-relation suggestions come with quotes (M5) and the storefront (M6).
- **Quotes (M5)** reference `pricing_calculations` snapshots, and re-pricing is an explicit action.
