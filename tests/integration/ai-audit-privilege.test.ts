import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PostgrestError } from "@supabase/supabase-js";
import { beforeAll, expect, it } from "vitest";
import { runTurn, type TurnDeps } from "@/server/ai/assistant";
import { ScriptedProvider } from "@/server/ai/providers/scripted";
import { generateSessionToken, hashSessionToken } from "@/server/ai/session";
import { GatewayError, type TrustedAuditEvent } from "@/server/trusted/gateway";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken } from "@/server/visitor";
import { makeProduct } from "./support/availability";
import { admin, createOrg, pool, type TestOrg } from "./support/db";
import { pgAiStore } from "./support/ai";
import { fakeProvider, pgGateway } from "./support/pricing";
import { describeRest } from "./support/rest";

/**
 * M7 live staging smoke (run 37001309667): every create_quote wrote its quote and then failed, the
 * journal kept the mutation 'started', no quote card reached the customer, and request_booking had
 * no quote to book. Cause: the system gateway's audit row is a DIRECT `audit_logs` insert as
 * service_role (src/server/trusted/gateway.ts recordAudit), made AFTER the quote exists — and it
 * relied on default table privileges for API roles. The local shim applies those defaults
 * (supabase/tests/shim/supabase_shim.sql); the hosted staging project does not, so the suites never
 * saw it.
 *
 * Here the audit insert runs as service_role exactly as supabase-js does, starting from NO table
 * privileges (as on a project without the defaults), in a transaction that is always rolled back.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20261005000100_service_role_audit_insert.sql",
  "utf8",
);

let org: TestOrg;
const tenant = () =>
  ({
    organizationId: org.id,
    slug: org.slug,
    name: `Org ${org.slug}`,
    timezone: "America/Chicago",
    currency: "USD",
    resolvedBy: "host",
  }) as unknown as ResolvedTenant;

/** The audit insert as the service role, with or without this migration's grant. */
function auditAsServiceRole(withMigration: boolean) {
  return async (organizationId: string, e: TrustedAuditEvent) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("revoke all on public.audit_logs from service_role");
      if (withMigration) await c.query(MIGRATION);
      await c.query("set local role service_role");
      await c.query(
        `insert into public.audit_logs (organization_id, actor_type, action, entity_type, entity_id, changes, request_id, ip_address, user_agent)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          organizationId,
          e.actor,
          e.action,
          e.entityType,
          e.entityId ?? null,
          e.metadata === undefined ? null : JSON.stringify(e.metadata),
          e.requestId ?? null,
          e.ipAddress ?? null,
          e.userAgent ?? null,
        ],
      );
    } catch (err) {
      const pgErr = err as { code?: string; message?: string };
      // What supabase-js returns for it (src/server/trusted/gateway.ts unwrap).
      throw new GatewayError({
        code: pgErr.code ?? "",
        message: pgErr.message ?? "error",
        details: "",
        hint: "",
      } as PostgrestError);
    } finally {
      await c.query("rollback").catch(() => undefined);
      c.release();
    }
  };
}

function deps(withMigration: boolean): TurnDeps {
  return {
    provider: new ScriptedProvider(),
    store: pgAiStore(),
    maxOutputTokens: 300,
    publicDeps: {
      gateway: { ...pgGateway(), recordAudit: auditAsServiceRole(withMigration) },
      rateLimit: () => Promise.resolve(),
      provider: fakeProvider(3),
    },
  };
}

/** The live smoke's progression up to create_quote and request_booking (scripted model). */
async function liveProgression(withMigration: boolean) {
  const session = generateSessionToken();
  const visitor = generateVisitorToken();
  const d = deps(withMigration);
  const say = (message: string) =>
    runTurn(
      {
        tenant: tenant(),
        sessionToken: session,
        message,
        meta: { ip: "198.51.100.90", visitorToken: visitor },
        correlationId: `req-${randomUUID()}`,
      },
      d,
    );
  const email = `audit-${randomUUID().slice(0, 8)}@example.test`;
  await say("Do you have a slide for a party?");
  await say("Is it available on 2027-09-18 from 12:00 to 16:00?");
  await say(`My name is Robin and my email is ${email}`);
  const quote = await say("Please create my quote");
  const booking = await say("Please request the booking");
  const conv = (
    await admin<{ id: string }>(
      "select id from public.ai_conversations where organization_id = $1 and session_hash = $2",
      [org.id, await hashSessionToken(session)],
    )
  ).rows[0]!.id;
  const journal = async () => ({
    quotes: Number(
      (
        await admin<{ n: string }>(
          `select count(*)::text n from public.quotes q join public.customers c on c.id = q.customer_id
           where q.organization_id = $1 and c.email = $2`,
          [org.id, email],
        )
      ).rows[0]!.n,
    ),
    bookings: Number(
      (
        await admin<{ n: string }>(
          `select count(*)::text n from public.booking_requests b join public.quotes q on q.id = b.quote_id
           join public.customers c on c.id = q.customer_id where q.organization_id = $1 and c.email = $2`,
          [org.id, email],
        )
      ).rows[0]!.n,
    ),
    mutations: (
      await admin<{ tool_name: string; status: string }>(
        "select tool_name, status from public.ai_mutations where conversation_id = $1 order by seq",
        [conv],
      )
    ).rows,
    actions: (
      await admin<{ tool_name: string; status: string }>(
        `select tool_name, status from public.ai_actions where conversation_id = $1
         and tool_name in ('create_quote', 'request_booking') order by created_at`,
        [conv],
      )
    ).rows,
    turns: (
      await admin<{ status: string }>(
        "select status from public.ai_turns where conversation_id = $1",
        [conv],
      )
    ).rows.map((r) => r.status),
  });
  return { quote, booking, ...(await journal()) };
}

beforeAll(async () => {
  org = await createOrg("audit-priv");
  const p = await makeProduct(org, { units: 2 });
  await admin(
    "update public.products set slug = 'party-slide', name = 'Party Slide', base_price_cents = 20000 where id = $1",
    [p.productId],
  );
}, 120_000);

describeRest("the assistant's quote/booking path needs no default table privileges", () => {
  it("REPRODUCES the live failure without the grant: quote written, mutation left 'started', no card, no booking", async () => {
    const r = await liveProgression(false);
    // The quote exists in the database…
    expect(r.quotes).toBe(1);
    // …but the customer never got it, and nothing could be booked.
    expect(r.quote.blocks.some((b) => b.type === "quote")).toBe(false);
    expect(r.booking.blocks.some((b) => b.type === "booking")).toBe(false);
    expect(r.bookings).toBe(0);
    // The journal state the live smoke's cleanup reported: a completed turn whose business
    // mutation is still 'started', and a create_quote action that did not succeed.
    expect(r.mutations).toEqual([{ tool_name: "create_quote", status: "started" }]);
    expect(r.turns.every((s) => s === "completed")).toBe(true);
    expect(r.actions.find((a) => a.tool_name === "create_quote")?.status).not.toBe("ok");
  });

  it("with the migration's grant: quote card, committed mutation, pending booking request", async () => {
    const r = await liveProgression(true);
    expect(r.quotes).toBe(1);
    expect(r.quote.reply).toMatch(/^Your quote Q-\d+ is ready\.$/);
    expect(r.quote.blocks.find((b) => b.type === "quote")).toMatchObject({ type: "quote" });
    expect(r.bookings).toBe(1);
    expect(r.booking.blocks.find((b) => b.type === "booking")).toMatchObject({
      status: "hold_placed",
    });
    expect(r.mutations.map((m) => m.status)).toEqual(["committed", "committed"]);
    // (This fixture organization has no tax setup, so the price is flagged for review — still a
    //  successful tool call, as the live smoke counts it.)
    expect(r.actions.map((a) => a.tool_name)).toEqual(["create_quote", "request_booking"]);
    expect(r.actions.every((a) => ["ok", "manual_review"].includes(a.status))).toBe(true);
  });

  it("the grant is exactly INSERT: service_role still cannot read, update or delete audit rows", async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("revoke all on public.audit_logs from service_role");
      await c.query(MIGRATION);
      const can = async (priv: string) =>
        (
          await c.query<{ ok: boolean }>(
            "select has_table_privilege('service_role', 'public.audit_logs', $1) as ok",
            [priv],
          )
        ).rows[0]!.ok;
      expect(await can("INSERT")).toBe(true);
      expect(await can("SELECT")).toBe(false);
      expect(await can("UPDATE")).toBe(false);
      expect(await can("DELETE")).toBe(false);
      expect(await can("TRUNCATE")).toBe(false);
      for (const role of ["anon", "authenticated"]) {
        expect(
          (
            await c.query<{ ok: boolean }>(
              "select has_table_privilege($1, 'public.audit_logs', 'INSERT') as ok",
              [role],
            )
          ).rows[0]!.ok,
        ).toBe(false);
      }
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
