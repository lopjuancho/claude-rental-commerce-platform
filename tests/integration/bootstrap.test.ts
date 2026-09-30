import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./support/config";
import { admin, pool } from "./support/db";
import { settle, waitUntilBlocked } from "./support/tx";

/**
 * Fresh bootstrap (CI run #14 on 5e0bb38 failed here): an EMPTY database, every migration, then
 * supabase/seed.sql applied as ONE transaction exactly like the Supabase CLI does — both fictional
 * tenants must seed completely, with no RA014 / 55P03 from the organization-gate protocol.
 *
 * - Local runs (disposable Postgres): a scratch database is built from nothing here.
 * - CI (SKIP_DB_SETUP=1): `supabase start` just did precisely that bootstrap on an empty database
 *   (and aborts the job on any seed error); the test asserts its result.
 */
const ACME = "10000000-0000-4000-8000-000000000001";
const FUNTIME = "20000000-0000-4000-8000-000000000001";

type Query = <T extends pg.QueryResultRow>(
  text: string,
  params: unknown[],
) => Promise<pg.QueryResult<T>>;

async function assertSeeded(query: Query) {
  const r = await query<{
    orgs: string;
    acme_color: string;
    funtime_color: string;
    acme_categories: number;
    acme_products: number;
    acme_units: number;
    acme_pooled: number;
    acme_rules: number;
    funtime_members: number;
    domains: number;
  }>(
    `select
       (select string_agg(slug, ',' order by slug) from public.organizations where id in ($1, $2)) orgs,
       (select primary_color from public.organization_settings where organization_id = $1) acme_color,
       (select primary_color from public.organization_settings where organization_id = $2) funtime_color,
       (select count(*)::int from public.categories where organization_id = $1) acme_categories,
       (select count(*)::int from public.products where organization_id = $1) acme_products,
       (select count(*)::int from public.inventory_units where organization_id = $1) acme_units,
       (select count(*)::int from public.product_variants where organization_id = $1 and pooled_quantity = 200) acme_pooled,
       (select count(*)::int from public.weather_hazard_rules where organization_id = $1) acme_rules,
       (select count(*)::int from public.organization_members where organization_id = $2) funtime_members,
       (select count(*)::int from public.organization_domains where organization_id in ($1, $2)) domains`,
    [ACME, FUNTIME],
  );
  expect(r.rows[0]).toMatchObject({
    orgs: "acme,funtime",
    acme_color: "#2563eb",
    funtime_color: "#db2777",
    acme_categories: 4, // incl. one unpublished storefront fixture
    acme_products: 5, // incl. storefront fixtures (one unpublished, one multi-price)
    acme_pooled: 1,
    acme_rules: 3,
    domains: 4, // primaries + a verified alias and an unverified host (SEO fixtures)
  });
  expect(r.rows[0]!.acme_units).toBeGreaterThan(0);
  expect(r.rows[0]!.funtime_members).toBeGreaterThan(0);
}

describe("fresh bootstrap: empty database → all migrations → seed.sql", () => {
  if (process.env.SKIP_DB_SETUP === "1") {
    it("the stack bootstrapped from empty (supabase start: migrations + seed) seeded both tenants", async () => {
      await assertSeeded((text, params) => pool.query(text, params));
    });
  } else {
    it("seeds both fictional tenants in one transaction without RA014 / 55P03", async () => {
      const name = `rc_bootstrap_${randomUUID().slice(0, 8)}`;
      const base = new URL(testDatabaseUrl());
      // Empty database + Supabase shim + every migration (the same script CI's local runs use).
      execFileSync("bash", ["scripts/test-db.sh"], {
        env: { ...process.env, TEST_DB_NAME: name },
        stdio: "pipe",
      });
      const url = new URL(base);
      url.pathname = `/${name}`;
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        // As the Supabase CLI applies it: the whole file, one transaction.
        await client.query("begin");
        await client.query(readFileSync("supabase/seed.sql", "utf8"));
        await client.query("commit");
        await assertSeeded((text, params) => client.query(text, params));
      } finally {
        await client.end();
        await admin(`drop database if exists ${name} with (force)`).catch(() => undefined);
      }
    });
  }
});

describe("a script declaring several organizations takes their gates in canonical uuid order", () => {
  it("declared in reverse input order [funtime, acme] → acme first, then funtime", async () => {
    const [lo, hi] = [ACME, FUNTIME].sort();
    const blocker = await pool.connect();
    const script = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select app.lock_organization($1, true)", [hi]); // the higher gate is busy
      await script.query("begin");
      const pid = (await script.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!.pid;
      const declared = settle(script.query("select app.acquire_org_gates($1::uuid[])", [[hi, lo]]));
      await waitUntilBlocked(pid);
      const locks = async (granted: boolean) =>
        (
          await admin<{ id: string }>(
            `select o.id::text id from (values ($2::uuid), ($3::uuid)) o(id)
             where exists (select 1 from pg_locks l where l.pid = $1 and l.locktype = 'advisory' and l.granted = $4
                             and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('org:' || o.id::text, 0))
             order by 1`,
            [pid, lo, hi, granted],
          )
        ).rows.map((x) => x.id);
      expect(await locks(true)).toEqual([lo]); // the lower one is taken first…
      expect(await locks(false)).toEqual([hi]); // …then it waits for the higher one, holding no rows
      await blocker.query("commit");
      expect(await declared).toBe("ok");
      expect(await locks(true)).toEqual([lo, hi]);
      const recorded = await script.query<{ x: string }>(
        "select current_setting('app.locks_org_x', true) x",
      );
      expect(recorded.rows[0]!.x).toBe(`${lo},${hi},`); // recorded in the same canonical order
    } finally {
      await blocker.query("rollback").catch(() => undefined);
      await script.query("rollback").catch(() => undefined);
      blocker.release();
      script.release();
    }
  });
});
