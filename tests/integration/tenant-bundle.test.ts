import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTenantBundle } from "../../scripts/tenant/apply-bundle.ts";
import { tenantBundleSchema, type TenantBundle } from "../../scripts/tenant/bundle-schema.ts";
import { testDatabaseUrl } from "./support/config";
import { admin, createOrg, expectDenied } from "./support/db";

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
  let orgId: string;

  it("creates the organization with its confirmed configuration", async () => {
    const result = await applyTenantBundle(client, tiky);
    expect(result.createdOrganization).toBe(true);
    expect(result.ownerInvitationToken).toBeNull(); // owner email deliberately unset
    orgId = result.organizationId;

    const { rows } = await admin(
      `select o.name, o.legal_name, o.timezone, o.status, s.contact_phone, s.sms_phone, s.website_url,
              s.free_delivery_miles::float as free, s.per_mile_rate_cents::int as per_mile, s.maximum_delivery_miles,
              s.mileage_rounding_method, s.mileage_basis, s.primary_depot_address_line1,
              s.default_setup_buffer_minutes, s.default_teardown_buffer_minutes, s.min_booking_lead_time_minutes,
              s.booking_hold_minutes, s.primary_color, s.secondary_color, s.accent_color, s.logo_media_path
       from public.organizations o join public.organization_settings s on s.organization_id = o.id where o.id = $1`,
      [orgId],
    );
    expect(rows).toEqual([
      {
        name: "Tiky Jumps",
        legal_name: "Tiky Jumps Inflatables LLC",
        timezone: "America/Chicago",
        status: "onboarding",
        contact_phone: "+19013000417",
        sms_phone: "+19012508127",
        website_url: "https://www.tikyjumps.com",
        free: 5,
        per_mile: 400,
        maximum_delivery_miles: null, // unset: out-of-area → manual review
        mileage_rounding_method: "ceil_whole_mile",
        mileage_basis: "one_way",
        primary_depot_address_line1: "2560 Overton Crossing St",
        default_setup_buffer_minutes: 60,
        default_teardown_buffer_minutes: 60,
        min_booking_lead_time_minutes: 720,
        booking_hold_minutes: 15,
        primary_color: null, // branding comes from Tiky Jumps' assets, not assumptions
        secondary_color: null,
        accent_color: null,
        logo_media_path: null,
      },
    ]);

    const depot = await admin(
      "select primary_depot_city, primary_depot_state, primary_depot_postal_code from public.organization_settings where organization_id = $1",
      [orgId],
    );
    expect(depot.rows).toEqual([
      {
        primary_depot_city: "Memphis",
        primary_depot_state: "TN",
        primary_depot_postal_code: "38127",
      },
    ]);
    // Only the confirmed pricing rule: no invented overnight or extra-hour charges.
    const rules = await admin(
      "select rule_type, params, category_id from public.pricing_rules where organization_id = $1",
      [orgId],
    );
    expect(rules.rows).toEqual([
      { rule_type: "additional_day", params: { percent_of_base_bps: 2500 }, category_id: null },
    ]);

    const domains = await admin(
      "select hostname::text, is_primary from public.organization_domains where organization_id = $1 order by hostname",
      [orgId],
    );
    expect(domains.rows).toEqual([
      { hostname: "tikyjumps.com", is_primary: true },
      { hostname: "www.tikyjumps.com", is_primary: false },
    ]);
  });

  it("applies weather rules per category: inflatables 15 mph wind, trains not wind sensitive, tents/foam unset", async () => {
    const { rows } = await admin<{
      slug: string;
      hazard: string | null;
      sensitive: boolean | null;
      threshold: number | null;
    }>(
      `select c.slug, r.hazard::text as hazard, r.sensitive, r.threshold_value::float as threshold
       from public.categories c left join public.weather_hazard_rules r on r.category_id = c.id
       where c.organization_id = $1 order by c.sort_order`,
      [orgId],
    );
    const bySlug = Object.fromEntries(
      rows.map((r) => [
        r.slug,
        r.hazard ? { hazard: r.hazard, sensitive: r.sensitive, threshold: r.threshold } : null,
      ]),
    );
    for (const slug of ["bounce-houses", "water-slides", "combos", "interactives"]) {
      expect(bySlug[slug]).toEqual({ hazard: "wind", sensitive: true, threshold: 15 });
    }
    expect(bySlug["trackless-trains"]).toEqual({
      hazard: "wind",
      sensitive: false,
      threshold: null,
    });
    expect(bySlug.tents).toBeNull();
    expect(bySlug["foam-parties"]).toBeNull();
    const org = await admin(
      "select count(*)::int n from public.weather_hazard_rules where organization_id = $1 and category_id is null and product_id is null",
      [orgId],
    );
    expect(org.rows).toEqual([{ n: 0 }]); // no organization-wide wind default that tents would inherit
    const slides = await admin(
      "select included_duration_minutes from public.categories where organization_id = $1 and slug = 'water-slides'",
      [orgId],
    );
    expect(slides.rows).toEqual([{ included_duration_minutes: 240 }]);
  });

  it("creates unpublished placeholder policies for every required type", async () => {
    const { rows } = await admin<{
      policy_type: string;
      is_published: boolean;
      is_placeholder: boolean;
    }>(
      "select policy_type, is_published, is_placeholder from public.organization_policies where organization_id = $1 order by policy_type",
      [orgId],
    );
    expect(rows.map((r) => r.policy_type)).toEqual([
      "cancellation",
      "delivery",
      "operator_requirements",
      "overnight",
      "power_requirements",
      "setup_requirements",
      "supervision",
      "water_requirements",
      "weather",
      "wind_safety",
    ]);
    expect(rows.every((r) => !r.is_published && r.is_placeholder)).toBe(true);
  });

  it("the database refuses to publish placeholder wording", async () => {
    await expectDenied(
      admin(
        "update public.organization_policies set is_published = true where organization_id = $1 and policy_type = 'weather'",
        [orgId],
      ),
      ["23514"],
    );
  });

  it("entering real wording clears the placeholder flag; re-applying never overwrites it", async () => {
    await admin(
      "update public.organization_policies set body = 'Real Tiky Jumps weather wording.' where organization_id = $1 and policy_type = 'weather'",
      [orgId],
    );
    await admin(
      "update public.organization_policies set is_published = true where organization_id = $1 and policy_type = 'weather'",
      [orgId],
    );
    await applyTenantBundle(client, tiky);
    const { rows } = await admin(
      "select body, is_published, is_placeholder from public.organization_policies where organization_id = $1 and policy_type = 'weather'",
      [orgId],
    );
    expect(rows).toEqual([
      { body: "Real Tiky Jumps weather wording.", is_published: true, is_placeholder: false },
    ]);
  });

  it("is idempotent: re-applying updates in place", async () => {
    const again = await applyTenantBundle(client, tiky);
    expect(again.createdOrganization).toBe(false);
    const counts = await admin(
      `select (select count(*)::int from public.categories where organization_id = $1) as categories,
              (select count(*)::int from public.weather_hazard_rules where organization_id = $1) as rules,
              (select count(*)::int from public.organization_policies where organization_id = $1) as policies,
              (select count(*)::int from public.organization_domains where organization_id = $1) as domains`,
      [orgId],
    );
    expect(counts.rows).toEqual([{ categories: 8, rules: 5, policies: 10, domains: 2 }]);
  });

  it("the storefront resolves both domains to the same tenant once active, with the brand profile", async () => {
    await admin("update public.organizations set status = 'active' where id = $1", [orgId]);
    for (const host of ["tikyjumps.com", "WWW.TIKYJUMPS.COM"]) {
      const { rows } = await admin(
        "select id, sms_phone, website_url, accent_color, favicon_media_path from public.resolve_organization_by_host($1)",
        [host],
      );
      expect(rows).toEqual([
        {
          id: orgId,
          sms_phone: "+19012508127",
          website_url: "https://www.tikyjumps.com",
          accent_color: null,
          favicon_media_path: null,
        },
      ]);
    }
    await admin("update public.organizations set status = 'onboarding' where id = $1", [orgId]);
  });

  it("issues a single owner invitation only when an owner email is provided", async () => {
    const withOwner: TenantBundle = { ...tiky, ownerEmail: "owner@tiky.example" };
    const first = await applyTenantBundle(client, withOwner);
    expect(first.ownerInvitationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await admin("delete from public.organization_invitations where organization_id = $1", [orgId]);
  });

  it("refuses to claim another organization's hostname and rolls back", async () => {
    const other = await createOrg("bundle-other");
    await admin(
      "insert into public.organization_domains (organization_id, hostname) values ($1, 'taken.example.com')",
      [other.id],
    );
    const hostile: TenantBundle = {
      ...tiky,
      settings: { ...tiky.settings, bookingHoldMinutes: 99 },
      domains: [{ hostname: "taken.example.com", primary: true }],
    };
    await expect(applyTenantBundle(client, hostile)).rejects.toThrow(/another organization/);
    const { rows } = await admin(
      "select booking_hold_minutes from public.organization_settings where organization_id = $1",
      [orgId],
    );
    expect(rows).toEqual([{ booking_hold_minutes: 15 }]);
  });

  it("rejects malformed bundles before touching the database", () => {
    expect(
      tenantBundleSchema.safeParse({ ...tiky, settings: { bookingHoldMinutes: -5 } }).success,
    ).toBe(false);
    expect(
      tenantBundleSchema.safeParse({
        ...tiky,
        organization: { ...tiky.organization, slug: "Tiky Jumps" },
      }).success,
    ).toBe(false);
    expect(
      tenantBundleSchema.safeParse({
        ...tiky,
        policies: [{ type: "weather", title: "t", body: "b", placeholder: true, published: true }],
      }).success,
    ).toBe(false);
    expect(
      tenantBundleSchema.safeParse({
        ...tiky,
        weatherRules: [{ hazard: "wind", sensitive: true, thresholdValue: 15 }],
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
