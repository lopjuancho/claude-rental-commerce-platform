# 0017 — AI sales assistant: the model talks, the backend decides

**Status:** Accepted 2026-10-02 · Implemented in M7 (migration `20261002000100_m7_assistant.sql`,
`src/server/ai/`)

## Context

The storefront gets a conversational assistant that helps a visitor find products, check dates,
get a price, build a quote and request a booking. A language model is fluent but not
authoritative: it must never be the source of a price, availability, service area, delivery fee,
tax, policy, inventory figure or booking status. M3–M5 already implement all of those
deterministically and safely for anonymous visitors (ADR 0001, 0014, 0015).

## Decisions

1. **The AI boundary is `src/server/ai/`.** The model can do exactly one thing: ask the server to
   run one of ten named tools with JSON arguments. It never sees or supplies an organization id,
   SQL, Supabase clients, the service role, quote tokens or record ids other than those the tools
   return. Modules:
   - `schemas.ts` — strict Zod schemas for every tool's arguments (unknown keys rejected) and the
     JSON Schema sent to the provider;
   - `tools.ts` — the tool implementations, each a thin adapter over an existing service;
   - `policy.ts` — system prompt, required-field rules and the grounding validator;
   - `context.ts` — per-turn context: tenant, session, page context, request meta;
   - `assistant.ts` — the turn loop (budgets, persistence);
   - `provider.ts` / `providers/*` — `LlmProvider` abstraction (OpenAI; scripted test double);
   - `telemetry.ts` — `ai_actions` rows and correlation ids;
   - `session.ts` — the opaque session cookie and conversation store.
2. **Tenant = host, always.** Tools receive the `ResolvedTenant` from the request host through
   the turn context — never from arguments. Every tool is scoped to it; foreign or invented
   slugs/ids resolve to "not found". Customer text cannot change tools, their permissions or the
   tenant (the tool set is fixed per turn and does not depend on conversation content).
3. **Tool → existing service mapping (no new business logic):**

   | Tool | Backend |
   |---|---|
   | `search_products` | anon-safe catalog views (M6 loaders) with structured filters |
   | `get_product_details` | `loadProductBySlug` + bookable variants (M6) |
   | `check_availability` | `checkPublicAvailability` → `check_public_availability` (M3), DST-safe `localRentalPeriod` |
   | `calculate_price` | `priceForTenant` → `runPricing` (M4); manual review withholds totals |
   | `check_service_area` | `quoteDelivery` with the M4 area/mileage context and `DistanceProvider` |
   | `create_customer` | validated with `contactInputSchema`; staged in the session — the customer row is matched/created by `match_or_create_customer` inside `create_quote` (never overwrites, never discloses) |
   | `create_event` | validated with `eventInputSchema` + `localRentalPeriod` (nonexistent/ambiguous local times rejected); staged — the event row is created inside `create_quote` |
   | `create_quote` | `submitQuoteRequest` (M5): customer, event, immutable pricing snapshot, draft quote; source `assistant`, actor `ai` |
   | `add_quote_item` | before a quote: validated and staged; after: a replacement quote through `submitQuoteRequest` (snapshots are immutable), refused once a booking was requested |
   | `request_booking` | `requestPublicBooking` (M5) with the visitor cookie: 15-minute hold, per-visitor cap, stale/expired/review rules unchanged. The assistant can never confirm a booking. |

   Staging contact/event data until `create_quote` keeps the anonymous write path exactly the M5
   one (one atomic, audited public submission) instead of opening new public writes.
4. **Facts come from typed evidence, never from the model's prose** (revised in the M7 review,
   H1). The UI renders product, availability, price, service-area, quote and booking cards from
   the server's tool results. Every transactional tool result is ALSO recorded as typed evidence
   (`src/domain/assistant/evidence.ts`): availability (product, variant, window, local dates,
   quantity, result), price (subject = items + window + fulfillment + address, amounts with a
   role: line/delivery/tax/subtotal/total), catalog starting price, service area (status, fee),
   quote (number, final or not, amounts) and booking (status, hold expiry, the exact server
   message). Evidence with the same subject is superseded by newer evidence and goes stale
   (availability 15 min, prices 30 min). The model's prose is checked claim by claim
   (`src/domain/assistant/grounding.ts`): amounts in any form (symbols, codes, decimals, written
   words) must equal a CURRENT amount with the same role for the same product/date; availability
   needs the latest result for the named product and date; hold claims need a live hold;
   booking/reservation claims need a backend-confirmed booking; delivery, free-delivery and tax
   claims need a current serviceable/priced result; guarantees and payment claims are never
   supported. Only typed server messages (booking/hold) and the fixed manual-review sentence are
   exempt — never arbitrary tool strings such as product descriptions. A failing reply is
   replaced by server-written facts built from this turn's evidence (the cards stay) and logged as
   `guardrail_violation`. The prompt asks the model to refer to the cards instead of restating
   facts.
5. **Manual review is a first-class answer.** When pricing, delivery or availability cannot be
   decided deterministically, the tool returns `manual_review` with reasons and no totals; the
   assistant says the team needs to review it.
6. **Sessions.** An opaque random token in an HttpOnly, SameSite=Lax cookie (`rc_ai`); the
   database stores only its SHA-256 (`ai_conversations.session_hash`), scoped to the
   organization. State holds the staged contact/event/items and the current quote by token
   *hash* and number — never the raw quote token, card data, secrets or auth tokens. Messages are
   stored for multi-turn context (tool-call arguments with contact details redacted);
   conversations expire after 30 days (reset on next use; a sweeper and configurable retention
   come later). The raw quote link is sent to the browser once, in the turn that created it.
7. **Page context** is resolved on the server: a product or category slug is looked up among the
   tenant's published data; on a quote page the browser sends the quote token in the request
   body, the server loads the quote view and gives the model only its number, status and items —
   the token never enters the prompt.
8. **Budgets and limits** (central config `src/server/ai/config.ts`): model, max output tokens,
   max history messages/characters, max 6 tool calls and 5 model steps per turn, provider
   timeout, message length ≤ 1,000 characters; rate limits per IP (`assistant`) and per session
   (`assistantSession`). **One absolute deadline per turn** (M4): created when the request
   arrives and passed to history loading, the model (abort signal), every tool and the journal. No
   model call and no mutation STARTS after it; read tools stop waiting at it; a mutation already
   running is not cut off — it completes and is committed to the journal, then the turn ends and
   is recovered like any failed turn (§11). Persistence and telemetry get a short grace period.
   **The request is bounded before it is read** (M3): the per-IP budget is spent first by every
   request (malformed, oversized, wrong type included), then the body is streamed with a hard
   8 KiB ceiling (declared or not); the per-session budget applies once the session is known.
9. **Provider.** OpenAI Chat Completions with **strict** function calling (L1: closed schemas,
   every property required, optional ones nullable; nulls are stripped before the server's Zod
   validation, which remains authoritative), server-side only (`OPENAI_API_KEY`, never
   `NEXT_PUBLIC_*`), behind `LlmProvider`. `pnpm ai:smoke` (opt-in, `AI_SMOKE_CONFIRM=live`) runs
   a live smoke test against a deployed staging storefront; the key never leaves the server. The scripted provider is a
   deterministic test double for E2E, refused in production by env validation. Without a
   configured provider the assistant is not offered.
10. **Telemetry.** `ai_actions` records tenant, conversation, tool, status, error code, latency,
    model and correlation id (the request id) — no arguments, results or customer data. Business
    mutations are audited by the existing services with actor `ai`.

11. **Durable turns and a mutation journal** (M7 review, H2; migration
    `20261003000100_m7_turns_journal.sql`). Invariant: a retry, a provider failure, a lost
    response, a duplicate or concurrent request, or the deadline never repeats a business
    mutation and never loses the only reference to one that committed.
    - Each browser message carries a request id (reused by "Try again"). `ai_turn_begin` claims
      the conversation atomically: one active turn per conversation (a lease past the deadline);
      the same request id replays a completed turn's stored reply (quote link tokens stripped) or
      is told to wait; another message is refused as busy BEFORE anything runs.
    - Quote and booking creation go through `ai_mutations`, claimed only by the turn that owns
      the conversation (lease checked in SQL) and keyed by a semantic idempotency key:
      `create_quote` = conversation + the hashes of what is quoted + what it replaces;
      `add_quote_item` / `request_booking` = conversation + the customer request (stable across
      retries of the same message) + the occurrence within it. A committed key replays; an
      earlier attempt that never recorded its outcome is resolved from what it stored before
      running (the quote token HASH chosen up front → the quote is looked up; a live hold on the
      quote → the request committed) before anything runs again. The outcome is committed right
      after the service returns, before the model is called again.
    - Committed references (quote identity, basis and staged details) are re-applied to the
      conversation state at the start of every turn. A failed or timed-out turn saves the state
      it started from plus the references it applied — never its uncommitted staging, so retrying
      the same message cannot apply a change twice — and not its messages.
    - Residual: if an attempt's lease expires while its mutation is still in flight and a new
      attempt resolves "not found" before that mutation lands, both could complete. The lease
      (deadline + 30 s) and the per-step deadline make this a timing window of an already-failed
      request, not a normal path.
12. **One active quote, reconciled** (M7 review, H3). The active quote records hashes of the
    contact, event (date, time, address, fulfillment, details) and items it was built from. Any
    later change makes it "mismatched": `request_booking` refuses (`DETAILS_CHANGED`) until
    `create_quote` makes an updated quote that replaces it (asking again with nothing changed
    returns the same quote). A quote page's token is validated for the tenant; with no active
    quote it becomes the active one; a DIFFERENT quote than the active one is never selected
    silently — `request_booking` asks which (`AMBIGUOUS_QUOTE`) and accepts only a quote number
    the conversation holds or the customer is viewing. Items are never clamped or dropped:
    exceeding a quantity or item-count limit is an explicit refusal.

## Not in M7

Payments, SMS/email, autonomous cancellation/refund/confirmation, staff copilots, voice,
browsing, RAG/vector search, arbitrary external tools.
