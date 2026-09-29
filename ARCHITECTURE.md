# Architecture

> Status: **Accepted for Phase 1** (decisions D1–D4, D11, D13 accepted 2026-09-28; see §12).
> Companion documents: [`DATABASE.md`](./DATABASE.md) (schema, RLS, availability SQL) and [`MVP.md`](./MVP.md) (scope, milestones, acceptance criteria).

## 1. What we are building

An AI-native, multi-tenant commerce platform for party and event rental companies. The core promise:

> "Your website becomes an AI salesperson that actually knows your inventory and can close the booking."

Tiky Jumps Inflatables LLC is **tenant #1**, not a special case. Nothing in the code base may reference Tiky Jumps by name; its branding, catalog, service areas, pricing and policies are data.

### Non-negotiable principles

1. **Tenant isolation is enforced in the database.** PostgreSQL Row Level Security (RLS) is the primary boundary; application checks are defense in depth, never the only line.
2. **The AI never originates business facts.** Availability, prices, delivery fees, product specs, policies and inventory come only from typed backend tools. The UI renders facts from tool results, not from model prose.
3. **Business logic lives on the server, in deterministic, tested modules.** Availability and pricing are pure/transactional code with unit and integration tests — not prompt instructions and not frontend checks.
4. **Money is integer minor units (cents). Time is `timestamptz` + an explicit organization time zone.** No floats, no naive local times in the database.
5. **Build seams, not features, for later phases.** Payments, contracts, routing, warehouse etc. get clean extension points (statuses, foreign-key slots, provider interfaces), not half-built code.

## 2. Technology stack

Versions are the current stable releases at the time of writing (2026-09); they are pinned in `package.json` at project initialization and upgraded deliberately.

| Concern | Choice | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router), React 19 | Server Components for catalog/admin reads; Server Actions + Route Handlers for mutations and the assistant stream. |
| Language | TypeScript 6.0.3 (pinned), `strict: true` (+ `noUncheckedIndexedAccess`) | TS 7 not yet supported by typescript-eslint; see ADR 0005. |
| Styling/UI | Tailwind CSS 4, shadcn/ui (copied components, not a runtime dep) | Tenant theming via CSS variables. |
| Database | PostgreSQL (Supabase-managed) | `btree_gist` for exclusion constraints; `pg_trgm` for fuzzy product search. |
| Auth | Supabase Auth (email + password, magic link; OAuth later) | Cookie sessions via `@supabase/ssr`. |
| Validation | Zod 4 | Single source for API input schemas **and** AI tool JSON schemas. |
| AI | OpenAI API (Responses API, function tools with strict JSON schema) | Behind an `LlmProvider` interface so the model/provider is swappable. Model ID is an env/config value, not hard-coded. |
| Hosting | Cloudflare Workers via `@opennextjs/cloudflare` | See §9. Edge `middleware.ts` (ADR 0008). |
| Media | Supabase Storage (Phase 1) | See Decision D6. |
| Tests | Vitest (unit + DB integration), Playwright (a few E2E flows) | Local Supabase via CLI (Docker) for integration tests. |
| Package manager | pnpm | |

**Deliberately not added:** an ORM (supabase-js + generated types + SQL functions are enough, and an ORM would bypass RLS by using a privileged connection), a state-management library, a separate API server, a job queue (until needed), LangChain-style agent frameworks (the tool loop is ~200 lines we want to own and audit).

## 3. System overview

```
                        ┌──────────────────────────── Cloudflare ─────────────────────────────┐
 Customer browser ─────▶│  WAF / rate limiting                                                │
 (tenant domain or      │   │                                                                 │
  slug.platform.app)    │   ▼                                                                 │
                        │  Next.js (OpenNext on Workers)                                      │
 Staff browser ────────▶│   ├─ middleware: session refresh, CSP nonce, request id (ADR 0008)  │
 (admin)                │   ├─ app/(storefront)   public catalog + AI assistant UI            │
                        │   ├─ app/(admin)        staff dashboard                             │
                        │   ├─ app/api/assistant  streaming assistant endpoint                │
                        │   └─ src/server/*       services, domain logic, AI orchestrator     │
                        └──────────┬──────────────────────────────┬───────────────────────────┘
                                   │ supabase-js (HTTPS)          │ HTTPS
                                   ▼                              ▼
                   ┌──────── Supabase ────────┐          ┌──── OpenAI API ────┐
                   │ Auth  (JWT)              │          │ Responses API      │
                   │ PostgREST → Postgres     │          │ (tool calls only;  │
                   │   RLS policies           │          │  no DB access)     │
                   │   SQL functions (RPC):   │          └────────────────────┘
                   │    reserve_inventory,    │
                   │    check_availability …  │
                   │ Storage (product media)  │
                   └──────────────────────────┘
```

The model sits **outside** the trust boundary. It can only ask the server to run a tool; the server decides whether and how.

## 4. Repository structure

Single Next.js application, not a monorepo. Domain modules are separated by folder and import rules; if a second deployable appears (e.g. a worker for SMS), we extract `src/domain` into a package then.

```
.
├── ARCHITECTURE.md  DATABASE.md  MVP.md  README.md
├── docs/
│   └── decisions/                 # ADRs (one file per significant decision)
├── supabase/
│   ├── config.toml
│   ├── migrations/                # timestamped SQL, the ONLY way schema changes
│   ├── seed.sql                   # generic dev fixtures: 2–3 fake orgs, users per role
│   └── tests/                     # SQL-level tests (RLS matrix, constraints) if pgTAP adopted
├── seeds/
│   └── tenants/
│       └── tiky-jumps/            # tenant import bundle (JSON/CSV + media manifest), data only
├── scripts/
│   ├── import-tenant.ts           # validated, idempotent tenant importer
│   └── gen-types.ts               # supabase gen types → src/types/database.ts
├── src/
│   ├── app/
│   │   ├── (storefront)/          # public, tenant-resolved: /, /c/[category], /p/[slug], /assistant
│   │   ├── (admin)/admin/         # products, categories, availability, customers, events,
│   │   │                          # quotes, conversations, settings
│   │   ├── (auth)/                # sign-in, invite acceptance, org switcher
│   │   └── api/
│   │       ├── assistant/route.ts # streaming chat endpoint
│   │       └── health/route.ts
│   ├── domain/                    # PURE business logic — no I/O, no Supabase, no React
│   │   ├── availability/          # interval math, buffers, capacity calculation
│   │   ├── pricing/               # rule engine, itemized calculation
│   │   ├── quotes/                # totals, status state machine
│   │   ├── events/                # event draft / slot completeness
│   │   ├── money.ts  time.ts      # cents helpers, tz-aware range builders
│   │   └── errors.ts              # typed DomainError codes
│   ├── server/                    # server-only (enforced by `import "server-only"`)
│   │   ├── db/                    # Supabase client factories (user / public / system)
│   │   ├── tenancy/               # host → organization resolution, org context
│   │   ├── auth/                  # session, requirePermission(), role→permission map
│   │   ├── repositories/          # typed data access per aggregate (thin)
│   │   ├── services/              # use cases: catalogService, quoteService, …
│   │   ├── ai/
│   │   │   ├── orchestrator.ts    # conversation loop, tool dispatch, limits
│   │   │   ├── provider/          # LlmProvider interface + OpenAI implementation
│   │   │   ├── tools/             # one file per tool: schema + handler + policy
│   │   │   ├── prompts/           # versioned system prompts
│   │   │   └── guardrails/        # output grounding validator
│   │   ├── audit/                 # audit log writer
│   │   └── rate-limit/            # RateLimiter interface + implementations
│   ├── components/
│   │   ├── ui/                    # shadcn/ui primitives
│   │   ├── storefront/  admin/  assistant/
│   ├── lib/                       # client-safe utilities (formatting, cn())
│   └── types/
│       ├── database.ts            # GENERATED from Supabase — never hand-edited
│       └── index.ts               # shared DTOs re-exported for UI
├── tests/
│   ├── integration/               # against local Supabase: RLS, reservations, services
│   ├── e2e/                       # Playwright
│   └── fixtures/
├── .env.example                   # every variable, no values
└── wrangler.jsonc  open-next.config.ts
```

**Layering rules** (enforced with ESLint `no-restricted-imports`):

- `src/domain/**` imports nothing from `server/`, `app/`, Supabase or OpenAI.
- `src/components/**` and client code never import `src/server/**`.
- Only `src/server/db/system.ts` may read `SUPABASE_SERVICE_ROLE_KEY`, and only allow-listed modules may import it (see §6.4).
- Route handlers / server actions are thin: validate input → call a service → map result.

## 5. Multi-tenancy model

- `organizations` is the tenant root. **Every tenant-owned row carries `organization_id`**, including child tables (e.g. `quote_items`), so each table's RLS policy is a direct, index-backed check with no joins.
- Child → parent foreign keys are **composite** `(organization_id, parent_id)` referencing `UNIQUE (organization_id, id)` on the parent. The database therefore rejects a quote item from org A pointing at a product in org B, even if application code is buggy.
- A user may belong to several organizations (`organization_members`). The active organization for admin requests is chosen by the user (org switcher, stored in a cookie) and **re-verified against membership on every request**; RLS independently verifies it again.
- **Public tenant resolution:** `organization_domains` maps a host to an organization (`tikyjumps.com`, `tiky-jumps.<platform-domain>`). Middleware resolves host → `organization_id` server-side. The public organization is **never** taken from a request body or query parameter.
- Branding (logo, colors, phones, email, website), policies, time zone, currency and operational defaults are per-organization data. The storefront theme is CSS variables populated from `organization_settings`.

## 6. Security boundaries

### 6.1 Trust zones

| Zone | Trust | May do |
|---|---|---|
| Browser (public) | Untrusted | Read published catalog via server; send chat messages; submit quote requests. |
| Browser (staff) | Authenticated, still untrusted input | Everything goes through server actions with Zod validation + RLS. |
| LLM | **Untrusted** (treated like a user) | Request tool calls from an allow-listed set; arguments validated like user input. |
| Next.js server | Trusted | Holds secrets; resolves tenant; runs domain logic. |
| Postgres | Final authority | RLS, constraints, exclusion constraints, transactional functions. |

### 6.2 Three database access contexts

All Supabase clients are created by factories in `src/server/db/`:

1. **User context** (`createUserClient()`): anon key + the signed-in user's JWT from cookies. **RLS enforced.** Used for all admin/staff reads and writes. This is the default.
2. **Public context** (`createPublicClient()`): anon key, no user. RLS allows reading only published catalog data of active organizations, exposed through narrow views/functions that omit internal fields (cost, internal notes, unit serials).
3. **System context** (`createSystemClient()`): service-role key, **bypasses RLS**. Used only for (a) anonymous/public-assistant writes per ADR 0001 (customer lead, event draft, conversation, quote draft, temporary booking request, `ai_actions`), (b) tenant import, (c) future background jobs. Every system-context repository function takes an explicit `organizationId` that **must come from server-side tenant resolution**, and every query is filtered by it. Integration tests assert cross-tenant writes fail in this layer too.

Where an operation must be atomic or is security-sensitive (reserving inventory, allocating quote numbers, accepting a quote), it is a `SECURITY DEFINER` Postgres function that performs its own authorization check (`app.has_permission(...)` or an explicit tenant argument check) and sets `search_path = ''`. supabase-js cannot run multi-statement transactions over PostgREST, so this is also the correctness mechanism for race conditions.

### 6.3 Authentication & authorization

- Supabase Auth issues JWTs; the server validates the session with `supabase.auth.getUser()` (server-verified), never by trusting a decoded cookie alone.
- Roles (Phase 1): `owner`, `admin`, `office`, `staff`. Roles map to **permissions** (`catalog.write`, `quotes.write`, `settings.write`, `members.manage`, …) in a `role_permissions` table. RLS and the app both check permissions, not role names, so adding `driver` or `warehouse` is a data change plus enum value, not a policy rewrite.
- Invitations are single-use, expiring, hashed tokens; only `members.manage` holders can create them; only an `owner` can grant `owner`.
- Staff accounts should enable MFA (Supabase TOTP) — enforce for `owner`/`admin` once available in the UI (Decision D9).

### 6.4 Other controls

- **Secrets:** only in environment variables / Cloudflare secrets. `.env*` git-ignored except `.env.example`. Secret scanning in CI. Nothing with `NEXT_PUBLIC_` prefix may hold a secret; a CI check greps for service-role usage outside the allow-list.
- **Input validation:** every server action, route handler and AI tool validates with Zod at the boundary; the DB re-validates with `CHECK` constraints.
- **Rate limiting:** a `RateLimiter` interface with keys per (organization, IP/visitor, route). Production: Cloudflare WAF rules for coarse limits + Workers Rate Limiting binding for fine-grained app keys; tests/dev: in-memory. The assistant additionally has per-conversation budgets (messages, tool calls, tokens) and per-organization daily AI spend caps.
- **Bot/abuse protection:** Cloudflare Turnstile on the first assistant message and on quote submission (Decision D10).
- **Output safety:** React escaping; no `dangerouslySetInnerHTML` on model or user text; markdown from the model rendered with a restricted renderer.
- **Headers:** CSP, HSTS, `frame-ancestors`, `Referrer-Policy` set in middleware.
- **Audit logging:** append-only `audit_logs` (no UPDATE/DELETE grants). Written by (a) DB triggers on sensitive tables (members, settings, pricing rules, products, quotes status) and (b) the service layer for semantic actions ("quote sent"). AI-initiated writes are recorded with `actor_type = 'ai'` and the `ai_action_id`.
- **PII:** customer phone/email are tenant data, visible only to that tenant's staff. Conversation transcripts are retained per a configurable retention period (Decision D8).

## 7. Domain modules

### 7.1 Catalog

`products` (the listing a customer sees) → `product_variants` (the rentable SKU; every product has a default variant) → inventory (either `inventory_units` for serialized items or a pooled quantity on the variant). Structured, typed columns hold everything the AI must reason about (capacity, ages, dimensions, power, water, wet/dry, operator, setup time). JSONB is reserved for truly open-ended attributes (`extra_specs`) that are not used for filtering or claims. See DATABASE.md §4.

### 7.2 Availability engine

The hardest correctness problem in the product. Approach:

1. **Everything is a time range.** A reservation occupies `[event_start − setup_buffer, event_end + teardown_buffer)` — buffers resolved through the variant → product → category → org chain (ADR 0003) as a `tstzrange` (half-open, so back-to-back bookings are allowed). Multi-day and overnight rentals are simply longer ranges; no date-bucketing.
2. **Two tracking modes per variant:**
   - **Serialized** (inflatables, trains, foam machines): each physical unit is an `inventory_units` row. A reservation allocates specific units. A PostgreSQL **exclusion constraint** — `EXCLUDE USING gist (inventory_unit_id WITH =, occupied_period WITH &&) WHERE (status IN ('held','confirmed'))` — makes double-booking a unit physically impossible, regardless of concurrency.
   - **Pooled** (chairs, tables): a quantity on the variant. Reservation calls take a transaction-scoped advisory lock on the variant, sum overlapping active allocations, and reject if `booked + requested > pooled_quantity`.
3. **Blocks** (`availability_blocks`): organization-wide blackout dates, product/variant-wide blocks, or unit-level maintenance windows, all as ranges. **Weather blocks** (ADR 0010) are separate, staff-confirmed records that make wind-sensitive products report `WEATHER_BLOCK`; overlapping bookings are flagged, never auto-cancelled.
4. **Two operations, one source of truth** (implemented; see DATABASE.md §6.2 for the full function list, including hold renewal, atomic replacement and weather-block confirmation):
   - `check_availability(...)` — read-only, returns `{available, available_quantity, requested_quantity, reasons[]}`. Used by search and the AI. It is advisory: the world can change a second later.
   - `reserve_inventory(...)` — the only way to take inventory. Runs in one transaction; for serialized items picks free units (`FOR UPDATE SKIP LOCKED`), inserts allocations, and relies on the exclusion constraint as the final guarantee. Fails with a typed error (`INSUFFICIENT_AVAILABILITY`) rather than overbooking.
5. **Holds (ADR 0002):** draft quotes hold nothing. A booking request creates allocations with `status = 'held'` and `hold_expires_at = now() + organization_settings.booking_hold_minutes` (default 15). Staff confirmation turns them `confirmed`. Expired holds are ignored by availability queries immediately (predicate on `hold_expires_at > now()`), and swept to `released` by a periodic job — correctness never depends on the sweeper running.
6. **Pure core + SQL enforcement.** Interval math, buffer expansion, and capacity-over-time calculation live in `src/domain/availability` and are unit-tested exhaustively; the SQL functions implement the same semantics and are tested by integration tests including a concurrency test (N parallel reservations for the last unit → exactly one succeeds).

Rationale and SQL: DATABASE.md §6.

### 7.2.1 Concurrency protocol (ADR 0014)

Every write that can reduce availability takes the organization advisory lock (shared, or
exclusive for organization-wide changes) and then per-variant locks, in a fixed order. The same
applies to holds, confirmations, renewals, quantity and unit changes, blocks, weather confirmation
and settings. The database is the final authority: capacity-reducing edits that would strand a
booking fail with `CAPACITY_IN_USE`.

Booking workflow lock order (ADR 0015 §10–11): event row (only when an event is edited) → quote
row → booking-request row → organization and variant advisory locks → reservation rows.

### 7.3 Pricing engine

Implemented in M4 (ADR 0013). Sample outputs against the Tiky Jumps configuration are in `docs/pricing-review.md`.

- **Pure, deterministic TypeScript**: `calculatePrice(input) → PriceResult` in `src/domain/pricing/engine.ts`. It does no I/O and reads no clock. Integer cents, basis points, half-up rounding.
- **Input** (`PricingInput`), assembled by `src/server/pricing/run.ts` from the tenant-checked SQL functions `pricing_context`, `tax_context` and `delivery_area_context`:
  - line items with a resolved base price, included duration, `overnight_allowed` and the org time zone;
  - the rules;
  - the delivery result;
  - tax context;
  - discount codes;
  - manual adjustments (staff only).
- **Rules** (`pricing_rules`): `extra_hour`, `overnight`, `additional_day`, `attendant_fee`, `fee`, `discount_percent`, `discount_fixed`, `minimum_charge`. Each has Zod-validated `params` mirrored by a DB CHECK. Precedence is variant > product > category > organization, then priority. Optional discount code and validity dates.
- **Duration:** billable days = max(1, ceil(hours / 24)).
  - Same local date: base plus extra hours beyond the included duration.
  - Crossing local midnight: the overnight rule.
  - Multi-day: `additional_day` (e.g. +25 % of base per day).
- **Missing configuration → `manual_review_required`** with reason codes, never a guessed or $0 charge.
- **Output:** `lines[]` (each with kind, tax component, taxable flag, rule id and revision), `taxLines[]` and `summary`. The summary has `base`, `extra_hours`, `overnight`, `additional_days`, `quantity`, `add_ons`, `labor`, `fees`, `delivery`, `discounts`, `adjustments`, `subtotal`, `taxable_subtotal`, `tax`, `total` and `manual_review_required`. It also carries `appliedRules` (id, revision) and `reviewReasons`.
- **Tax (ADR 0004):**
  - The jurisdiction comes from the event address (depot for pickup).
  - Taxability is set per component: rental, add_on, delivery, labor, fee, discount, adjustment.
  - A missing rule, a `test` jurisdiction or a boundary ZIP triggers review.
- **Trust boundary (ADR 0014):** callers submit only items, quantities, times, address, codes and (staff) reasoned adjustments. The request schema is strict. Only server code, through the trusted gateway (service role), stores calculations and cached distances.
- **Snapshots:** `pricing_calculations` is an immutable record of input, output, input hash and engine version. Historical prices never change when rules or base prices change. `verifyStoredCalculation` reproduces them.

### 7.4 Delivery / service areas

Delivery is priced before the engine runs (`src/domain/delivery/quote.ts`, ADR 0009):

1. Active service areas decide *where* delivery is offered. A ZIP or city+state match yields `flat`, `mileage` or `manual_review`. If areas are configured and none matches, the result is manual review. If no areas are configured, mileage applies everywhere.
2. Mileage uses one-way (or round-trip, if configured) **road** distance from the depot. It comes from a `DistanceProvider`: Google Routes API `computeRoutes`, DRIVE, traffic-unaware. The first N miles are free, then the per-mile rate applies to billable miles rounded up (8.2 mi → 4 × $4 = $16). Beyond `maximum_delivery_miles`, the result is manual review.
3. Distances are cached per org, provider, provider version and route key for up to 30 days. Provider failure, an unresolvable address, or no route all lead to manual review, and the failure is not cached.

### 7.5 Customers, events, quotes (implemented in M5, ADR 0015)

- `customers`: per organization, matched by email (case-insensitive) then phone. Public input
  never overwrites existing values.
- `events`: local date/time as stated. The database derives the instants DST-safely: a
  nonexistent time is rejected and an ambiguous one needs `time_fold`.
- `quotes` reference an immutable `pricing_calculations` snapshot.
  - Totals and `quote_items` are derived from it by triggers and cannot be written.
  - Status transitions are enforced by the database (mirrored in `domain/quotes/state-machine.ts`).
  - A price flagged for manual review needs a staff sign-off before it can be sent, accepted or
    confirmed.
  - Re-pricing is draft-only and creates a new snapshot.
  - Quote numbers come from a per-organization counter, with a prefix setting.
- `booking_requests` own the 15-minute hold (ADR 0002). Staff confirmation re-validates
  availability, and an expired hold is re-reserved only if the stock is still free. Declining or
  cancelling releases the hold.
- **Public flow**: `/quote` → `/q/<token>`. The server uses the host-resolved tenant, strict
  schemas, the trusted gateway's explicit functions, rate limits and audit entries. No
  anonymous database writes.

## 8. AI Event Assistant

### 8.1 Flow

```
customer message
   │
   ▼
POST /api/assistant  (tenant resolved from host; Turnstile + rate limit; conversation loaded)
   │
   ▼
orchestrator.run(conversation)
   ├─ build context: system prompt (versioned) + org profile summary (from DB)
   │                 + current event draft + today's date in org time zone
   ├─ loop (max N tool rounds, max M tool calls, token budget):
   │     model → tool_call(name, args)
   │        → registry.lookup(name) → Zod validate args → policy check
   │        → handler(ctx, args)   [ctx.organizationId injected by server]
   │        → ai_actions row (input, output, status, latency)
   │        → structured result back to model
   ├─ model final output: { message, recommendations[], questions[], needs_human[] }  (strict schema)
   ├─ grounding validator (§8.4)
   └─ persist messages; stream to client
   │
   ▼
UI renders recommendation cards from TOOL RESULTS (price, availability) + model explanation text
```

### 8.2 Tool layer

Each tool is one module:

```ts
export const checkAvailability = defineTool({
  name: "check_availability",
  description: "Check whether a product can be rented for a time window. …",
  input: z.object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().optional(),
    start: zIsoLocalDateTime,          // interpreted in the organization's time zone
    end: zIsoLocalDateTime,
    quantity: z.int().min(1).max(50).default(1),
  }),
  output: AvailabilityResult,           // Zod schema, also used to type the handler
  access: "public",                     // public | staff
  effect: "read",                       // read | write
  handler: (ctx, input) => availabilityService.check(ctx.organizationId, input),
});
```

- **`organizationId` is never a model-supplied argument.** It is injected from the server-side tenant context. (The example signature in the product brief includes it; in our implementation it is part of the tool *context*, not the tool *input*, which removes an entire class of cross-tenant prompt-injection attacks.)
- JSON schemas sent to the model are generated from the Zod input schemas (strict mode), so the model's contract and the server's validation cannot drift.
- Tools return **structured results with stable IDs and a `fact_id`** (e.g. an availability check result ID, a price calculation ID) that the final answer must reference.
- Errors are returned to the model as structured, non-sensitive codes (`NOT_SERVED`, `INSUFFICIENT_AVAILABILITY`, `OUTSIDE_LEAD_TIME`, `INVALID_INPUT`) — never stack traces or SQL.
- Write tools are idempotent (idempotency key = conversation + tool call ID) so model retries don't create duplicate customers/quotes.

Phase 1 tool set:

| Tool | Access | Effect | Purpose |
|---|---|---|---|
| `search_products` | public | read | Filter by category, capacity, age, wet/dry, event type, footprint, price ceiling, text. Returns published fields only. |
| `get_product_details` | public | read | Structured specs + public media for one product. |
| `check_availability` | public | read | Per product/variant, time window, quantity. |
| `calculate_price` | public | read | Itemized pricing for a candidate cart + event; persists a calculation record. |
| `check_service_area` | public | read | Serviceability + delivery fee for an address/ZIP/city. |
| `get_business_policies` | public | read | Returns the org's published policies (weather, cancellation, deposit text). |
| `update_event_details` | public | write | Merge extracted slots into the conversation's event draft (validated). |
| `create_customer` | public | write | Create/match customer from contact details the customer provided. |
| `create_event` | public | write | Persist the event from the draft. |
| `create_quote` / `add_quote_item` | public | write | Create a `draft` quote; items priced by the pricing engine, never by the model. |
| `request_human_followup` | public | write | Flag conversation for staff with reason. |

Staff-only tools (admin copilot) are out of Phase 1 scope but the `access` field reserves the path.

### 8.3 Progressive information gathering

The event draft is structured state on the conversation, updated only via `update_event_details`. `domain/events` computes what is *needed for the next step*:

- To **recommend**: guest/children count **or** age range (at least one); wet/dry preference if water products are candidates.
- To **check availability**: date + start/end (defaults from org settings if customer gives only a date, clearly stated as an assumption).
- To **price delivery**: ZIP or city.
- To **create a quote**: name + (email or phone).

The system prompt instructs the model to ask at most one or two questions per turn, prioritizing whatever blocks the next step, and to show useful results as early as possible (e.g. suggest suitable products before asking for the ZIP). Relative dates ("Saturday") are resolved against the org's local date provided in context and echoed back for confirmation.

### 8.4 Grounding guardrails (defense in depth)

1. **Rendering from data:** recommendation cards display name, photo, price and availability pulled from the referenced tool results, not from model text. If the model recommends a product without a successful `check_availability`/`calculate_price` result in this conversation, the card shows "Check availability" / "Get price" instead of a claim.
2. **Structured final output:** each recommendation must include `product_id`, `availability_fact_id`, `price_fact_id`, and `reasons[]` where each reason cites a product attribute key (e.g. `recommended_capacity`, `minimum_age`) that the server checks exists and is non-null.
3. **Text validator:** the free-text `message` is scanned for currency amounts and availability/delivery claims; any dollar amount not present in this turn's tool results, or an "available" claim without a confirming result, triggers one corrective re-generation and otherwise falls back to a safe templated message. Violations are logged to `ai_actions` for review.
4. **Human confirmation:** tool results carry `requires_confirmation` (e.g. area flagged for manual review, special surfaces, long multi-day rentals) and the model must relay it; the UI shows a badge.
5. **Prompt injection posture:** customer text is untrusted; tools only expose public data; no tool can read another tenant, internal notes, or other customers; write tools only create drafts; per-turn/per-conversation budgets cap runaway loops.

### 8.5 Observability & evaluation

- `ai_actions` records every tool call (name, validated input, output summary, status, error code, latency, model, prompt version, token usage).
- Conversations are reviewable in admin.
- A scripted **evaluation suite** (fixture catalog + canned conversations) runs against a mocked provider in CI (deterministic tool-dispatch/validation tests) and against the live model on demand (behavioral evals: "never states unconfirmed price", "asks for ZIP before promising delivery").

## 9. Deployment architecture

- **Runtime:** Next.js built with OpenNext for Cloudflare Workers (Node.js compatibility mode). All Supabase access is over HTTPS (supabase-js / PostgREST / RPC), which fits the Workers model; no long-lived Postgres connections from the edge. If direct SQL is ever needed, Cloudflare Hyperdrive is the path.
- **Environments:**

  | Env | Next.js | Supabase | Data |
  |---|---|---|---|
  | local | `next dev` | Supabase CLI (Docker) | `supabase/seed.sql` fake tenants |
  | preview | Workers preview per PR | shared **staging** project | seeded fixtures |
  | staging | Workers (staging) | staging project | fixtures + optional anonymized Tiky Jumps catalog import |
  | production | Workers (prod) | production project | real tenants |

  Production data is never copied to lower environments. Tiky Jumps' catalog (non-PII) can be imported anywhere via `scripts/import-tenant.ts`.
- **Migrations:** only via `supabase/migrations`, applied by CI (`supabase db push`) to staging on merge to `main`, and to production on a tagged release with manual approval. Migrations are forward-only; destructive changes use expand/contract.
- **Config:** `.env.example` documents every variable; runtime config parsed and validated by a Zod schema at startup (fail fast). Secrets in Cloudflare secrets / GitHub Actions secrets.
- **CI (GitHub Actions):** install → typecheck → lint → unit tests → start local Supabase → apply migrations → integration tests (RLS, availability concurrency) → build → (on main) deploy staging.
- **Custom domains:** tenants point a CNAME at the platform; Cloudflare for SaaS (custom hostnames) handles TLS. Phase 1 can run on `<slug>.<platform-domain>` plus Tiky Jumps' domain configured manually.

## 10. Testing strategy

| Layer | Tool | Priority coverage |
|---|---|---|
| Domain unit | Vitest | Interval overlap incl. half-open edges, buffers, multi-day/overnight, capacity over time; pricing rules, rounding, discounts, tax, negative/zero cases; quote totals; state machine illegal transitions; event completeness. Property-based tests for interval math where valuable. |
| DB integration | Vitest + local Supabase | **Tenant isolation matrix:** for each tenant table × {anon, member of A, member of B, each role} × {select, insert, update, delete}, assert allowed/denied. Composite FK cross-tenant rejection. Exclusion constraint. **Concurrency:** 10 parallel `reserve_inventory` for the last unit → exactly 1 success. Pooled quantity limits. Holds expiring. |
| Service | Vitest | Authorization (`requirePermission`), system-context functions reject mismatched tenants, audit rows written. |
| AI tools | Vitest (mock provider) | Invalid args rejected; `organizationId` cannot be injected; unknown tool rejected; budgets enforced; grounding validator catches fabricated prices/availability; idempotent writes. |
| E2E | Playwright | Browse catalog → product → ask assistant (mock provider) → quote created; staff sign-in → edit product → audit log entry; staff of org B cannot open org A's quote URL. |
| AI evals | Script, on demand | Behavioral scenarios against the real model. |

Failure cases are first-class: every "should succeed" test has at least one sibling "should be rejected" test.

## 11. Extension seams for later phases

| Future feature | Seam provided in Phase 1 |
|---|---|
| Payments (Stripe) | Quote `accepted` transition hook; `quotes.deposit_*` nullable columns; `payments` table will reference `(organization_id, quote_id)`. |
| Contracts / e-sign | `organization_policies` versioned; quote acceptance snapshot. |
| Orders / bookings | `reservations` already decoupled from quotes; an `orders` table will own reservations after acceptance. |
| Routing / drivers | Events store normalized address + nullable lat/lng; `driver`, `warehouse` roles addable. |
| Warehouse | `inventory_units` with status/condition; maintenance blocks. |
| Mileage delivery | `DistanceProvider` interface; `service_area_rules.rule_type` enum extensible. |
| SMS / email | `organization_settings.sms_phone`; customer consent flags; conversations have a `channel` column. |
| Admin AI copilot | Tool `access: "staff"` path. |
| Billing the tenants (SaaS plans) | `organizations.plan`, `status`; per-org AI usage metering from `ai_actions`. |

## 12. Architectural decisions

Accepted decisions have ADRs in [`docs/decisions/`](./docs/decisions/README.md).

| # | Decision | Status / outcome |
|---|---|---|
| D1 | Public-assistant / anonymous writes | **Accepted** ([ADR 0001](./docs/decisions/0001-anonymous-write-path.md)): server-side write path only, org resolved from host, validated, rate-limited, audited. No anon DB writes. |
| D2 | Do quotes hold inventory? | **Accepted** ([ADR 0002](./docs/decisions/0002-inventory-holds.md)): draft = no hold; booking request = 15-min hold (org-configurable); confirmed = firm reservation. Expired holds release automatically. |
| D3 | Rental rules, buffers, lead time | **Accepted** ([ADR 0003](./docs/decisions/0003-rental-rules-as-configuration.md)): configuration with variant → product → category → org → platform override chain. Defaults 60/60 min buffers, 12 h lead time. |
| D4 | Tax | **Accepted** ([ADR 0004](./docs/decisions/0004-tax-engine.md)): jurisdiction from event location; configurable rates; per-component taxability. Tennessee treatment validated before production. |
| D5 | Bundles/combos | Proposed: combos = single product; packages = future `product_components`. Confirm whether Tiky Jumps sells packages. |
| D6 | Media storage | Proposed: Supabase Storage in Phase 1, provider-agnostic `product_media`. |
| D7 | Platform domain & tenant URL scheme; product name | **Open.** Host-based resolution implemented; dev fallback `?tenant=` / `DEV_TENANT_SLUG` only when `NODE_ENV !== 'production'`. |
| D8 | Conversation retention & privacy notice | Open (M7). |
| D9 | MFA for owner/admin | Proposed yes; TOTP enabled in Supabase config; enforcement UI in M8. |
| D10 | Turnstile on assistant & quote submission | Proposed yes (M7). |
| D11 | TypeScript version | **Accepted** ([ADR 0005](./docs/decisions/0005-typescript-version.md)): TS 6.0.3 pinned; TS 7 blocked by typescript-eslint peer range. |
| D12 | OpenAI model & per-tenant cost ceiling | Open (M7). |
| D13 | Tiky Jumps import & media rights | **Accepted** ([ADR 0006](./docs/decisions/0006-inventory-import-and-media-rights.md)): CSV-first staged import (ERS export → preview → mapping → validation → commit); media rights metadata; no cross-tenant media. |
| D14 | Public availability granularity | Proposed: public boolean + "limited"; staff exact counts. |
| D15 | Delivery distance & pricing | **Accepted** ([ADR 0009](./docs/decisions/0009-delivery-distance-pricing.md)): `DistanceProvider` abstraction, one-way road distance from primary depot, 5 free miles, $4/mi, ceil to whole mile, configurable max → `manual_review`; cached lookups. |
| D16 | Weather safety | **Accepted** ([ADR 0010](./docs/decisions/0010-wind-safety.md)): per-hazard rules (wind, lightning, rain, severe weather, temperature, custom) at org/category/product level; Tiky Jumps inflatables 15 mph wind; staff-confirmed `weather_blocks`; bookings flagged, never auto-cancelled. |
