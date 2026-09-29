import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { submitQuoteRequest } from "@/server/public/quotes";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { generateVisitorToken, hashVisitorToken } from "@/server/visitor";
import { addUnits, makeProduct, outcome, SYSTEM } from "./support/availability";
import { admin, createOrg, createUser, pool, type TestOrg, type TestUser } from "./support/db";
import { fakeProvider, pgGateway } from "./support/pricing";
import { openTx, settle, waitUntilBlocked, type Tx } from "./support/tx";

/**
 * Codex review of 5f8a9e3 (round 5): the organization gate is scoped to the mutation's declared
 * TARGET organizations — never "every organization the user belongs to". Deterministic: waits and
 * held gates are read from pg_locks.
 */
let A: TestOrg;
let B: TestOrg;
let C: TestOrg;
/** office in A, B and C */
let multi: TestUser;
/** office in A, read-only staff in B */
let mixed: TestUser;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const as = (u: TestUser, targets: TestOrg[]) => ({ ...u, orgTargets: targets.map((o) => o.id) });

beforeAll(async () => {
  A = await createOrg("r5-a");
  B = await createOrg("r5-b");
  C = await createOrg("r5-c");
  multi = await createUser("r5-multi");
  mixed = await createUser("r5-mixed");
  for (const [org, user, role] of [
    [A, multi, "office"],
    [B, multi, "office"],
    [C, multi, "office"],
    [A, mixed, "office"],
    [B, mixed, "staff"],
  ] as const) {
    await admin(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)",
      [org.id, user.id, role],
    );
  }
});

/** Organization gates (A/B/C) held — or waited for — by a backend. */
async function gates(pid: number, granted = true) {
  const r = await admin<{ id: string }>(
    `select o.id from public.organizations o
     where o.id = any($2::uuid[]) and exists (
       select 1 from pg_locks l
       where l.pid = $1 and l.locktype = 'advisory' and l.granted = $3
         and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('org:' || o.id::text, 0))
     order by o.id`,
    [pid, [A.id, B.id, C.id], granted],
  );
  return r.rows.map((x) => x.id);
}
const ids = (...orgs: TestOrg[]) => orgs.map((o) => o.id).sort();
/** Resolves with the statement's outcome, or "blocked" if it is still waiting after `ms`. */
const within = (p: Promise<string>, ms = 800) => Promise.race([p, sleep(ms).then(() => "blocked")]);

async function weatherBlock(org: TestOrg, status: "proposed" | "confirmed") {
  const r = await admin<{ id: string }>(
    `insert into public.weather_blocks (organization_id, hazard, period, status, scope, reason)
     values ($1, 'wind', tstzrange(now() + interval '30 days', now() + interval '31 days'), $2, 'all_sensitive', 'Gusts')
     returning id`,
    [org.id, status],
  );
  return r.rows[0]!.id;
}
/** A raw superuser transaction holding a row lock (used to pause an RPC right after its gate). */
async function holdRow(table: string, id: string) {
  const client = await pool.connect();
  await client.query("begin");
  await client.query(`select 1 from public.${table} where id = $1 for update`, [id]);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query("commit").catch(() => undefined);
      client.release();
    },
  };
}

// ═══════════════════════════════ H1-R4 ═══════════════════════════════
describe("H1-R4. weather RPCs and catalog writes use the same target-scoped gate: no A↔B cycle", () => {
  for (const rpcName of ["confirm_weather_block", "lift_weather_block"] as const) {
    for (const [weatherOrg, catalogOrg] of [
      ["B", "A"],
      ["A", "B"],
    ] as const) {
      it(`${rpcName}(${weatherOrg}) racing a catalog write in ${catalogOrg}`, async () => {
        const W = weatherOrg === "A" ? A : B;
        const K = catalogOrg === "A" ? A : B;
        const block = await weatherBlock(
          W,
          rpcName === "confirm_weather_block" ? "proposed" : "confirmed",
        );
        const product = await makeProduct(K, { units: 0 });
        // Pause the RPC right after it takes W's gate: a third session holds the weather row.
        const row = await holdRow("weather_blocks", block);
        try {
          const t1 = await openTx(as(multi, [K])); // the user's active org is K, but the RPC targets W
          const weather = settle(t1.q(`select public.${rpcName}($1)`, [block]));
          await waitUntilBlocked(t1.pid);
          expect(await gates(t1.pid)).toEqual([W.id]); // T1 holds only its target's gate
          // T2: a catalog write in K. It needs K's gate only — never W's.
          const t2 = await openTx(as(multi, [K]));
          const write = await within(
            settle(
              t2.q("update public.products set name = name where id = $1", [product.productId]),
            ),
          );
          expect(write).toBe("ok");
          expect(await gates(t2.pid)).toEqual([K.id]);
          expect(await gates(t2.pid, false)).toEqual([]); // waits for nothing
          await row.release();
          expect(await weather).toBe("ok"); // no gate request after W's: no cycle, no 40P01
          expect(await gates(t1.pid)).toEqual([W.id]);
          await t1.commit();
          await t2.commit();
        } finally {
          await row.release();
        }
      });
    }
  }

  it("a multi-organization mutation locks exactly its declared targets, ascending, and nothing else", async () => {
    const [lo, hi] = [A, B].sort((x, y) => (x.id < y.id ? -1 : 1)) as [TestOrg, TestOrg];
    const pHi = await makeProduct(hi, { units: 0 });
    const pLo = await makeProduct(lo, { units: 0 });
    const t0 = await openTx(as(multi, [hi]));
    await t0.q("update public.products set name = name where id = $1", [pHi.productId]); // holds hi
    const t = await openTx(as(multi, [hi, lo])); // declared out of order, C not declared
    const write = settle(
      t.q("update public.products set name = name where id = $1", [pLo.productId]),
    );
    await waitUntilBlocked(t.pid);
    expect(await gates(t.pid)).toEqual([lo.id]); // lower first…
    expect(await gates(t.pid, false)).toEqual([hi.id]); // …then waits for the higher one
    await t0.commit();
    expect(await write).toBe("ok");
    expect(await gates(t.pid)).toEqual(ids(A, B)); // exactly the target set: C (also a membership) never
    await t.commit();
  });
});

// ═══════════════════════════════ M3-R4 ═══════════════════════════════
describe("M3-R4. a mutation in A never takes B's gate because the user belongs to B", () => {
  it("office in A and B: an A-only update locks only A", async () => {
    const p = await makeProduct(A, { units: 0 });
    const t = await openTx(as(multi, [A]));
    await t.q("update public.products set name = name where id = $1", [p.productId]);
    expect(await gates(t.pid)).toEqual([A.id]);
    await t.rollback();
  });

  it("office in A, read-only in B: B is never locked, even if B is declared", async () => {
    const p = await makeProduct(A, { units: 0 });
    for (const targets of [[A], [A, B], [B, A]]) {
      const t = await openTx(as(mixed, targets));
      await t.q("update public.products set name = name where id = $1", [p.productId]);
      expect(await gates(t.pid)).toEqual([A.id]);
      await t.rollback();
    }
  });

  it("a zero-row update in A's context does not lock B", async () => {
    const t = await openTx(as(multi, [A]));
    await t.q("update public.products set name = name where false");
    expect(await gates(t.pid)).toEqual([A.id]);
    await t.rollback();
  });

  it("an RLS-filtered update (rows of B the user may not write) locks no unrelated organization", async () => {
    const pB = await makeProduct(B, { units: 0 });
    const t = await openTx(as(mixed, [A]));
    const r = await t.q("update public.products set name = name where id = $1", [pB.productId]);
    expect(r.rowCount).toBe(0);
    expect(await gates(t.pid)).toEqual([A.id]);
    await t.rollback();
  });

  it("while a mutation in A is open, a public booking in B proceeds normally", async () => {
    await admin(
      `update public.organization_settings set primary_depot_address_line1 = '2560 Overton Crossing St', primary_depot_city = 'Memphis',
         primary_depot_state = 'TN', primary_depot_postal_code = '38127', free_delivery_miles = 5, per_mile_rate_cents = 400
       where organization_id = $1`,
      [B.id],
    );
    const pB = await makeProduct(B, { units: 1 });
    const { token } = await submitQuoteRequest(
      {
        organizationId: B.id,
        slug: B.slug,
        name: B.slug,
        timezone: "America/Chicago",
      } as unknown as ResolvedTenant,
      {
        contact: { email: `r5-${randomUUID().slice(0, 6)}@example.test` },
        event: {
          date: "2028-09-01",
          startTime: "12:00",
          endTime: "16:00",
          address: {
            line1: "1930 S Germantown Rd",
            city: "Germantown",
            state: "TN",
            postalCode: "38138",
          },
        },
        items: [{ variantId: pB.variantId, quantity: 1 }],
      },
      { ip: "198.51.100.15" },
      { gateway: pgGateway(), provider: fakeProvider(8.2), rateLimit: () => Promise.resolve() },
    );
    const pA = await makeProduct(A, { units: 0 });
    const t = await openTx(as(multi, [A]));
    await t.q("update public.products set name = name where id = $1", [pA.productId]); // holds A (not B)
    const booking = await openTx(SYSTEM);
    const hold = await within(
      settle(
        booking.q("select * from public.request_booking_by_token($1, $2, 'web', null, $3)", [
          B.id,
          await hashQuoteToken(token),
          await hashVisitorToken(generateVisitorToken()),
        ]),
      ),
    );
    expect(hold).toBe("ok");
    await booking.commit();
    await t.rollback();
  });
});

// ═══════════════════════════════ service role ═══════════════════════════════
describe("service_role context on gated tables", () => {
  async function busyA() {
    const p = await makeProduct(A, { units: 0 });
    const t = await openTx(as(multi, [A]));
    await t.q("update public.products set name = name where id = $1", [p.productId]); // A's gate taken
    return t;
  }

  it("UPDATE while the gate is busy fails fast (55P03) and rolls back cleanly", async () => {
    const p = await makeProduct(A, { units: 0 });
    const holder = await busyA();
    const s = await openTx(SYSTEM);
    expect(
      await within(
        settle(s.q("update public.products set name = 'changed' where id = $1", [p.productId])),
      ),
    ).toBe("55P03");
    await s.rollback();
    await holder.rollback();
    const r = await admin<{ name: string }>("select name from public.products where id = $1", [
      p.productId,
    ]);
    expect(r.rows[0]!.name).not.toBe("changed");
  });

  it("DELETE while the gate is busy fails fast (55P03); the row survives", async () => {
    const p = await makeProduct(A, { units: 0 });
    const [unit] = await addUnits(A, p.variantId, 1);
    const holder = await busyA();
    const s = await openTx(SYSTEM);
    expect(
      await within(settle(s.q("delete from public.inventory_units where id = $1", [unit]))),
    ).toBe("55P03");
    await s.rollback();
    await holder.rollback();
    const r = await admin("select 1 from public.inventory_units where id = $1", [unit]);
    expect(r.rowCount).toBe(1);
  });

  it("with the gate acquired explicitly first, the service operation waits without holding rows, then succeeds", async () => {
    const p = await makeProduct(A, { units: 0 });
    const [unit] = await addUnits(A, p.variantId, 1);
    const holder = await busyA();
    const s = await openTx(SYSTEM);
    const gate = settle(s.q("select public.acquire_organization_gates($1::uuid[])", [[A.id]]));
    await waitUntilBlocked(s.pid);
    expect(await gates(s.pid, false)).toEqual([A.id]);
    await holder.commit();
    expect(await gate).toBe("ok");
    await s.q("update public.products set name = 'svc' where id = $1", [p.productId]);
    await s.q("delete from public.inventory_units where id = $1", [unit]);
    await s.commit();
    const r = await admin<{ name: string }>("select name from public.products where id = $1", [
      p.productId,
    ]);
    expect(r.rows[0]!.name).toBe("svc");
    expect(
      (await admin("select 1 from public.inventory_units where id = $1", [unit])).rowCount,
    ).toBe(0);
  });

  it("the explicit gate function is not available to anonymous or authenticated callers", async () => {
    for (const actor of [{ kind: "anon" as const }, as(multi, [A])]) {
      const t: Tx = await openTx(actor);
      expect(
        await outcome(t.q("select public.acquire_organization_gates($1::uuid[])", [[A.id]])),
      ).toBe("42501");
      await t.rollback();
    }
  });
});
