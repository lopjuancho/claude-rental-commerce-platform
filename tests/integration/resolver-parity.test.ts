import { beforeAll, describe, expect, it } from "vitest";
import { resolveRentalConfig } from "@/domain/config/resolve";
import type { ThresholdUnit, WeatherHazard } from "@/domain/weather/hazards";
import { type HazardRule, resolveHazardRules } from "@/domain/weather/resolve";
import { makeProduct, rpc } from "./support/availability";
import { admin, createOrg, type TestOrg } from "./support/db";

/**
 * Logic that exists in both layers must agree: the ADR 0003 override chain (SQL variant_context /
 * pricing_context vs src/domain/config/resolve.ts) and weather hazard resolution
 * (app.product_hazard_rules vs src/domain/weather/resolve.ts). Randomised, seeded.
 */
let seed = 20260929;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed % n;
};
const maybe = <T>(v: T): T | null => (rand(2) === 0 ? null : v);

let org: TestOrg;
beforeAll(async () => {
  org = await createOrg("parity");
});

describe("override chain parity (variant → product → category → organization)", () => {
  it("agrees on 40 random configurations", async () => {
    for (let i = 0; i < 40; i++) {
      const orgLevel = {
        defaultSetupBufferMinutes: rand(120),
        defaultTeardownBufferMinutes: rand(120),
        defaultRentalDurationMinutes: 60 + rand(600),
        minBookingLeadTimeMinutes: rand(2000),
        overnightAllowed: rand(2) === 0,
      };
      const cat = {
        setupBufferMinutes: maybe(rand(200)),
        teardownBufferMinutes: maybe(rand(200)),
        includedDurationMinutes: maybe(60 + rand(300)),
        overnightAllowed: maybe(rand(2) === 0),
      };
      const prod = {
        setupBufferMinutes: maybe(rand(200)),
        teardownBufferMinutes: maybe(rand(200)),
        includedDurationMinutes: maybe(60 + rand(300)),
        overnightAllowed: maybe(rand(2) === 0),
        minBookingLeadTimeMinutes: maybe(rand(3000)),
      };
      const variant = {
        setupBufferMinutes: maybe(rand(200)),
        teardownBufferMinutes: maybe(rand(200)),
      };

      await admin(
        `update public.organization_settings set default_setup_buffer_minutes = $2, default_teardown_buffer_minutes = $3,
           default_rental_duration_minutes = $4, min_booking_lead_time_minutes = $5, overnight_allowed = $6 where organization_id = $1`,
        [
          org.id,
          orgLevel.defaultSetupBufferMinutes,
          orgLevel.defaultTeardownBufferMinutes,
          orgLevel.defaultRentalDurationMinutes,
          orgLevel.minBookingLeadTimeMinutes,
          orgLevel.overnightAllowed,
        ],
      );
      const c = await admin<{ id: string }>(
        "insert into public.categories (organization_id, name, slug, setup_buffer_minutes, teardown_buffer_minutes, included_duration_minutes, overnight_allowed) values ($1, $2, $2, $3, $4, $5, $6) returning id",
        [
          org.id,
          `c${i}`,
          cat.setupBufferMinutes,
          cat.teardownBufferMinutes,
          cat.includedDurationMinutes,
          cat.overnightAllowed,
        ],
      );
      const p = await makeProduct(org, { units: 1, categoryId: c.rows[0]!.id });
      await admin(
        "update public.products set setup_buffer_minutes = $2, teardown_buffer_minutes = $3, included_duration_minutes = $4, overnight_allowed = $5, min_booking_lead_time_minutes = $6 where id = $1",
        [
          p.productId,
          prod.setupBufferMinutes,
          prod.teardownBufferMinutes,
          prod.includedDurationMinutes,
          prod.overnightAllowed,
          prod.minBookingLeadTimeMinutes,
        ],
      );
      await admin(
        "update public.product_variants set setup_buffer_minutes = $2, teardown_buffer_minutes = $3 where id = $1",
        [p.variantId, variant.setupBufferMinutes, variant.teardownBufferMinutes],
      );

      const expected = resolveRentalConfig({
        organization: orgLevel,
        category: cat,
        product: prod,
        variant,
      });
      const sqlBuffers = await admin<{ setup: number; teardown: number; lead: number }>(
        "select setup_buffer_minutes as setup, teardown_buffer_minutes as teardown, lead_time_minutes as lead from app.variant_context($1)",
        [p.variantId],
      );
      expect(sqlBuffers.rows[0]).toEqual({
        setup: expected.setupBufferMinutes,
        teardown: expected.teardownBufferMinutes,
        lead: expected.minBookingLeadTimeMinutes,
      });

      const ctx = await rpc<{
        c: { variants: { includedDurationMinutes: number; overnightAllowed: boolean }[] };
      }>(org.users.office, "select public.pricing_context($1, $2) as c", [org.id, [p.variantId]]);
      expect(ctx[0]!.c.variants[0]).toMatchObject({
        includedDurationMinutes: expected.includedDurationMinutes,
        overnightAllowed: expected.overnightAllowed,
      });
    }
  });
});

describe("weather hazard resolution parity", () => {
  const HAZARDS: WeatherHazard[] = ["wind", "lightning", "temperature"];
  const randomRules = (): HazardRule[] =>
    HAZARDS.flatMap((hazard) => {
      if (rand(3) === 0) return [];
      const withThreshold = rand(2) === 0;
      const unit: ThresholdUnit = hazard === "temperature" ? "fahrenheit" : "mph";
      return [
        {
          hazard,
          sensitive: rand(3) !== 0,
          thresholdValue: withThreshold ? 5 + rand(40) : null,
          thresholdUnit: withThreshold ? unit : null,
        },
      ];
    });

  it("agrees on 40 random rule sets", async () => {
    for (let i = 0; i < 40; i++) {
      const hazardOrg = await createOrg(`hz${i}`);
      const c = await admin<{ id: string }>(
        "insert into public.categories (organization_id, name, slug) values ($1, 'C', 'c') returning id",
        [hazardOrg.id],
      );
      const p = await makeProduct(hazardOrg, { units: 1, categoryId: c.rows[0]!.id });
      const levels = {
        organization: randomRules(),
        category: randomRules(),
        product: randomRules(),
      };
      const insert = async (
        rules: HazardRule[],
        categoryId: string | null,
        productId: string | null,
      ) => {
        for (const r of rules) {
          await admin(
            "insert into public.weather_hazard_rules (organization_id, category_id, product_id, hazard, sensitive, threshold_value, threshold_unit) values ($1, $2, $3, $4, $5, $6, $7)",
            [
              hazardOrg.id,
              categoryId,
              productId,
              r.hazard,
              r.sensitive,
              r.thresholdValue,
              r.thresholdUnit,
            ],
          );
        }
      };
      await insert(levels.organization, null, null);
      await insert(levels.category, c.rows[0]!.id, null);
      await insert(levels.product, null, p.productId);

      const sql = await admin<{
        hazard: string;
        sensitive: boolean;
        threshold_value: string | null;
        threshold_unit: string | null;
      }>(
        "select hazard::text, sensitive, threshold_value, threshold_unit from app.product_hazard_rules($1) order by hazard::text",
        [p.productId],
      );
      const ts = resolveHazardRules(levels).map((r) => ({
        hazard: r.hazard,
        sensitive: r.sensitive,
        threshold: r.thresholdValue,
        unit: r.thresholdUnit,
      }));
      expect(
        sql.rows.map((r) => ({
          hazard: r.hazard,
          sensitive: r.sensitive,
          threshold: r.threshold_value === null ? null : Number(r.threshold_value),
          unit: r.threshold_unit,
        })),
      ).toEqual(ts);
    }
  });
});
