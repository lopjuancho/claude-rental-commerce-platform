import { createHash, randomBytes } from "node:crypto";
import type { ClientBase } from "pg";
import type { TenantBundle } from "./bundle-schema.ts";

export interface ApplyResult {
  organizationId: string;
  createdOrganization: boolean;
  ownerInvitationToken: string | null;
}

/**
 * Applies a tenant bundle idempotently inside ONE transaction on a privileged connection
 * (platform operator tooling; never reachable from the web app). Re-running updates in place.
 * Only rows of the bundle's own organization are touched.
 */
export async function applyTenantBundle(
  db: ClientBase,
  bundle: TenantBundle,
): Promise<ApplyResult> {
  await db.query("begin");
  try {
    const o = bundle.organization;
    const existing = await db.query<{ id: string }>(
      "select id from public.organizations where slug = $1 for update",
      [o.slug],
    );
    let organizationId = existing.rows[0]?.id;
    const createdOrganization = !organizationId;
    if (organizationId) {
      await db.query(
        "update public.organizations set name = $2, legal_name = $3, timezone = $4, currency = $5, country_code = $6 where id = $1",
        [organizationId, o.name, o.legalName ?? null, o.timezone, o.currency, o.countryCode],
      );
    } else {
      const inserted = await db.query<{ id: string }>(
        `insert into public.organizations (slug, name, legal_name, timezone, currency, country_code, status)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [o.slug, o.name, o.legalName ?? null, o.timezone, o.currency, o.countryCode, o.status],
      );
      organizationId = inserted.rows[0]!.id;
    }

    const s = bundle.settings;
    const settings: Record<string, unknown> = {
      primary_color: s.primaryColor,
      secondary_color: s.secondaryColor,
      accent_color: s.accentColor,
      contact_phone: s.contactPhone,
      sms_phone: s.smsPhone,
      contact_email: s.contactEmail,
      website_url: s.websiteUrl,
      default_setup_buffer_minutes: s.defaultSetupBufferMinutes,
      default_teardown_buffer_minutes: s.defaultTeardownBufferMinutes,
      default_rental_duration_minutes: s.defaultRentalDurationMinutes,
      min_booking_lead_time_minutes: s.minBookingLeadTimeMinutes,
      overnight_allowed: s.overnightAllowed,
      quote_valid_days: s.quoteValidDays,
      booking_hold_minutes: s.bookingHoldMinutes,
      multi_day_billing: s.multiDayBilling,
      primary_depot_address_line1: s.primaryDepot?.addressLine1,
      primary_depot_city: s.primaryDepot?.city,
      primary_depot_state: s.primaryDepot?.state,
      primary_depot_postal_code: s.primaryDepot?.postalCode,
      free_delivery_miles: s.mileage?.freeMiles,
      per_mile_rate_cents: s.mileage?.perMileRateCents,
      maximum_delivery_miles: s.mileage?.maximumMiles,
      mileage_rounding_method: s.mileage?.rounding,
      mileage_basis: s.mileage?.basis,
    };
    // Only keys present in the bundle are written; column names come from the fixed map above.
    const entries = Object.entries(settings).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      await db.query(
        `update public.organization_settings set ${entries.map(([k], i) => `${k} = $${i + 2}`).join(", ")} where organization_id = $1`,
        [organizationId, ...entries.map(([, v]) => v)],
      );
    }

    for (const d of bundle.domains) {
      const owner = await db.query<{ organization_id: string }>(
        "select organization_id from public.organization_domains where hostname = $1",
        [d.hostname],
      );
      const ownerId = owner.rows[0]?.organization_id;
      if (ownerId && ownerId !== organizationId)
        throw new Error(`Hostname ${d.hostname} belongs to another organization.`);
      if (!ownerId) {
        await db.query(
          "insert into public.organization_domains (organization_id, hostname, is_primary) values ($1, $2, $3)",
          [organizationId, d.hostname, d.primary],
        );
      }
    }

    const upsertRule = async (
      rule: TenantBundle["weatherRules"][number],
      categoryId: string | null,
    ) => {
      await db.query(
        `insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id, category_id, product_id, hazard) do update set
           sensitive = excluded.sensitive, threshold_value = excluded.threshold_value, threshold_unit = excluded.threshold_unit`,
        [
          organizationId,
          categoryId,
          rule.hazard,
          rule.sensitive,
          rule.thresholdValue ?? null,
          rule.thresholdUnit ?? null,
        ],
      );
    };
    for (const rule of bundle.weatherRules) await upsertRule(rule, null);

    for (const c of bundle.categories) {
      const category = await db.query<{ id: string }>(
        `insert into public.categories (organization_id, name, slug, sort_order, included_duration_minutes, setup_buffer_minutes,
                                        teardown_buffer_minutes, overnight_allowed)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (organization_id, slug) do update set
           name = excluded.name, sort_order = excluded.sort_order,
           included_duration_minutes = excluded.included_duration_minutes,
           setup_buffer_minutes = excluded.setup_buffer_minutes, teardown_buffer_minutes = excluded.teardown_buffer_minutes,
           overnight_allowed = excluded.overnight_allowed
         returning id`,
        [
          organizationId,
          c.name,
          c.slug,
          c.sortOrder,
          c.includedDurationMinutes ?? null,
          c.setupBufferMinutes ?? null,
          c.teardownBufferMinutes ?? null,
          c.overnightAllowed ?? null,
        ],
      );
      for (const rule of c.weather) await upsertRule(rule, category.rows[0]!.id);
    }

    for (const r of bundle.pricingRules) {
      const scope = r.categorySlug
        ? (
            await db.query<{ id: string }>(
              "select id from public.categories where organization_id = $1 and slug = $2",
              [organizationId, r.categorySlug],
            )
          ).rows[0]?.id
        : null;
      if (r.categorySlug && !scope)
        throw new Error(`Pricing rule ${r.name}: unknown category ${r.categorySlug}`);
      await db.query(
        `insert into public.pricing_rules (organization_id, name, rule_type, category_id, params, priority, is_active)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (organization_id, name) do update set
           rule_type = excluded.rule_type, category_id = excluded.category_id, params = excluded.params,
           priority = excluded.priority, is_active = excluded.is_active`,
        [
          organizationId,
          r.name,
          r.type,
          scope ?? null,
          JSON.stringify(r.params),
          r.priority,
          r.active,
        ],
      );
    }

    for (const p of bundle.policies) {
      if (p.placeholder) {
        // Never overwrite real wording with a placeholder.
        await db.query(
          `insert into public.organization_policies (organization_id, policy_type, title, body, is_published, is_placeholder)
           select $1, $2, $3, $4, false, true
           where not exists (select 1 from public.organization_policies where organization_id = $1 and policy_type = $2)`,
          [organizationId, p.type, p.title, p.body],
        );
        continue;
      }
      const found = await db.query<{ id: string }>(
        "select id from public.organization_policies where organization_id = $1 and policy_type = $2 order by is_placeholder, created_at limit 1",
        [organizationId, p.type],
      );
      if (found.rows[0]) {
        await db.query(
          `update public.organization_policies
           set version = version + (body <> $2)::int, title = $3, body = $2, is_published = $4, is_placeholder = false
           where id = $1`,
          [found.rows[0].id, p.body, p.title, p.published],
        );
      } else {
        await db.query(
          "insert into public.organization_policies (organization_id, policy_type, title, body, is_published) values ($1, $2, $3, $4, $5)",
          [organizationId, p.type, p.title, p.body, p.published],
        );
      }
    }

    let ownerInvitationToken: string | null = null;
    if (bundle.ownerEmail) {
      const hasOwner = await db.query(
        "select 1 from public.organization_members where organization_id = $1 and role = 'owner' and status = 'active'",
        [organizationId],
      );
      if (hasOwner.rowCount === 0) {
        ownerInvitationToken = randomBytes(32).toString("base64url");
        await db.query(
          `insert into public.organization_invitations (organization_id, email, role, token_hash, expires_at)
           values ($1, $2, 'owner', $3, now() + interval '7 days')`,
          [
            organizationId,
            bundle.ownerEmail,
            createHash("sha256").update(ownerInvitationToken).digest("hex"),
          ],
        );
      }
    }

    await db.query("commit");
    return { organizationId, createdOrganization, ownerInvitationToken };
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
