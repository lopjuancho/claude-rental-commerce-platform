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
- Next.js + TS strict + Tailwind + shadcn/ui scaffold; ESLint import-boundary rules; Vitest; Playwright; GitHub Actions CI.
- Supabase local setup; migrations `0001–0003`; generated types.
- Env config schema (Zod), `.env.example`, secret-safe client factories (user/public/system).
- Tenant resolution middleware (host → org; dev path fallback).
- Sign-in, sign-out, invitation acceptance, org switcher; `requirePermission()`.
- Audit log writer + triggers on members/settings.
- **Tests:** RLS isolation matrix for tenancy tables; permission checks per role; invitation expiry/reuse rejected; cross-tenant composite FK rejection; system-context tenant guard.
- **Acceptance:** user of org A cannot read/write any org B row via PostgREST directly with their JWT.

### M2 — Catalog, categories, media, inventory
- Migration `0004`; category & product CRUD (admin) with Zod-validated forms; variants (default auto-created); inventory units / pooled quantity; media upload to Storage with org-prefixed paths.
- Public catalog views excluding internal fields.
- CSV import pipeline (ADR 0006): upload → staging → field mapping (ERS preset as data) → validation → preview → idempotent commit; manual product creation uses the same validation.
- Media rights metadata; unverified media cannot be published.
- Tenant configuration bundle + `import-tenant.ts` for settings/categories/service areas/pricing (Tiky Jumps' initial rules from ADR 0003 are data here).
- **Tests:** RLS matrix for catalog tables + storage; anon cannot see unpublished products, `internal_notes` or unverified media; import re-run updates instead of duplicating; invalid CSV rows reported, not imported; cross-org media path rejected; slug uniqueness per org (same slug allowed in two orgs); invalid specs rejected (max_age < min_age, neither wet nor dry).

### M3 — Availability engine
- `domain/availability` (intervals, buffers, peak capacity) — pure and exhaustively tested.
- Migration `0005`; `check_availability` and `reserve_inventory` SQL functions; holds with expiry; blocks; rules (lead time, closed days).
- Admin: blocks/maintenance management, simple per-product calendar list.
- **Tests:** all scenarios in DATABASE.md §6.3 including the concurrency race and DST.

### M4 — Pricing engine (+ service areas, tax)
- `domain/pricing` rule engine with itemized output; migration `0006`; service-area resolution incl. mileage rule (needs D15 provider, otherwise manual review); location-based tax with per-component taxability (ADR 0004).
- Admin: pricing rules, tax jurisdictions/rates/taxability, service areas (ZIP/city lists, mileage rule).
- **Tests:** base, extra hours, overnight, multi-day (+25 % of base per extra day), mileage (≤5 mi free, 5.1 mi, beyond max), quantity, discount percent/fixed/code, min charge, delivery, taxability per component (rental/delivery/labor/fee/discount), unresolved jurisdiction warning, rounding, negative totals prevented, unknown rule type rejected, deterministic output snapshot tests.

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

Still open:

1. **D15 — mileage delivery:** distance provider, depot address, one-way vs round trip, mile rounding, maximum distance.
2. **D16 — wind threshold:** informational only, or staff "weather hold" blocking wind-sensitive products?
3. Exact Tennessee tax configuration (rates, taxability of delivery/labor/fees) — before production.
4. A sample ERS CSV export (a few rows is enough) to build the mapping preset.
5. Do they sell packages/bundles today (D5)?
6. ZIP/city delivery zones, if any, in addition to mileage.
7. Discounts in use today (weekday, multi-item, promo codes)?
8. Who on the team gets which role?
9. How should "send quote" reach the customer in Phase 1 (copy link, their own email, platform email)?
10. Platform/brand name and domain for the SaaS (D7).
