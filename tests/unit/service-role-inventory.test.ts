import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hardening H5: the service-role (RLS-bypassing) client is reachable only through the trusted
 * gateway, whose operations are an explicit, reviewed list. This test fails if anyone adds a new
 * service-role path, a generic table access, or an unlisted function call.
 */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}
const SRC = files("src");
const read = (p: string) => readFileSync(p, "utf8");

describe("service-role boundary", () => {
  it("only the system client module and the trusted gateway reference the service-role client", () => {
    const users = SRC.filter((p) => /createSystemClient|db\/system/.test(read(p)));
    expect(users.sort()).toEqual(["src/server/db/system.ts", "src/server/trusted/gateway.ts"]);
  });

  it("the service-role key is read only by env validation and the system client", () => {
    const users = SRC.filter((p) => read(p).includes("SUPABASE_SERVICE_ROLE_KEY"));
    expect(users.sort()).toEqual(["src/server/db/system.ts", "src/server/env.ts"]);
  });

  it("the gateway calls only the reviewed SQL functions and writes only the audit log", () => {
    const src = read("src/server/trusted/gateway.ts");
    const rpcs = [...src.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(rpcs).toEqual(
      [
        // pricing (hardening H2/H3/H5)
        "delivery_area_context",
        "get_cached_distance",
        "pricing_context",
        "put_cached_distance",
        "record_pricing_calculation",
        "tax_context",
        // public quote / booking flow (M5, ADR 0015)
        "cancel_booking_by_token",
        "create_event",
        "create_quote",
        "match_or_create_customer",
        "public_quote_view",
        "renew_booking_hold_by_token",
        "request_booking_by_token",
      ].sort(),
    );
    const tables = [...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
    expect(tables).toEqual(["audit_logs"]);
    expect(src).not.toMatch(/\.(update|delete|upsert)\(/);
    expect(src.match(/\.insert\(/g)).toHaveLength(1);
  });

  it("no client component, page or route imports the gateway directly", () => {
    const offenders = SRC.filter(
      (p) => p.startsWith("src/app/") && /@\/server\/trusted\/gateway/.test(read(p)),
    );
    expect(offenders).toEqual([]);
  });

  it("public services take the tenant as a ResolvedTenant, never an organization id from input", () => {
    for (const p of SRC.filter(
      (f) => f.startsWith("src/server/public/") && !f.endsWith("deps.ts"),
    )) {
      const src = read(p);
      for (const m of src.matchAll(/export async function \w+\(([^)]*)/g)) {
        expect(m[1], p).toMatch(/tenant: ResolvedTenant/);
      }
    }
  });
});
