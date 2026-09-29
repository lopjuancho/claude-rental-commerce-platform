import { randomUUID } from "node:crypto";
import pg from "pg";
import { testDatabaseUrl } from "./config";

/**
 * Test harness that exercises RLS exactly like Supabase's API does: each call runs in a
 * transaction as the `anon`, `authenticated` or `service_role` role with JWT claims set in
 * `request.jwt.claims`, and is rolled back unless `commit: true`.
 */
export const pool = new pg.Pool({ connectionString: testDatabaseUrl(), max: 25 });

export type Actor =
  | { kind: "anon" }
  | { kind: "service" }
  | {
      kind: "user";
      id: string;
      email: string;
      /** The user's active organization (what the app sends as the mutation target). */
      organizationId?: string;
      /** Explicit mutation targets; overrides organizationId (ADR 0015 §16). */
      orgTargets?: string[];
    };

/**
 * The organization(s) a user's request declares as its mutation targets — what the app's user
 * client sends as the `x-org-targets` header, visible to SQL as `request.headers` (PostgREST).
 */
export function requestHeadersFor(actor: Actor): string {
  if (actor.kind !== "user") return "{}";
  const targets = actor.orgTargets ?? (actor.organizationId ? [actor.organizationId] : []);
  return JSON.stringify(targets.length ? { "x-org-targets": targets.join(",") } : {});
}

type Row = Record<string, unknown>;

export type Sql = <T extends pg.QueryResultRow = Row>(
  text: string,
  params?: unknown[],
) => Promise<pg.QueryResult<T>>;

export async function as<T>(
  actor: Actor,
  fn: (sql: Sql) => Promise<T>,
  options: { commit?: boolean } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const role =
      actor.kind === "anon" ? "anon" : actor.kind === "service" ? "service_role" : "authenticated";
    const claims =
      actor.kind === "user"
        ? { sub: actor.id, email: actor.email, role: "authenticated", aud: "authenticated" }
        : { role };
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    await client.query("select set_config('request.headers', $1, true)", [
      requestHeadersFor(actor),
    ]);
    await client.query(`set local role ${role}`);
    const sql: Sql = (text, params) => client.query(text, params);
    const result = await fn(sql);
    if (options.commit) await client.query("commit");
    return result;
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
}

/** Superuser access for fixtures. Committed. */
export async function admin<T extends pg.QueryResultRow = Row>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Superuser write to capacity/availability tables (products, variants, units, blocks, settings…):
 * like a script, it takes the organization gate first (ADR 0015 §15), then runs the statement.
 */
export async function adminGated<T extends pg.QueryResultRow = Row>(
  organizationId: string,
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select app.lock_organization($1, true)", [organizationId]);
    const result = await client.query<T>(text, params);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Expect the statement to be refused by the database; returns the SQLSTATE. */
export async function expectDenied(
  p: Promise<unknown>,
  codes: string[] = ["42501"],
): Promise<string> {
  try {
    await p;
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (codes.includes(code)) return code;
    throw new Error(
      `Expected SQLSTATE ${codes.join("/")} but got ${code}: ${(error as Error).message}`,
    );
  }
  throw new Error(`Expected SQLSTATE ${codes.join("/")} but the statement succeeded`);
}

export interface TestUser {
  kind: "user";
  id: string;
  email: string;
  organizationId?: string;
  orgTargets?: string[];
}

export async function createUser(label: string): Promise<TestUser> {
  const id = randomUUID();
  const email = `${label}-${id.slice(0, 8)}@example.test`;
  await admin("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return { kind: "user", id, email };
}

export interface TestOrg {
  id: string;
  slug: string;
  users: Record<"owner" | "admin" | "office" | "staff", TestUser>;
}

/** Creates an active organization with one user per role. */
export async function createOrg(label: string, status = "active"): Promise<TestOrg> {
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const owner = await createUser(`${label}-owner`);
  const { rows } = await admin(
    "select public.create_organization($1, $2, 'America/Chicago', $3) as id",
    [slug, `Org ${label}`, owner.id],
  );
  const id = (rows[0] as { id: string }).id;
  await admin("update public.organizations set status = $2 where id = $1", [id, status]);
  const users = { owner } as TestOrg["users"];
  for (const role of ["admin", "office", "staff"] as const) {
    const user = await createUser(`${label}-${role}`);
    await admin(
      "insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)",
      [id, user.id, role],
    );
    users[role] = user;
  }
  for (const u of Object.values(users)) u.organizationId = id;
  return { id, slug, users };
}
