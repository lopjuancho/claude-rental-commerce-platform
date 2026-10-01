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

/**
 * Smoke-only availability change: a maintenance block for ONE product of this organization on
 * one (far-future) date, tagged so it can be removed exactly. The window spans the whole local
 * day in any timezone. Returns the block id.
 */
export async function addSmokeAvailabilityBlock(db, organizationId, productSlug, isoDate, tag) {
  const { rows } = await db.query(
    `insert into public.availability_blocks (organization_id, product_id, period, reason, notes)
     select $1, p.id,
            tstzrange(($3::date - interval '14 hours')::timestamptz, ($3::date + interval '38 hours')::timestamptz),
            'maintenance', $4
     from public.products p where p.organization_id = $1 and p.slug = $2
     returning id`,
    [organizationId, productSlug, isoDate, tag],
  );
  return rows[0]?.id ?? null;
}

/** Removes exactly the smoke's tagged blocks of this organization. Returns how many. */
export async function removeSmokeAvailabilityBlocks(db, organizationId, tag) {
  if (!/^ai-smoke-[0-9a-f]{8,}$/.test(tag)) throw new Error("refusing to remove untagged blocks");
  const r = await db.query(
    "delete from public.availability_blocks where organization_id = $1 and notes = $2",
    [organizationId, tag],
  );
  return r.rowCount;
}
