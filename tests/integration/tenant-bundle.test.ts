import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTenantBundle } from "../../scripts/tenant/apply-bundle.ts";
import { tenantBundleSchema, type TenantBundle } from "../../scripts/tenant/bundle-schema.ts";
import { testDatabaseUrl } from "./support/config";
import { admin, createOrg } from "./support/db";

const tiky = tenantBundleSchema.parse(
  JSON.parse(readFileSync("seeds/tenants/tiky-jumps/tenant.json", "utf8")),
);
const client = new pg.Client({ connectionString: testDatabaseUrl() });

beforeAll(async () => {
  await client.connect();
  await admin("delete from public.organizations where slug = 'tiky-jumps'");
});
afterAll(async () => {
  await client.end();
});

describe("tenant bundle (Tiky Jumps as data)", () => {
  it("creates the organization with its confirmed rules as configuration", async () => {
    const result = await applyTenantBundle(client, tiky);
    expect(result.createdOrganization).toBe(true);

    const { rows } = await admin(
      `select o.name, o.legal_name, o.timezone, o.status, s.wind_threshold_mph, s.free_delivery_miles::float as free,
              s.per_mile_rate_cents::int as per_mile, s.mileage_rounding_method, s.mileage_basis,
              s.default_setup_buffer_minutes, s.min_booking_lead_time_minutes, s.booking_hold_minutes
       from public.organizations o join public.organization_settings s on s.organization_id = o.id where o.id = $1`,
      [result.organizationId],
    );
    expect(rows).toEqual([
      {
        name: "Tiky Jumps",
        legal_name: "Tiky Jumps Inflatables LLC",
        timezone: "America/Chicago",
        status: "onboarding",
        wind_threshold_mph: 15,
        free: 5,
        per_mile: 400,
        mileage_rounding_method: "ceil_whole_mile",
        mileage_basis: "one_way",
        default_setup_buffer_minutes: 60,
        min_booking_lead_time_minutes: 720,
        booking_hold_minutes: 15,
      },
    ]);
    const slides = await admin(
      "select included_duration_minutes, wind_sensitive from public.categories where organization_id = $1 and slug = 'water-slides'",
      [result.organizationId],
    );
    expect(slides.rows).toEqual([{ included_duration_minutes: 240, wind_sensitive: true }]);
  });

  it("is idempotent: re-applying updates in place", async () => {
    const again = await applyTenantBundle(client, tiky);
    expect(again.createdOrganization).toBe(false);
    const { rows } = await admin(
      "select count(*)::int n from public.categories where organization_id = $1",
      [again.organizationId],
    );
    expect(rows).toEqual([{ n: tiky.categories.length }]);
  });

  it("issues a single owner invitation when an owner email is provided", async () => {
    const withOwner: TenantBundle = { ...tiky, ownerEmail: "owner@tiky.example" };
    const first = await applyTenantBundle(client, withOwner);
    expect(first.ownerInvitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { rows } = await admin(
      "select role, email::text from public.organization_invitations where organization_id = $1",
      [first.organizationId],
    );
    expect(rows).toEqual([{ role: "owner", email: "owner@tiky.example" }]);
  });

  it("refuses to claim another organization's hostname and rolls back", async () => {
    const other = await createOrg("bundle-other");
    await admin(
      "insert into public.organization_domains (organization_id, hostname) values ($1, 'taken.example.com')",
      [other.id],
    );
    const hostile: TenantBundle = {
      ...tiky,
      settings: { ...tiky.settings, windThresholdMph: 99 },
      domains: [{ hostname: "taken.example.com", primary: true }],
    };
    await expect(applyTenantBundle(client, hostile)).rejects.toThrow(/another organization/);
    const { rows } = await admin(
      "select s.wind_threshold_mph from public.organization_settings s join public.organizations o on o.id = s.organization_id where o.slug = 'tiky-jumps'",
    );
    expect(rows).toEqual([{ wind_threshold_mph: 15 }]);
  });

  it("rejects malformed bundles before touching the database", () => {
    expect(
      tenantBundleSchema.safeParse({ ...tiky, settings: { windThresholdMph: -5 } }).success,
    ).toBe(false);
    expect(
      tenantBundleSchema.safeParse({
        ...tiky,
        organization: { ...tiky.organization, slug: "Tiky Jumps" },
      }).success,
    ).toBe(false);
  });

  it("contains no Tiky Jumps references in application code", () => {
    // Guard for "Tiky Jumps must be data, not code".
    const result = spawnSync("git", ["grep", "-il", "tiky", "--", "src", "supabase/migrations"], {
      encoding: "utf8",
    });
    expect(result.status, result.stdout).toBe(1); // 1 = no matches
  });
});
