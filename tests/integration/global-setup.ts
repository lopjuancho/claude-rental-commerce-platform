import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { testDatabaseUrl } from "./support/config";

/**
 * Prepares the integration database (ADR 0007).
 * - Default: rebuilds a disposable local Postgres DB with the Supabase shim + all migrations.
 * - SKIP_DB_SETUP=1: use DATABASE_URL as-is (e.g. after `supabase db reset` in CI).
 * Fails loudly when no database is reachable: integration tests never skip silently.
 */
export default async function setup(): Promise<void> {
  if (process.env.SKIP_DB_SETUP !== "1") {
    execFileSync("bash", ["scripts/test-db.sh"], { stdio: "inherit" });
  }
  const client = new Client({ connectionString: testDatabaseUrl() });
  try {
    await client.connect();
    await client.query("select 1");
  } catch (error) {
    throw new Error(
      `Integration database unreachable at ${testDatabaseUrl()}. Start Postgres or the Supabase stack.`,
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}
