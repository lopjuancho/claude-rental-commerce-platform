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
    - (Round 1 left a window: an attempt whose lease expired mid-write could race a new attempt.
      Round 2 closes it at the write itself — see §13, business idempotency.)
12. **One active quote, reconciled** (M7 review, H3). The active quote records hashes of the
    contact, event (date, time, address, fulfillment, details) and items it was built from. Any
    later change makes it "mismatched": `request_booking` refuses (`DETAILS_CHANGED`) until
    `create_quote` makes an updated quote that replaces it (asking again with nothing changed
    returns the same quote). A quote page's token is validated for the tenant; with no active
    quote it becomes the active one; a DIFFERENT quote than the active one is never selected
    silently — `request_booking` asks which (`AMBIGUOUS_QUOTE`) and accepts only a quote number
    the conversation holds or the customer is viewing. Items are never clamped or dropped:
    exceeding a quantity or item-count limit is an explicit refusal.

13. **Round 2 of the review (Codex, 40c26dd).**
    - **Complete subjects (H1):** availability claims must match product, date, the clock times
      named (inside the checked window) and the quantity named (≤ the quantity checked) of the
      LATEST result; bare "available" is a claim (catalog phrases such as "sizes available" with no
      date/time/quantity are not); booking and hold claims are evaluated for the quote they name,
      and a quote number the conversation never had is a violation; a hold's server message is
      exempt only while that hold is live and at least as long as it says. Negation is local (a
      negator among the three words before the claim, or a condition opening its clause): "No
      worries, your booking is confirmed" is a claim. Violations are stable codes
      (`GROUNDING_*`); no reply prose reaches logs or `ai_actions` (N4).
    - **Business-write idempotency (H2):** migration `20261004000100_m7_business_idempotency.sql`.
      The journal key is also the business idempotency key and is passed INTO the writes:
      `create_event_once`, `create_quote_once`, `request_booking_by_token_once` take a
      transaction-scoped lock on (organization, key), return the object already created under it,
      or run the unchanged M5 function and record key → object in the same transaction
      (`ai_business_keys`). An old worker finishing after a takeover resolves to the same event,
      quote and booking request. Recovery looks the object up by the key
      (`ai_business_object`), not by anything a later attempt generated.
    - **Immutable recorded input (H2, H3):** the first attempt records the mutation's complete
      input in `ai_mutations.pending` — the staged snapshot, its basis hashes, the replaced quote,
      the link token hash and the token SEALED to the session — and it is never replaced. Retries
      and recovery use that record, never their own view of the conversation. A recovered (or
      created) quote is compared with the database (items, quantities, event window); if they
      differ the quote is marked unverified and is never "current": booking is refused.
    - **Deadline (M4):** checked before the claim, again after it (and after any recovery lookup),
      immediately before the write. Reconciling something already committed is allowed late; a new
      write never starts after the deadline.
    - **Session before mutation (H2-C):** `rc_ai` is issued by storefront page views (like
      `rc_visitor`), the bootstrap `GET /api/assistant` and New Chat (`DELETE`, a fresh session).
      A mutation-capable `POST` never creates or sets it (`409 SESSION_REQUIRED` without one), so a
      lost first response cannot leave the retry without its conversation.
    - **New Chat race (N1):** the widget keeps a chat generation; a reply that arrives for an
      earlier generation is dropped, and since POST responses carry no session cookie a late reply
      cannot restore the old session.
    - **Working links on replay (N2):** stored replies and journal results keep quote links only
      sealed (AES-256-GCM, key derived with HKDF from the session cookie, of which the database
      only has a hash); the same session's replay reopens them.
    - **No false "saved" (N3):** if the turn cannot be saved, the conversation is released with
      only what is durable and the customer is told to resend — never that staging was saved.

14. **Round 3 of the review (Codex, efb4fca).**
    - **Every assertion, its own subject (H1):** conversational fillers ("no worries", "no
      problem", "not a problem"…) are neutralised before negation is judged, so they never make a
      following claim look negated. A server booking message is exempt only where the reply
      attributes it to that message's own quote (nearest quote number before it, or any in its
      sentence). A sentence naming several quotes needs the claimed state for EACH of them (the
      same already held for products). Quantities are also recognised in words ("five hundred
      units", "twenty-five of them", "a dozen", "1,000 units").
    - **Time-sensitive presentation is refreshed (R3-M1):** a booking request's identity is
      durable, but its state is always re-read when shown again. A replayed reply, a replayed
      journal entry and a recovered request all build their booking card and text from the
      database now (`currentBooking`): a live hold with its real end time ("held until 3:45 PM"),
      an ended hold, declined, cancelled or confirmed — never the stored "held for 15 minutes".
      Stored booking cards carry the quote's token hash for this (server-side only; stripped from
      every response).
    - **New Chat is a confirmed replacement (R3-M2):** the widget enters a resetting state;
      nothing can be sent until the DELETE has returned the new session; a failed DELETE is shown
      with "Retry new chat" and nothing is sent to the old session meanwhile; repeated clicks do
      nothing while one replacement is in flight; every await (bootstrap GET, POST, response)
      re-checks the chat generation before it continues.

15. **Round 4 of the review (Codex, bc328e3).**
    - **Every asserted subject resolved (H1):** a booking/hold claim's subjects are the quotes
      its sentence names, else those of the nearest earlier sentence naming any. Plural wording
      ("both quotes", "the bookings", "all three quotes", "they") with nothing named means EVERY
      quote of the conversation, and a stated count must match it; a plural claim that cannot be
      resolved exactly (one quote known, a count mismatch) is rejected — it never falls back to
      the latest single booking. A server booking message is exempt only when the WHOLE quote set
      its sentence (or the nearest earlier sentence naming quotes) is about is that message's own
      quote, and never under plural wording: "Quotes Q-2 and Q-1: This booking is confirmed by the
      team." is about Q-2 too. One canonical quantity parser (`parseQuantity`) serves every syntax
      — "1000", "1,000", "one thousand", "twenty five", "twenty-five", "a dozen", after
      "quantity"/"qty" or before "units" — so "quantity 1,000" is 1000, not 1.
    - **Stored prose is never an authority on replay (R3-M1):** a reply is grounded when written,
      not when replayed. Whenever a stored reply states a booking/hold status — with or without a
      card, in either polarity — the stored turn response carries server-side references (the
      booking evidence's `quoteRef`, a token hash) to every booking of the conversation, and a
      replay re-reads each one's CURRENT state and rebuilds the reply from it. A reply stored
      without references (before this change) that states a status is replaced by "The booking
      status needs to be checked again…", and its unreferenced booking cards are dropped;
      availability wording is never repeated as current ("Availability can change…"). References
      and token hashes are stripped from every HTTP response.
    - **Session generations (R3-M2):** a browser applies Set-Cookie in ARRIVAL order, so a
      bootstrap GET answered before New Chat but delivered after it could overwrite the new
      session. Session cookies are therefore named after a generation (`rc_ai` = 0 from page
      views, `rc_ai_<n>` from the bootstrap GET and New Chat), and the session in effect is always
      the highest generation present. Bootstrap/New Chat issue max(highest present + 1, the
      client's requested `?g=`), and the widget numbers those requests in send order — so two
      requests sent from the same cookie state are ordered as sent. A late, older response only
      ever writes a lower name: arrival order cannot roll N back to B. Superseded generations are
      expired by the next bootstrap/New Chat response.
    - **Smoke assertions are tenant-scoped (R4-L1):** every database check in `pnpm ai:smoke`
      uses the organization resolved from the staging host and the exact quote id resolved from
      its private link (`scripts/ai-smoke-db.mjs`), regression-tested against two tenants sharing
      a quote number.

## Not in M7

Payments, SMS/email, autonomous cancellation/refund/confirmation, staff copilots, voice,
browsing, RAG/vector search, arbitrary external tools.
