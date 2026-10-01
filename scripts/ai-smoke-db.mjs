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
  return { quotes: quotes.length, requests, cancelled, unresolved };
}

/**
 * Everything this run created or may have created, and what happened to it — ONE object for the
 * normal path, a failed check, a thrown error, SIGINT and SIGTERM. Mutation intent is registered
 * BEFORE a request is sent (quote ids, the smoke's customer emails), so cleanup can reconcile a
 * booking whose response never arrived. `run()` is idempotent.
 */
export function createSmokeCleanup(db, tag) {
  if (!SMOKE_TAG.test(tag ?? "")) throw new Error("invalid smoke tag");
  const state = {
    tag,
    organizationId: null,
    quoteIds: new Set(),
    customerEmails: new Set(),
    block: null, // { id, productId }
    bookingCleanup: "not attempted",
    blockCleanup: "not created",
    unresolved: [],
    stopping: false,
    inFlight: null, // the HTTP request in progress, if any
  };
  let running = null;
  /**
   * `waitForInFlightMs`: on an interrupt, first let a request already sent settle (bounded), so a
   * mutation it commits is reconciled too; the reconciliation does not depend on its response.
   */
  async function run({ waitForInFlightMs = 0 } = {}) {
    if (state.inFlight && waitForInFlightMs > 0) {
      let timer;
      await Promise.race([
        Promise.resolve(state.inFlight).catch(() => undefined),
        new Promise((r) => {
          timer = setTimeout(r, waitForInFlightMs);
        }),
      ]);
      clearTimeout(timer);
    }
    running ??= (async () => {
      if (state.organizationId && (state.quoteIds.size > 0 || state.customerEmails.size > 0)) {
        try {
          const r = await reconcileSmokeBookings(
            db,
            state.organizationId,
            state.quoteIds,
            state.customerEmails,
          );
          state.unresolved = r.unresolved;
          state.bookingCleanup = r.unresolved.length
            ? `unresolved (${r.unresolved.length} issue(s))`
            : r.requests === 0
              ? "succeeded (no booking request was committed)"
              : `succeeded (released; ${String(r.cancelled)} cancelled now)`;
        } catch {
          state.bookingCleanup = "failed (database error during reconciliation)";
        }
      }
      if (state.organizationId && state.block) {
        try {
          const removed = await removeSmokeAvailabilityBlock(
            db,
            state.organizationId,
            state.block,
            tag,
          );
          state.blockCleanup = removed === 1 ? "succeeded" : "failed (not found)";
          if (removed === 1) state.block = null;
        } catch {
          state.blockCleanup = "failed (database error)";
        }
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
    return state;
  }
  /** Safe identifiers to clean up by hand when cleanup is not proven (no hash, no token, no URL). */
  function recovery() {
    const lines = [];
    if (state.block) lines.push(`availability block id ${state.block.id} (notes "${tag}")`);
    if (!state.bookingCleanup.startsWith("succeeded") && state.bookingCleanup !== "not attempted") {
      lines.push(`booking requests of the smoke's quotes (tag ${tag}): ${state.bookingCleanup}`);
      for (const u of state.unresolved) lines.push(`  ${u}`);
    }
    return lines;
  }
  return { state, run, recovery };
}
