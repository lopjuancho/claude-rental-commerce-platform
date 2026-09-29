import { beforeAll, describe, expect, it } from "vitest";
import {
  checkPublic,
  checkStaff,
  june,
  makeProduct,
  outcome,
  reserve,
  rpc,
  SYSTEM,
} from "./support/availability";
import { admin, as, createOrg, type TestOrg } from "./support/db";

/**
 * Weather blocks (ADR 0010): per-hazard, staff-confirmed, flag-don't-cancel.
 * Category rules mirror the Tiky Jumps configuration shape (as test data, not tenant data):
 * inflatables wind 15 mph + lightning, trains explicitly not wind sensitive, tents unset.
 */
let org: TestOrg;
let inflatable: { productId: string; variantId: string };
let manufacturerRated: { productId: string; variantId: string };
let train: { productId: string; variantId: string };
let tent: { productId: string; variantId: string };
let tentCategory: string;

const day = 7; // June 7, 2027
const slot = { start: june(day, "12:00"), end: june(day, "16:00") };

async function category(name: string): Promise<string> {
  const { rows } = await admin<{ id: string }>(
    "insert into public.categories (organization_id, name, slug) values ($1, $2, $3) returning id",
    [org.id, name, name.toLowerCase()],
  );
  return rows[0]!.id;
}

async function proposeBlock(
  hazard: string,
  fields: { scope?: string; observed?: number; unit?: string; start?: string; end?: string } = {},
) {
  return as(
    org.users.office,
    async (sql) =>
      (
        await sql<{ id: string }>(
          `insert into public.weather_blocks (organization_id, hazard, period, scope, reason, observed_value, observed_unit)
           values ($1, $2, tstzrange($3, $4), $5, 'Forecast', $6, $7) returning id`,
          [
            org.id,
            hazard,
            fields.start ?? june(day, "00:00"),
            fields.end ?? june(day + 1, "00:00"),
            fields.scope ?? "all_sensitive",
            fields.observed ?? null,
            fields.unit ?? null,
          ],
        )
      ).rows[0]!.id,
    { commit: true },
  );
}

const confirm = (id: string) =>
  rpc<{ n: number }>(org.users.office, "select public.confirm_weather_block($1) as n", [id]);
const lift = (id: string) => rpc(org.users.office, "select public.lift_weather_block($1)", [id]);
const isAvailable = async (v: { variantId: string }) =>
  (await checkStaff(org.users.office, org, v.variantId, slot.start, slot.end)).available;

beforeAll(async () => {
  org = await createOrg("weather");
  const inflatables = await category("Inflatables");
  const trains = await category("Trains");
  tentCategory = await category("Tents");
  await admin(
    `insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit) values
       ($1, $2, 'wind', true, 15, 'mph'), ($1, $2, 'lightning', true, null, null), ($1, $3, 'wind', false, null, null)`,
    [org.id, inflatables, trains],
  );
  inflatable = await makeProduct(org, { units: 2, categoryId: inflatables });
  manufacturerRated = await makeProduct(org, { units: 1, categoryId: inflatables });
  await admin(
    "insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive, threshold_value, threshold_unit) values ($1, $2, 'wind', true, 25, 'mph')",
    [org.id, manufacturerRated.productId],
  );
  train = await makeProduct(org, { units: 1, categoryId: trains });
  tent = await makeProduct(org, { units: 1, categoryId: tentCategory });
});

describe("weather blocks", () => {
  it("a proposed block (e.g. from a weather feed) warns only; availability is unchanged", async () => {
    const id = await proposeBlock("wind");
    expect(await isAvailable(inflatable)).toBe(true);
    await admin("delete from public.weather_blocks where id = $1", [id]);
  });

  it("a confirmed wind block affects wind-sensitive inflatables only (not trains, not tents without a rule)", async () => {
    const id = await proposeBlock("wind");
    await confirm(id);
    expect(
      await checkStaff(org.users.office, org, inflatable.variantId, slot.start, slot.end),
    ).toMatchObject({ available: false, reasons: ["WEATHER_BLOCK"] });
    expect(
      await outcome(reserve(SYSTEM, org, [{ variantId: inflatable.variantId, ...slot }])),
    ).toBe("RA002");
    expect(await isAvailable(train)).toBe(true);
    expect(await isAvailable(tent)).toBe(true);
    expect((await checkPublic(org, inflatable.variantId, slot.start, slot.end)).reasons).toEqual([
      "WEATHER_BLOCK",
    ]);
    await lift(id);
    expect(await isAvailable(inflatable)).toBe(true);
  });

  it("observed values are compared with each product's limit (category 15 mph vs manufacturer 25 mph)", async () => {
    const calm = await proposeBlock("wind", { observed: 12, unit: "mph" });
    await confirm(calm);
    expect(await isAvailable(inflatable)).toBe(true);
    await lift(calm);

    const gusty = await proposeBlock("wind", { observed: 18, unit: "mph" });
    await confirm(gusty);
    expect(await isAvailable(inflatable)).toBe(false);
    expect(await isAvailable(manufacturerRated)).toBe(true);
    await lift(gusty);
  });

  it("different hazards are independent (lightning affects inflatables, not trains)", async () => {
    const id = await proposeBlock("lightning");
    await confirm(id);
    expect(await isAvailable(inflatable)).toBe(false);
    expect(await isAvailable(train)).toBe(true);
    await lift(id);
  });

  it("a selected-scope manual safety block applies to exactly the chosen category", async () => {
    const id = await proposeBlock("custom", { scope: "selected" });
    await as(
      org.users.office,
      (sql) =>
        sql(
          "insert into public.weather_block_targets (organization_id, weather_block_id, category_id) values ($1, $2, $3)",
          [org.id, id, tentCategory],
        ),
      { commit: true },
    );
    await confirm(id);
    expect(await isAvailable(tent)).toBe(false);
    expect(await isAvailable(inflatable)).toBe(true);
    await lift(id);
  });

  it("confirming flags overlapping bookings for staff review and never cancels them", async () => {
    const booking = await reserve(
      org.users.office,
      org,
      [{ variantId: inflatable.variantId, ...slot }],
      { status: "confirmed" },
    );
    const trainBooking = await reserve(
      org.users.office,
      org,
      [{ variantId: train.variantId, ...slot }],
      { status: "confirmed" },
    );
    const id = await proposeBlock("wind");
    const [result] = await confirm(id);
    expect(result!.n).toBe(1);
    const flags = await admin(
      "select reservation_id, kind, status from public.reservation_flags where weather_block_id = $1",
      [id],
    );
    expect(flags.rows).toEqual([
      { reservation_id: booking, kind: "weather_block", status: "open" },
    ]);
    const statuses = await admin(
      "select id, status from public.reservations where id = any($1) order by id",
      [[booking, trainBooking]],
    );
    expect(statuses.rows.every((r) => (r as { status: string }).status === "confirmed")).toBe(true);
    await lift(id);
    await rpc(org.users.office, "select public.release_reservation($1)", [booking]);
    await rpc(org.users.office, "select public.release_reservation($1)", [trainBooking]);
  });

  it("a hold cannot be confirmed into a booking during a confirmed block unless staff explicitly override", async () => {
    const hold = await reserve(SYSTEM, org, [{ variantId: inflatable.variantId, ...slot }]);
    const id = await proposeBlock("wind");
    await confirm(id);
    // The server's system context can never confirm a hold (workflow-boundary review, finding 2).
    expect(await outcome(rpc(SYSTEM, "select public.confirm_reservation($1)", [hold]))).toBe(
      "42501",
    );
    expect(await outcome(rpc(SYSTEM, "select public.confirm_reservation($1, true)", [hold]))).toBe(
      "42501",
    );
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_reservation($1, true)", [hold])),
    ).toBe("ok");
    await lift(id);
  });

  it("only staff with availability.write, in the same organization, can confirm or lift", async () => {
    const id = await proposeBlock("rain");
    const other = await createOrg("weather-other");
    expect(await outcome(rpc(SYSTEM, "select public.confirm_weather_block($1)", [id]))).toBe(
      "RA005",
    );
    expect(
      await outcome(rpc(org.users.staff, "select public.confirm_weather_block($1)", [id])),
    ).toBe("RA005");
    expect(
      await outcome(rpc(other.users.owner, "select public.confirm_weather_block($1)", [id])),
    ).toBe("RA005");
    expect(
      await outcome(rpc(other.users.owner, "select public.lift_weather_block($1)", [id])),
    ).toBe("RA005");
    expect(
      (await admin("select status from public.weather_blocks where id = $1", [id])).rows,
    ).toEqual([{ status: "proposed" }]);
  });

  it("confirmed blocks cannot be edited or deleted directly (history is kept)", async () => {
    const id = await proposeBlock("severe_weather");
    await confirm(id);
    const n = await as(org.users.owner, async (sql) => ({
      updated: (
        await sql("update public.weather_blocks set reason = 'changed' where id = $1", [id])
      ).rowCount,
      deleted: (await sql("delete from public.weather_blocks where id = $1", [id])).rowCount,
    }));
    expect(n).toEqual({ updated: 0, deleted: 0 });
    await expect(
      as(org.users.owner, (sql) =>
        sql("update public.weather_blocks set status = 'lifted' where id = $1", [id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await lift(id);
  });
});
