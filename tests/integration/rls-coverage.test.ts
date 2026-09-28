import { beforeAll, describe, expect, it } from "vitest";
import { admin, as, type TestOrg, createOrg } from "./support/db";
import { GLOBAL_TABLES, PUBLIC_VIEWS, TENANT_TABLES, USER_TABLES } from "./support/tenant-tables";

/**
 * Tenant isolation matrix (ARCHITECTURE.md §10, DATABASE.md §12.3).
 * For every tenant table: RLS on + forced, anon has no access, a member of another organization
 * (even its owner) can neither read nor modify the row, and the owning org can read it.
 */
let orgA: TestOrg;
let orgB: TestOrg;

beforeAll(async () => {
  orgA = await createOrg("iso-a");
  orgB = await createOrg("iso-b");
  for (const { ensureRow } of Object.values(TENANT_TABLES)) {
    await ensureRow(orgA);
    await ensureRow(orgB);
  }
});

describe("schema coverage", () => {
  it("classifies every public table (tenant, user or global)", async () => {
    const { rows } = await admin<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const known = new Set<string>([
      ...Object.keys(TENANT_TABLES),
      ...GLOBAL_TABLES,
      ...USER_TABLES,
    ]);
    const unclassified = rows.map((r) => r.table_name).filter((t) => !known.has(t));
    expect(unclassified, "add new tables to tests/integration/support/tenant-tables.ts").toEqual(
      [],
    );
  });

  it("enables and forces RLS on every public table and defines at least one policy", async () => {
    const { rows } = await admin<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: number;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    const bad = rows
      .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || r.policies === 0)
      .map((r) => r.relname);
    expect(bad).toEqual([]);
  });

  it("grants anon nothing on tables, and only SELECT on the allow-listed public views", async () => {
    const { rows } = await admin<{ table_name: string; privilege_type: string }>(`
      select table_name, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'anon' order by 1, 2`);
    expect(rows).toEqual(PUBLIC_VIEWS.map((v) => ({ table_name: v, privilege_type: "SELECT" })));
  });

  it("allow-lists every view in the public schema", async () => {
    const { rows } = await admin<{ table_name: string }>(
      "select table_name from information_schema.views where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toEqual([...PUBLIC_VIEWS]);
  });

  it("exposes only allow-listed public functions to anon", async () => {
    const { rows } = await admin<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')
      order by 1`);
    expect(rows.map((r) => r.proname)).toEqual([
      "resolve_organization_by_host",
      "resolve_organization_by_slug",
    ]);
  });
});

describe.each(Object.entries(TENANT_TABLES))("tenant table %s", (table, { orgColumn }) => {
  it("is readable by its own organization (positive control)", async () => {
    const count = await as(orgA.users.owner, async (sql) => {
      const { rows } = await sql(
        `select count(*)::int as n from public.${table} where ${orgColumn} = $1`,
        [orgA.id],
      );
      return (rows[0] as { n: number }).n;
    });
    expect(count).toBeGreaterThan(0);
  });

  it("is invisible to another organization's owner", async () => {
    const count = await as(orgB.users.owner, async (sql) => {
      const { rows } = await sql(
        `select count(*)::int as n from public.${table} where ${orgColumn} = $1`,
        [orgA.id],
      );
      return (rows[0] as { n: number }).n;
    });
    expect(count).toBe(0);
  });

  it.each(["update", "delete"] as const)(
    "cannot be %sd by another organization's owner",
    async (op) => {
      const affected = await as(orgB.users.owner, async (sql) => {
        try {
          const statement =
            op === "update"
              ? `update public.${table} set ${orgColumn} = ${orgColumn} where ${orgColumn} = $1`
              : `delete from public.${table} where ${orgColumn} = $1`;
          return (await sql(statement, [orgA.id])).rowCount ?? 0;
        } catch (error) {
          if ((error as { code?: string }).code === "42501") return 0; // privilege denied is also a denial
          throw error;
        }
      });
      expect(affected).toBe(0);
      const stillThere = await admin(
        `select count(*)::int as n from public.${table} where ${orgColumn} = $1`,
        [orgA.id],
      );
      expect((stillThere.rows[0] as { n: number }).n).toBeGreaterThan(0);
    },
  );

  it("is not readable by anonymous visitors", async () => {
    await as({ kind: "anon" }, async (sql) => {
      await expect(sql(`select 1 from public.${table} limit 1`)).rejects.toMatchObject({
        code: "42501",
      });
    });
  });
});
