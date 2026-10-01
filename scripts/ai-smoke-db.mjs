/**
 * Database checks for the live assistant smoke test (scripts/ai-live-smoke.mjs), kept here so
 * they are regression-tested (tests/integration/ai-smoke-db.test.ts).
 *
 * Quote numbers are unique only INSIDE an organization, so every check is scoped to the staging
 * tenant's organization id AND the exact quote (its primary key, resolved from the private link
 * the assistant returned) — never a quote number alone, which another tenant can share.
 */
import { createHash } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The organization the storefront host resolves to (as the app resolves it). */
export async function resolveOrganization(db, hostname) {
  const { rows } = await db.query("select id from public.resolve_organization_by_host($1)", [
    hostname.toLowerCase(),
  ]);
  return rows[0]?.id ?? null;
}

/** The exact quote behind a private link ("/q/<token>") in this organization. */
export async function quoteByLink(db, organizationId, url) {
  const token = /^\/q\/([A-Za-z0-9_-]{43})$/.exec(url ?? "")?.[1];
  if (!token) return null;
  const { rows } = await db.query(
    "select id, quote_number from public.quotes where organization_id = $1 and token_hash = $2",
    [organizationId, sha256(token)],
  );
  return rows[0] ? { id: rows[0].id, quoteNumber: rows[0].quote_number } : null;
}

/** Booking requests for exactly these quotes of this organization. */
export async function bookingRequestsFor(db, organizationId, quoteIds) {
  const { rows } = await db.query(
    "select count(*)::int n from public.booking_requests where organization_id = $1 and quote_id = any($2::uuid[])",
    [organizationId, quoteIds],
  );
  return rows[0].n;
}

/** Test setup: make this organization's quote expired. */
export async function expireQuote(db, organizationId, quoteId) {
  const r = await db.query(
    "update public.quotes set status = 'sent', expires_at = now() - interval '1 minute' where organization_id = $1 and id = $2",
    [organizationId, quoteId],
  );
  return r.rowCount;
}

/** Test setup: change this organization's quote's event after pricing (the quote goes stale). */
export async function makeQuoteStale(db, organizationId, quoteId) {
  const r = await db.query(
    `update public.events set end_time = '13:00'
     where organization_id = $1 and id = (select event_id from public.quotes where organization_id = $1 and id = $2)`,
    [organizationId, quoteId],
  );
  return r.rowCount;
}

/** The session in effect in a cookie jar: the highest generation (`rc_ai` = 0, `rc_ai_<n>`). */
export function currentSessionToken(jar) {
  let best = null;
  for (const [name, value] of jar) {
    const m = /^rc_ai(?:_([1-9]\d*))?$/.exec(name);
    if (!m || !/^[A-Za-z0-9_-]{43}$/.test(value)) continue;
    const generation = Number(m[1] ?? 0);
    if (!best || generation > best.generation) best = { generation, value };
  }
  return best?.value ?? null;
}

/** Tools that ran successfully in this organization's conversation for this session. */
export async function toolsRun(db, organizationId, sessionToken) {
  const { rows } = await db.query(
    `select distinct a.tool_name from public.ai_actions a join public.ai_conversations c on c.id = a.conversation_id
     where c.organization_id = $1 and c.session_hash = $2 and a.status in ('ok','manual_review')`,
    [organizationId, sha256(`ai:${sessionToken ?? ""}`)],
  );
  return new Set(rows.map((r) => r.tool_name));
}

/** Quotes / booking requests of this organization's customer with this email. */
export async function countForCustomer(db, organizationId, email, kind) {
  const sql =
    kind === "quotes"
      ? `select count(*)::int n from public.quotes q join public.customers c on c.id = q.customer_id
         where q.organization_id = $1 and c.organization_id = $1 and c.email = $2`
      : `select count(*)::int n from public.booking_requests b join public.quotes q on q.id = b.quote_id
         join public.customers c on c.id = q.customer_id
         where b.organization_id = $1 and q.organization_id = $1 and c.organization_id = $1 and c.email = $2`;
  const { rows } = await db.query(sql, [organizationId, email]);
  return rows[0].n;
}

// ── final-gate checks (replay after a state change) ─────────────────────────────

const sessionHashOf = (sessionToken) => sha256(`ai:${sessionToken ?? ""}`);

/**
 * What the server stored for one turn of THIS session in this organization — without returning
 * any hash: its status and attempt, and whether its stored response carries server-side booking
 * references (refs or booking cards with a reference).
 */
export async function storedTurn(db, organizationId, sessionToken, requestKey) {
  const { rows } = await db.query(
    `select t.status, t.attempt,
            coalesce(jsonb_array_length(t.response -> 'refs' -> 'bookings'), 0) as refs,
            (select count(*)::int from jsonb_array_elements(coalesce(t.response -> 'blocks', '[]'::jsonb)) b
              where b ->> 'type' = 'booking' and b ? 'quoteRef') as booking_cards
     from public.ai_turns t join public.ai_conversations c on c.id = t.conversation_id
     where c.organization_id = $1 and c.session_hash = $2 and t.request_key = $3`,
    [organizationId, sessionHashOf(sessionToken), requestKey],
  );
  const r = rows[0];
  return r
    ? {
        status: r.status,
        attempt: r.attempt,
        bookingRefs: Number(r.refs) + Number(r.booking_cards),
      }
    : null;
}

/** Counters that change whenever the model runs or anything is appended for this session. */
export async function conversationCounters(db, organizationId, sessionToken) {
  const { rows } = await db.query(
    `select c.message_count,
            (select count(*)::int from public.ai_actions a where a.conversation_id = c.id) as actions,
            (select coalesce(sum(t.attempt), 0)::int from public.ai_turns t where t.conversation_id = c.id) as attempts
     from public.ai_conversations c where c.organization_id = $1 and c.session_hash = $2`,
    [organizationId, sessionHashOf(sessionToken)],
  );
  const r = rows[0];
  return r ? { messages: r.message_count, actions: r.actions, attempts: r.attempts } : null;
}

/**
 * Smoke-only state change: cancel the pending booking request of THIS organization's exact quote
 * through the same function the quote page uses (it releases the hold). The quote's token hash is
 * looked up inside the statement and never leaves the database. `client` must be a single
 * connection (a pg Client), since the service-role claim is set for this transaction only.
 */
export async function cancelSmokeBooking(client, organizationId, quoteId) {
  await client.query("begin");
  try {
    await client.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const { rows } = await client.query(
      `select public.cancel_booking_by_token($1,
         (select q.token_hash from public.quotes q where q.organization_id = $1 and q.id = $2)) as id`,
      [organizationId, quoteId],
    );
    await client.query("commit");
    return rows[0]?.id ?? null;
  } catch (e) {
    await client.query("rollback");
    throw e;
  }
}

/** The current status of THIS organization's exact quote's booking request. */
export async function bookingStatus(db, organizationId, quoteId) {
  const { rows } = await db.query(
    `select b.status::text as status from public.booking_requests b
     where b.organization_id = $1 and b.quote_id = $2 order by b.created_at desc limit 1`,
    [organizationId, quoteId],
  );
  return rows[0]?.status ?? null;
}

/** A smoke run tag: "ai-smoke-" + 12 hex characters. Anything else is refused. */
export const SMOKE_TAG = /^ai-smoke-[0-9a-f]{12}$/;

/**
 * Smoke-only availability change: ONE maintenance block for ONE product of this organization on
 * one (far-future) date, owned by this run (its tag). The tag is validated BEFORE the insert. The
 * window spans the whole local day in any timezone. Returns the exact block id and product id.
 */
export async function addSmokeAvailabilityBlock(db, organizationId, productSlug, isoDate, tag) {
  if (!SMOKE_TAG.test(tag ?? ""))
    throw new Error("refusing an availability block without a valid smoke tag");
  const { rows } = await db.query(
    `insert into public.availability_blocks (organization_id, product_id, period, reason, notes)
     select $1, p.id,
            tstzrange(($3::date - interval '14 hours')::timestamptz, ($3::date + interval '38 hours')::timestamptz),
            'maintenance', $4
     from public.products p where p.organization_id = $1 and p.slug = $2
     returning id, product_id`,
    [organizationId, productSlug, isoDate, tag],
  );
  return rows[0] ? { id: rows[0].id, productId: rows[0].product_id } : null;
}

/**
 * Removes exactly ONE block: this organization's, with this id, for this product, carrying this
 * run's tag. Returns how many rows were deleted (0 or 1).
 */
export async function removeSmokeAvailabilityBlock(db, organizationId, block, tag) {
  if (!SMOKE_TAG.test(tag ?? ""))
    throw new Error("refusing to remove a block without a valid smoke tag");
  const r = await db.query(
    `delete from public.availability_blocks
     where organization_id = $1 and id = $2 and product_id = $3 and notes = $4`,
    [organizationId, block.id, block.productId, tag],
  );
  return r.rowCount;
}

/**
 * Whether the smoke booking's inventory is released, by the availability engine's OWN predicate
 * (app.allocation_is_active: confirmed, or held with an unexpired hold). A residual allocation row
 * that no longer blocks (e.g. an expired hold) does not count; `residualAllocations` reports rows.
 */
export async function bookingHoldReleased(db, organizationId, quoteId) {
  const { rows } = await db.query(
    `select b.status::text as request_status,
            (select count(*)::int from public.reservation_allocations a
              where a.organization_id = $1 and a.reservation_id = b.reservation_id
                and app.allocation_is_active(a.status, a.hold_expires_at)) as blocking,
            (select count(*)::int from public.reservation_allocations a
              where a.organization_id = $1 and a.reservation_id = b.reservation_id) as residual
     from public.booking_requests b
     where b.organization_id = $1 and b.quote_id = $2 order by b.created_at desc limit 1`,
    [organizationId, quoteId],
  );
  const r = rows[0];
  return r
    ? {
        requestStatus: r.request_status,
        blockingAllocations: r.blocking,
        residualAllocations: r.residual,
      }
    : null;
}

/**
 * Provider (model) calls recorded for this session's conversation: one `model_call` telemetry row
 * per call (src/server/ai/assistant.ts) — the direct evidence that a replay called no model.
 */
export async function modelCalls(db, organizationId, sessionToken) {
  const { rows } = await db.query(
    `select count(*)::int as n from public.ai_actions a join public.ai_conversations c on c.id = a.conversation_id
     where c.organization_id = $1 and c.session_hash = $2 and a.tool_name = 'model_call'`,
    [organizationId, sessionHashOf(sessionToken)],
  );
  return rows[0]?.n ?? 0;
}

/**
 * The smoke's candidate quotes: every quote it registered BEFORE a mutation was sent, and every
 * quote of its own (uniquely named) customers in this organization — so a booking committed while
 * its response never arrived is still found.
 */
async function smokeQuotes(db, organizationId, quoteIds, emails) {
  const { rows } = await db.query(
    `select q.id, q.quote_number from public.quotes q
     where q.organization_id = $1
       and (q.id = any($2::uuid[])
            or q.customer_id in (select c.id from public.customers c
                                 where c.organization_id = $1 and c.email = any($3::text[])))`,
    [organizationId, [...quoteIds], [...emails]],
  );
  return rows.map((r) => ({ id: r.id, quoteNumber: r.quote_number }));
}

/**
 * Reconciles the smoke's bookings with the DATABASE (never with what a response said): every
 * pending request on a smoke quote is cancelled, then the effective blockers (the availability
 * engine's predicate) are counted. Success means no smoke booking blocks inventory any more.
 * A confirmed request, more than one live request on a quote, or a blocker that remains is
 * UNRESOLVED/FAILED — never "succeeded".
 */
export async function reconcileSmokeBookings(db, organizationId, quoteIds, emails) {
  const unresolved = [];
  let requests = 0;
  let cancelled = 0;
  const quotes = await smokeQuotes(db, organizationId, quoteIds, emails);
  for (const q of quotes) {
    const { rows } = await db.query(
      `select b.status::text as status from public.booking_requests b
       where b.organization_id = $1 and b.quote_id = $2`,
      [organizationId, q.id],
    );
    requests += rows.length;
    const pending = rows.filter((r) => r.status === "pending");
    if (rows.some((r) => r.status === "confirmed")) {
      unresolved.push(
        `quote ${q.quoteNumber}: a confirmed booking request (not cancelled by the smoke)`,
      );
      continue;
    }
    if (pending.length > 1) {
      unresolved.push(
        `quote ${q.quoteNumber}: ${String(pending.length)} live booking requests (ambiguous)`,
      );
      continue;
    }
    if (pending.length === 1) {
      await cancelSmokeBooking(db, organizationId, q.id);
      cancelled++;
    }
  }
  const ids = quotes.map((q) => q.id);
  const { rows: blockers } = await db.query(
    `select q.quote_number, count(*)::int as n
     from public.booking_requests b
     join public.quotes q on q.id = b.quote_id
     join public.reservation_allocations a on a.reservation_id = b.reservation_id and a.organization_id = $1
     where b.organization_id = $1 and b.quote_id = any($2::uuid[])
       and app.allocation_is_active(a.status, a.hold_expires_at)
     group by q.quote_number`,
    [organizationId, ids],
  );
  for (const b of blockers)
    unresolved.push(
      `quote ${b.quote_number}: ${String(b.n)} active allocation(s) still block inventory`,
    );
  return { quotes: quotes.length, quoteList: quotes, requests, cancelled, unresolved };
}

/** How long past a turn's lease the journal is trusted to show every mutation it could begin. */
export const LEASE_GRACE_SECONDS = 30;

/**
 * The application's OWN refusals that the handler (src/server/ai/handler.ts) returns BEFORE a turn
 * exists and with no work left running: rate limits, wrong content type, oversized or invalid body,
 * missing session — all before runTurn — and BUSY, which ai_turn_begin returns without creating
 * the turn. Exact (HTTP status, JSON errorCode) pairs of the app's error body; anything else —
 * a gateway 502/504, an edge or runtime error page, 503 AI_UNAVAILABLE (thrown AFTER runTurn
 * started), a 200 — is NOT proof that no turn will start. tests/unit/ai-smoke-db.test.ts pins this
 * list to the handler source.
 */
export const PRE_TURN_REFUSALS = Object.freeze({
  400: ["INVALID_MESSAGE"],
  409: ["SESSION_REQUIRED", "BUSY"],
  413: ["TOO_LARGE"],
  415: ["UNSUPPORTED"],
  429: ["RATE_LIMITED"],
});

/** The recognized pre-turn refusal code of an application response, or null. */
export function preTurnRefusal(status, body) {
  const codes = PRE_TURN_REFUSALS[status];
  if (!codes || !body || typeof body !== "object" || body.status !== "error") return null;
  return codes.includes(body.errorCode) ? body.errorCode : null;
}

/** One connection for a transaction: a Pool lends one; a Client is used as it is. */
async function withConnection(db, fn) {
  if (typeof db.connect === "function" && "totalCount" in db) {
    const c = await db.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  }
  return fn(db);
}

const FENCE_RESPONSE = JSON.stringify({
  status: "error",
  errorCode: "SMOKE_FENCED",
  reply: "This message was closed by the staging smoke test's cleanup.",
  blocks: [],
});

/**
 * Whether ONE assistant request key of the smoke can still mutate — now or in a FUTURE attempt —
 * decided from the server's own turn journal for its CURRENT attempt, never from "no booking exists
 * right now". `sends` is every delivery of this key the smoke made and what its transport showed.
 *
 * Under the conversation's row lock — the lock ai_turn_begin, ai_turn_finish/fail and
 * ai_mutation_begin all take first — so no attempt can be claimed, finished or start a mutation
 * while it decides (a retry being claimed right now holds it: lock timeout → NOT terminal):
 * - no turn row: terminal only if EVERY delivery got a recognized pre-turn refusal;
 * - a business mutation still 'started' for the turn: NOT terminal;
 * - completed: terminal — any later delivery of the key replays it (ai_turn_begin);
 * - processing under a live lease: NOT terminal;
 * - failed, abandoned, or processing past its lease: the exact attempt N is FENCED — turned into a
 *   completed turn (only if it is still attempt N in that status) and released from the
 *   conversation — so a delivery still on its way replays instead of starting attempt N+1, and the
 *   old attempt can no longer finish, fail or begin a mutation. Then terminal.
 */
export async function requestTerminality(db, organizationId, sessionToken, requestKey, sends = []) {
  const notTerminal = (reason) => ({ terminal: false, reason });
  if (!sessionToken) return notTerminal("its session is unknown");
  return withConnection(db, async (c) => {
    await c.query("begin");
    try {
      await c.query("set local lock_timeout = '1500ms'");
      const conv = await c.query(
        `select a.id from public.ai_conversations a
         where a.organization_id = $1 and a.session_hash = $2 for update`,
        [organizationId, sessionHashOf(sessionToken)],
      );
      const conversationId = conv.rows[0]?.id ?? null;
      const t = conversationId
        ? (
            await c.query(
              `select t.id, t.status, t.attempt,
                      t.lease_expires_at <= now() - make_interval(secs => $4) as lease_over,
                      (select count(*)::int from public.ai_mutations m
                        where m.organization_id = $2 and m.turn_id = t.id and m.status = 'started') as started
               from public.ai_turns t
               where t.conversation_id = $1 and t.organization_id = $2 and t.request_key = $3`,
              [conversationId, organizationId, requestKey, LEASE_GRACE_SECONDS],
            )
          ).rows[0]
        : null;
      if (!t) {
        await c.query("commit");
        const refusals = sends.map((s) => s.refusal ?? null);
        return refusals.length > 0 && refusals.every(Boolean)
          ? {
              terminal: true,
              reason: `the application refused every delivery before a turn (${[...new Set(refusals)].join(", ")})`,
            }
          : notTerminal("no turn recorded and no recognized pre-turn refusal for every delivery");
      }
      const attempt = `attempt ${String(t.attempt)}`;
      if (t.started > 0) {
        await c.query("rollback");
        return notTerminal(`${attempt} ${t.status}; a business mutation is still in progress`);
      }
      if (t.status === "completed") {
        await c.query("commit");
        return { terminal: true, reason: `${attempt} completed; a later delivery replays it` };
      }
      if (t.status === "processing" && !t.lease_over) {
        await c.query("rollback");
        return notTerminal(`${attempt} processing; it may still act (live lease)`);
      }
      const fenced = await c.query(
        `update public.ai_turns
            set status = 'completed', response = $5::jsonb, error_code = 'SMOKE_FENCED', completed_at = now()
          where id = $1 and organization_id = $2 and attempt = $3 and status = $4`,
        [t.id, organizationId, t.attempt, t.status, FENCE_RESPONSE],
      );
      if (fenced.rowCount !== 1) {
        await c.query("rollback");
        return notTerminal(`${attempt} changed while it was being fenced`);
      }
      await c.query(
        `update public.ai_conversations
            set active_turn_id = null, active_turn_attempt = null, active_turn_expires_at = null
          where id = $1 and active_turn_id = $2`,
        [conversationId, t.id],
      );
      await c.query("commit");
      return {
        terminal: true,
        reason: `${attempt} ${t.status}; fenced (a later delivery replays and cannot start another attempt)`,
      };
    } catch (e) {
      await c.query("rollback").catch(() => undefined);
      if (e && typeof e === "object" && e.code === "55P03") {
        return notTerminal(
          "its conversation is locked: an attempt is being claimed or written now",
        );
      }
      throw e;
    }
  });
}

/**
 * One HTTP exchange of a smoke request, tracked as a delivery of its intent over the WHOLE exchange
 * (request, headers AND body): the delivery is `response_completed` only once the body has been
 * read in full; any failure on the way — including a body read that fails after the headers
 * arrived — is `transport_failed_unknown`. A body that arrived in full but is not JSON is still a
 * completed transport (`body` null): the HTTP exchange finished, but it carries no recognized
 * application outcome, so it can never count as a pre-turn refusal.
 */
export async function trackedExchange(cleanup, requestId, sessionToken, send) {
  const delivery = cleanup.beginRequest(requestId, sessionToken);
  const exchange = (async () => {
    try {
      const res = await send();
      const raw = await res.text();
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = null;
      }
      delivery.responded(res.status, body);
      return { res, raw, body };
    } catch (e) {
      delivery.failed();
      throw e;
    }
  })();
  cleanup.state.inFlight = exchange;
  try {
    return await exchange;
  } finally {
    if (cleanup.state.inFlight === exchange) cleanup.state.inFlight = null;
  }
}

/**
 * Everything this run created or may have created, and what happened to it — ONE object for the
 * normal path, a failed check, a thrown error, SIGINT and SIGTERM.
 *
 * Every assistant request is a MUTATION INTENT registered before it is sent (`beginRequest`), with
 * its exact request id and session; each delivery of it (a same-id 429 retry is another delivery)
 * has a transport state: in_flight → response_completed | transport_failed_unknown |
 * wait_timed_out_unknown. The transport never proves completion by itself: the journal does
 * (`requestTerminality`). The booking outcome: reconciled_no_booking_terminal,
 * reconciled_booking_cancelled, or unresolved — success requires EVERY request terminal (checked
 * BEFORE the bookings) and no effective blocker. `run()` is idempotent.
 */
export function createSmokeCleanup(db, tag) {
  if (!SMOKE_TAG.test(tag ?? "")) throw new Error("invalid smoke tag");
  const state = {
    tag,
    organizationId: null,
    quoteIds: new Set(),
    /** Quote id → number, for every smoke quote seen (recovery output). */
    quoteNumbers: new Map(),
    customerEmails: new Set(),
    /** request id → { requestId, sessionToken, sends, state, resolution } (session never printed). */
    requests: new Map(),
    block: null, // { id, productId }
    bookingOutcome: "not_started",
    bookingCleanup: "not attempted",
    blockCleanup: "not created",
    unresolved: [],
    stopping: false,
    inFlight: null, // the HTTP exchange in progress, if any
    /** How many times each phase actually ran (A, B, C). */
    phaseRuns: { block: 0, requests: 0, bookings: 0 },
  };
  /** Registers one delivery of a request BEFORE it is sent. */
  function beginRequest(requestId, sessionToken) {
    const intent = state.requests.get(requestId) ?? {
      requestId,
      sessionToken,
      sends: [],
      state: "in_flight",
      resolution: null,
    };
    intent.sessionToken ??= sessionToken;
    const send = { state: "in_flight", httpStatus: null, refusal: null };
    intent.sends.push(send);
    intent.state = send.state;
    intent.resolution = null;
    state.requests.set(requestId, intent);
    const set = (s) => {
      send.state = s;
      intent.state = s;
    };
    return {
      intent,
      send,
      responded: (httpStatus = null, body = null) => {
        send.httpStatus = httpStatus;
        send.refusal = preTurnRefusal(httpStatus, body);
        set("response_completed");
      },
      failed: () => set("transport_failed_unknown"),
    };
  }
  /*
   * Cleanup phases, each with its OWN promise (never one shared promise for both strengths):
   *   A  remove the exact maintenance block;
   *   B  request terminality / journal fencing   ┐ reconcileBookings()
   *   C  booking reconciliation, cancel, release ┘
   *   D  report: bookingOutcome / bookingCleanup / recovery() derive from A–C's results.
   * A block-only call runs (or joins) A only. A FULL call joins an A already in progress and then
   * ALWAYS runs B+C — it is never satisfied by a block-only run, and never downgraded. Concurrent
   * full calls share one A→B→C pass; a later call starts a new one.
   */
  let blockPhase = null;
  let fullPass = null;
  async function reconcileBookings() {
    const org = state.organizationId;
    // 1. Can any request still mutate, now or in a later attempt? (Before looking at bookings.)
    const unknown = [];
    state.phaseRuns.requests++;
    for (const r of state.requests.values()) {
      const t = await requestTerminality(db, org, r.sessionToken, r.requestId, r.sends);
      r.resolution = t.terminal ? "terminal" : "unknown";
      if (!t.terminal)
        unknown.push(`request ${r.requestId}: completion not established — ${t.reason}`);
    }
    // 2. The bookings themselves, by exact quote and smoke customer.
    state.phaseRuns.bookings++;
    const r = await reconcileSmokeBookings(db, org, state.quoteIds, state.customerEmails);
    for (const q of r.quoteList) state.quoteNumbers.set(q.id, q.quoteNumber);
    state.unresolved = [...unknown, ...r.unresolved];
    if (state.unresolved.length) {
      state.bookingOutcome = "unresolved";
      state.bookingCleanup = `unresolved (${String(state.unresolved.length)} issue(s))`;
    } else if (r.requests === 0) {
      state.bookingOutcome = "reconciled_no_booking_terminal";
      state.bookingCleanup = `succeeded (no booking request was committed; ${String(state.requests.size)} request(s) terminal)`;
    } else {
      state.bookingOutcome = "reconciled_booking_cancelled";
      state.bookingCleanup = `succeeded (released; ${String(r.cancelled)} cancelled now)`;
    }
  }
  function phaseA() {
    blockPhase ??= (async () => {
      const org = state.organizationId;
      if (!org || !state.block) return;
      state.phaseRuns.block++;
      try {
        const removed = await removeSmokeAvailabilityBlock(db, org, state.block, tag);
        state.blockCleanup = removed === 1 ? "succeeded" : "failed (not found)";
        if (removed === 1) state.block = null;
      } catch {
        state.blockCleanup = "failed (database error)";
      }
    })().finally(() => {
      blockPhase = null;
    });
    return blockPhase;
  }
  async function phasesBC() {
    const org = state.organizationId;
    if (org && (state.quoteIds.size > 0 || state.customerEmails.size > 0 || state.requests.size)) {
      try {
        await reconcileBookings();
      } catch {
        state.bookingOutcome = "unresolved";
        state.bookingCleanup = "failed (database error during reconciliation)";
      }
    } else if (!org && state.requests.size > 0) {
      state.bookingOutcome = "unresolved";
      state.bookingCleanup = "unresolved (organization unknown)";
    }
  }
  function fullCleanup() {
    fullPass ??= (async () => {
      await phaseA(); // joins a block-only A already running — then continues regardless
      await phasesBC();
    })().finally(() => {
      fullPass = null;
    });
    return fullPass;
  }
  /** On an interrupt, let an exchange already sent settle (bounded); if not, it is UNKNOWN. */
  async function settleInFlight(waitForInFlightMs) {
    if (!state.inFlight) return;
    let timer;
    const settled = await Promise.race([
      Promise.resolve(state.inFlight).then(
        () => true,
        () => true,
      ),
      new Promise((r) => {
        timer = setTimeout(() => r(false), waitForInFlightMs);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) {
      for (const r of state.requests.values()) {
        for (const s of r.sends) if (s.state === "in_flight") s.state = "wait_timed_out_unknown";
        if (r.state === "in_flight") r.state = "wait_timed_out_unknown";
      }
    }
  }
  /**
   * FULL cleanup (the default — the normal end, a thrown error, SIGINT and SIGTERM): phases A, B, C.
   * `waitForInFlightMs`: first let an exchange already sent settle (bounded); if it does not, its
   * completion is UNKNOWN — the journal, not this wait, decides.
   * `blockOnly` (mid-run only): phase A; while a full pass is running it waits for that pass.
   */
  async function run({ waitForInFlightMs = 0, blockOnly = false } = {}) {
    if (blockOnly) {
      await (fullPass ?? phaseA());
      return state;
    }
    await settleInFlight(waitForInFlightMs);
    await fullCleanup();
    return state;
  }
  /**
   * When cleanup is not proven: the EXACT identifiers a person needs to inspect and cancel the
   * staging records by hand — organization, quote ids and numbers, request ids, the run tag, the
   * block and product. Never a private token, token hash, session, URL or credential.
   */
  function recovery() {
    const lines = [];
    const bookingOk =
      state.bookingCleanup === "not attempted" || state.bookingCleanup.startsWith("succeeded");
    if (!bookingOk || state.block) {
      lines.push(`organization ${String(state.organizationId)}`);
      lines.push(`smoke run tag ${tag}`);
    }
    if (state.block) {
      lines.push(
        `availability block ${state.block.id} (product ${state.block.productId}, notes "${tag}")`,
      );
    }
    if (!bookingOk) {
      lines.push(`booking cleanup: ${state.bookingCleanup}`);
      const quotes = new Set([...state.quoteIds, ...state.quoteNumbers.keys()]);
      for (const id of quotes) {
        const n = state.quoteNumbers.get(id);
        lines.push(`quote ${id}${n ? ` (${n})` : ""}`);
      }
      for (const e of state.customerEmails) lines.push(`smoke customer email ${e}`);
      for (const r of state.requests.values()) {
        if (r.resolution !== "terminal") {
          const sends = r.sends.map(
            (s) => s.state + (s.httpStatus ? ` ${String(s.httpStatus)}` : ""),
          );
          lines.push(`request ${r.requestId} (deliveries: ${sends.join(", ")})`);
        }
      }
      for (const u of state.unresolved) lines.push(`  ${u}`);
    }
    return lines;
  }
  return { state, run, recovery, beginRequest };
}
