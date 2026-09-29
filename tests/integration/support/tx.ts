import type pg from "pg";
import { afterEach } from "vitest";
import { outcome } from "./availability";
import { admin, pool, type Actor } from "./db";

/**
 * Step-by-step transactions for deterministic race tests: A runs its critical statement and stays
 * open; B's competing statement must then be WAITING on a lock (pg_stat_activity).
 */
export interface Tx {
  pid: number;
  q: <T extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

// Transactions still open when a test fails are rolled back so later tests never wait on them.
const openTxs = new Set<Tx>();
afterEach(async () => {
  await Promise.all([...openTxs].map((t) => t.rollback()));
});

export async function openTx(actor: Actor): Promise<Tx> {
  const client = await pool.connect();
  await client.query("begin");
  const role =
    actor.kind === "anon" ? "anon" : actor.kind === "service" ? "service_role" : "authenticated";
  const claims =
    actor.kind === "user"
      ? { sub: actor.id, email: actor.email, role: "authenticated", aud: "authenticated" }
      : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
  const pid = (await client.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  let done = false;
  const end = async (sql: string) => {
    if (done) return;
    done = true;
    await client.query(sql).catch(() => undefined);
    client.release();
  };
  const tx: Tx = {
    pid,
    q: (text, params) => client.query(text, params),
    commit: async () => {
      openTxs.delete(tx);
      await end("commit");
    },
    rollback: async () => {
      openTxs.delete(tx);
      await end("rollback");
    },
  };
  openTxs.add(tx);
  return tx;
}

/** Resolves once `pid` is blocked on a lock; fails if it never blocks. */
export async function waitUntilBlocked(pid: number) {
  for (let i = 0; i < 100; i++) {
    const r = await admin<{ w: string | null }>(
      "select wait_event_type as w from pg_stat_activity where pid = $1",
      [pid],
    );
    if (r.rows[0]?.w === "Lock") return;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`backend ${pid} never waited on a lock`);
}

export const settle = (p: Promise<unknown>) => outcome(p);

export async function flagsFor(reservationId: string) {
  return (
    await admin<{ kind: string }>(
      "select kind::text as kind from public.reservation_flags where reservation_id = $1 order by kind",
      [reservationId],
    )
  ).rows.map((r) => r.kind);
}
