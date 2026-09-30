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
4. **Facts come from tool results, never from the model.** The UI renders product, availability,
   price, service-area, quote and booking cards from the server's tool results, not from model
   text. The model's text is checked by a grounding validator: every currency amount must appear
   in a tool result of the conversation; claims of availability need an `available` result;
   booking claims ("booked", "confirmed") are never allowed; payment claims are never allowed. A
   failing reply is replaced by a neutral message (the cards stay) and logged as
   `guardrail_violation`.
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
   (`assistantSession`).
9. **Provider.** OpenAI Chat Completions with function calling, server-side only
   (`OPENAI_API_KEY`, never `NEXT_PUBLIC_*`), behind `LlmProvider`. The scripted provider is a
   deterministic test double for E2E, refused in production by env validation. Without a
   configured provider the assistant is not offered.
10. **Telemetry.** `ai_actions` records tenant, conversation, tool, status, error code, latency,
    model and correlation id (the request id) — no arguments, results or customer data. Business
    mutations are audited by the existing services with actor `ai`.

## Not in M7

Payments, SMS/email, autonomous cancellation/refund/confirmation, staff copilots, voice,
browsing, RAG/vector search, arbitrary external tools.
