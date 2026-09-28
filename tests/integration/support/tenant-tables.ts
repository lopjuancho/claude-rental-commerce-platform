import { randomBytes, randomUUID } from "node:crypto";
import { admin, type TestOrg } from "./db";

/**
 * Every table in the public schema must be classified here. The RLS coverage test fails when a
 * migration adds a table that is not listed, forcing an explicit isolation decision + fixture.
 */
export const GLOBAL_TABLES = ["role_permissions"] as const;

/** Tables keyed to a user rather than an organization; covered by dedicated tests. */
export const USER_TABLES = ["user_profiles"] as const;

/** Tenant-owned tables → the column holding the organization id, and a fixture that guarantees a row exists. */
export const TENANT_TABLES: Record<string, { orgColumn: string; ensureRow: (org: TestOrg) => Promise<void> }> = {
  organizations: { orgColumn: "id", ensureRow: async () => undefined },
  organization_settings: { orgColumn: "organization_id", ensureRow: async () => undefined },
  organization_members: { orgColumn: "organization_id", ensureRow: async () => undefined },
  audit_logs: { orgColumn: "organization_id", ensureRow: async () => undefined }, // written by member triggers
  organization_domains: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin("insert into public.organization_domains (organization_id, hostname) values ($1, $2)", [
        org.id,
        `${org.slug}.example.test`,
      ]);
    },
  },
  organization_policies: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        "insert into public.organization_policies (organization_id, policy_type, title, body) values ($1, 'other', 'T', 'B')",
        [org.id],
      );
    },
  },
  organization_invitations: {
    orgColumn: "organization_id",
    ensureRow: async (org) => {
      await admin(
        `insert into public.organization_invitations (organization_id, email, role, token_hash, expires_at)
         values ($1, $2, 'staff', $3, now() + interval '1 day')`,
        [org.id, `invitee-${randomUUID().slice(0, 8)}@example.test`, randomBytes(32).toString("hex")],
      );
    },
  },
};
