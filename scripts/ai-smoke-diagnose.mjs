#!/usr/bin/env node
/**
 * READ-ONLY diagnosis of one live smoke run on staging: the assistant journal (turns, tool actions,
 * business mutations, user prompts) of every conversation of one organization in a time window,
 * and the booking state of the smoke's exact quotes. Never writes (READ ONLY transaction).
 *
 * Prints structure only. No token hash, session hash, link token, URL or credential is printed:
 * a block shows whether it carried a link, never the link; text is masked for /q/<token> and any
 * 64-hex value.
 *
 *   AI_DIAG_DATABASE_URL=… AI_DIAG_ORG=<uuid> AI_DIAG_FROM=<iso> AI_DIAG_TO=<iso> \
 *   AI_DIAG_QUOTES=<uuid,uuid> node scripts/ai-smoke-diagnose.mjs
 */
import pg from "pg";

const env = process.env;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const quotes = (env.AI_DIAG_QUOTES ?? "").split(",").filter(Boolean);
if (
  !env.AI_DIAG_DATABASE_URL ||
  !UUID.test(env.AI_DIAG_ORG ?? "") ||
  Number.isNaN(Date.parse(env.AI_DIAG_FROM ?? "")) ||
  Number.isNaN(Date.parse(env.AI_DIAG_TO ?? "")) ||
  !quotes.every((q) => UUID.test(q))
) {
  console.error(
    "Set AI_DIAG_DATABASE_URL, AI_DIAG_ORG, AI_DIAG_FROM, AI_DIAG_TO (and AI_DIAG_QUOTES).",
  );
  process.exit(2);
}
const mask = (s, max = 220) => {
  const t = String(s ?? "")
    .replace(/\/q\/[A-Za-z0-9_-]+/g, "/q/<token>")
    .replace(/\b[0-9a-f]{64}\b/g, "<hash>")
    .replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
const blocksOf = (response) =>
  (Array.isArray(response?.blocks) ? response.blocks : []).map((b) => ({
    type: b?.type,
    ...(b?.quoteNumber ? { quoteNumber: b.quoteNumber } : {}),
    ...(b?.status ? { status: b.status } : {}),
    ...(b?.type === "quote" ? { link: Boolean(b.url ?? b.sealedLink ?? b.quoteRef) } : {}),
    ...(b?.replaces ? { replaces: b.replaces } : {}),
  }));

const db = new pg.Client({ connectionString: env.AI_DIAG_DATABASE_URL });
try {
  await db.connect();
  await db.query("begin transaction read only");
  const org = env.AI_DIAG_ORG;
  const window = [org, env.AI_DIAG_FROM, env.AI_DIAG_TO];
  const convs = (
    await db.query(
      `select c.id, c.message_count, c.state -> 'quote' ->> 'quoteNumber' as quote_number,
              c.active_turn_id is not null as has_active_turn, c.active_turn_expires_at,
              (select min(t.started_at) from public.ai_turns t where t.conversation_id = c.id) as first_turn
       from public.ai_conversations c
       where c.organization_id = $1
         and exists (select 1 from public.ai_turns t where t.conversation_id = c.id
                       and t.started_at between $2 and $3)
       order by first_turn`,
      window,
    )
  ).rows;
  console.log(`conversations in window: ${String(convs.length)}`);
  for (const [i, c] of convs.entries()) {
    console.log(
      `\n=== conversation #${String(i + 1)} (${c.id.slice(0, 8)}) messages=${String(c.message_count)} activeQuote=${c.quote_number ?? "-"} activeTurnHeld=${String(c.has_active_turn)} activeTurnExpires=${c.active_turn_expires_at?.toISOString?.() ?? "-"}`,
    );
    const events = [];
    for (const t of (
      await db.query(
        `select t.id, t.request_key, t.attempt, t.status, t.error_code, t.started_at, t.completed_at,
                t.lease_expires_at, t.response
         from public.ai_turns t where t.conversation_id = $1 and t.organization_id = $2`,
        [c.id, org],
      )
    ).rows) {
      events.push({
        at: t.started_at,
        line: `TURN ${t.request_key} attempt=${String(t.attempt)} ${t.status}${t.error_code ? ` [${t.error_code}]` : ""} started=${t.started_at.toISOString()} completed=${t.completed_at?.toISOString() ?? "-"} lease=${t.lease_expires_at.toISOString()}\n       response: status=${String(t.response?.status ?? "-")} errorCode=${String(t.response?.errorCode ?? "-")} blocks=${JSON.stringify(blocksOf(t.response))}\n       reply: ${mask(t.response?.reply)}`,
      });
    }
    for (const a of (
      await db.query(
        `select a.created_at, a.tool_name, a.status, a.error_code, a.duration_ms from public.ai_actions a
         where a.conversation_id = $1 and a.organization_id = $2`,
        [c.id, org],
      )
    ).rows) {
      events.push({
        at: a.created_at,
        line: `  action ${a.tool_name} ${a.status}${a.error_code ? ` [${a.error_code}]` : ""} ${String(a.duration_ms ?? "")}ms`,
      });
    }
    for (const m of (
      await db.query(
        `select m.started_at, m.committed_at, m.tool_name, m.status, m.error_code, t.request_key, m.attempt
         from public.ai_mutations m left join public.ai_turns t on t.id = m.turn_id
         where m.conversation_id = $1 and m.organization_id = $2`,
        [c.id, org],
      )
    ).rows) {
      events.push({
        at: m.started_at,
        line: `  MUTATION ${m.tool_name} ${m.status}${m.error_code ? ` [${m.error_code}]` : ""} turn=${m.request_key ?? "-"} attempt=${String(m.attempt)} committed=${m.committed_at?.toISOString() ?? "-"}`,
      });
    }
    for (const m of (
      await db.query(
        `select m.created_at, m.role, m.content from public.ai_messages m
         where m.conversation_id = $1 and m.organization_id = $2 and m.role = 'user'`,
        [c.id, org],
      )
    ).rows) {
      events.push({ at: m.created_at, line: `  user (stored at finish): ${mask(m.content, 120)}` });
    }
    events.sort((x, y) => x.at - y.at);
    for (const e of events) console.log(`${e.at.toISOString()} ${e.line}`);
  }
  if (quotes.length) {
    console.log("\n=== exact smoke quotes");
    for (const r of (
      await db.query(
        `select q.quote_number, q.status::text as quote_status, b.status::text as request_status,
                b.created_at as requested_at,
                (select count(*)::int from public.reservation_allocations a
                  where a.organization_id = $1 and a.reservation_id = b.reservation_id
                    and app.allocation_is_active(a.status, a.hold_expires_at)) as active_allocations
         from public.quotes q left join public.booking_requests b on b.quote_id = q.id and b.organization_id = $1
         where q.organization_id = $1 and q.id = any($2::uuid[]) order by q.quote_number`,
        [org, quotes],
      )
    ).rows) {
      console.log(
        `${r.quote_number}: quote=${r.quote_status} bookingRequest=${r.request_status ?? "none"} requested=${r.requested_at?.toISOString() ?? "-"} activeAllocations=${String(r.active_allocations ?? 0)}`,
      );
    }
  }
  await db.query("rollback");
} catch (e) {
  // Never print the error itself (it may carry connection details): its code only.
  console.error(`diagnosis failed: ${String(e?.code ?? e?.name ?? "error")}`);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => undefined);
}
