/**
 * Onboards or updates a tenant from a configuration bundle (platform operators only).
 *
 *   DATABASE_URL=postgresql://… node scripts/import-tenant.ts seeds/tenants/tiky-jumps [--app-origin=https://…]
 *
 * DATABASE_URL must be a privileged connection for the target environment. Never run against
 * production from a developer laptop without the change being reviewed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { applyTenantBundle } from "./tenant/apply-bundle.ts";
import { tenantBundleSchema } from "./tenant/bundle-schema.ts";

const dir = process.argv[2];
const originArg = process.argv.find((a) => a.startsWith("--app-origin="));
if (!dir || !process.env.DATABASE_URL) {
  console.error(
    "Usage: DATABASE_URL=… node scripts/import-tenant.ts <bundle-dir> [--app-origin=https://…]",
  );
  process.exit(2);
}

const parsed = tenantBundleSchema.safeParse(
  JSON.parse(readFileSync(join(dir, "tenant.json"), "utf8")),
);
if (!parsed.success) {
  console.error("Invalid tenant bundle:");
  for (const issue of parsed.error.issues)
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const result = await applyTenantBundle(client, parsed.data);
  console.log(
    `${result.createdOrganization ? "Created" : "Updated"} organization ${parsed.data.organization.slug} (${result.organizationId}).`,
  );
  if (result.ownerInvitationToken) {
    const origin = originArg?.slice("--app-origin=".length) ?? "<APP_ORIGIN>";
    console.log(
      `Owner invitation for ${parsed.data.ownerEmail ?? ""} (shown once, expires in 7 days):`,
    );
    console.log(`  ${origin}/invite?token=${result.ownerInvitationToken}`);
  }
} finally {
  await client.end();
}
