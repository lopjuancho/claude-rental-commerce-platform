import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The service-role client lives only in the system gateway. Its RPCs carry explicit EXECUTE grants;
 * any DIRECT table access must carry an explicit table grant too — never rely on the platform's
 * default privileges, which a hosted project need not apply (M7 live staging smoke: the audit
 * insert after create_quote failed on staging; tests/integration/ai-audit-privilege.test.ts).
 */
const gateway = readFileSync("src/server/trusted/gateway.ts", "utf8");
const migrations = readdirSync("supabase/migrations")
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`supabase/migrations/${f}`, "utf8"))
  .join("\n");
const VERB = {
  insert: "insert",
  select: "select",
  update: "update",
  delete: "delete",
  upsert: "insert",
};

describe("system gateway: direct table access is explicitly granted to service_role", () => {
  const uses = [
    ...gateway.matchAll(/db\.from\("([a-z_]+)"\)\s*\.(insert|select|update|delete|upsert)\(/g),
  ];

  it("finds the gateway's direct table access (audit_logs insert)", () => {
    expect(uses.map((m) => `${m[1]!}.${m[2]!}`)).toContain("audit_logs.insert");
  });

  it.each(uses.map((m) => [m[1]!, VERB[m[2] as keyof typeof VERB]] as const))(
    "%s: %s is granted to service_role by a migration",
    (table, verb) => {
      const grant = new RegExp(
        `grant\\s+[a-z, ]*\\b${verb}\\b[a-z, ]*\\s+on\\s+(?:table\\s+)?public\\.${table}\\s+to\\s+[a-z_, ]*\\bservice_role\\b`,
        "i",
      );
      expect(migrations).toMatch(grant);
    },
  );
});
