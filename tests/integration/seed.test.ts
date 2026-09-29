import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pool } from "./support/db";

/**
 * The development seed (supabase/seed.sql) must satisfy the organization-gate protocol: the
 * Supabase CLI applies it as one transaction, so it is applied here the same way and rolled back.
 */
describe("supabase/seed.sql", () => {
  it("applies cleanly in one transaction (declares every organization it writes)", async () => {
    const sql = readFileSync("supabase/seed.sql", "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await expect(client.query(sql)).resolves.toBeDefined();
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
