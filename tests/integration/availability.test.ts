import { beforeAll, describe, expect, it } from "vitest";
import {
  addUnits,
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
 * Availability engine scenarios (M3). Every write goes through public.reserve_inventory in its own
 * committed transaction, exactly like production. Default organization settings apply unless a
 * test overrides them: 60 min setup buffer, 60 min pickup buffer, 12 h lead time, 15 min holds.
 */
let org: TestOrg;
let other: TestOrg;

beforeAll(async () => {
  org = await createOrg("avail");
  other = await createOrg("avail-other");
});

const staff = () => org.users.office;

describe("race conditions", () => {
  it("two (ten) simultaneous requests for the last unit: exactly one wins", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        outcome(
          reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }]),
        ),
      ),
    );
    expect(attempts.filter((o) => o === "ok")).toHaveLength(1);
    expect(attempts.filter((o) => o === "RA001")).toHaveLength(9);
    const { rows } = await admin(
      "select count(*)::int n from public.reservation_allocations where variant_id = $1",
      [variantId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("pooled quantity 3 with four simultaneous requests: three win, one is rejected", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const attempts = await Promise.all(
      Array.from({ length: 4 }, () =>
        outcome(
          reserve(SYSTEM, org, [{ variantId, start: june(19, "10:00"), end: june(19, "14:00") }]),
        ),
      ),
    );
    expect(attempts.sort()).toEqual(["RA001", "ok", "ok", "ok"]);
    const { rows } = await admin(
      "select coalesce(sum(quantity), 0)::int n from public.reservation_allocations where variant_id = $1",
      [variantId],
    );
    expect(rows).toEqual([{ n: 3 }]);
  });

  it("concurrent multi-quantity pooled requests never oversell", async () => {
    const { variantId } = await makeProduct(org, { pooled: 100 });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        outcome(
          reserve(SYSTEM, org, [
            { variantId, quantity: 30, start: june(20, "10:00"), end: june(20, "14:00") },
          ]),
        ),
      ),
    );
    expect(attempts.filter((o) => o === "ok")).toHaveLength(3); // 3 × 30 = 90 ≤ 100 < 120
  });
});

describe("serialized units", () => {
  it("quantity 1: an overlapping booking is rejected (Sat 12–18 vs 15–20)", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    await reserve(staff(), org, [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }], {
      status: "confirmed",
    });
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "15:00"), end: june(19, "20:00") }]),
      ),
    ).toBe("RA001");
  });

  it("quantity 3: three overlapping bookings consume three distinct units, the fourth is rejected", async () => {
    const { variantId } = await makeProduct(org, { units: 3 });
    for (let i = 0; i < 3; i++) {
      await reserve(
        staff(),
        org,
        [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }],
        { status: "confirmed" },
      );
    }
    const units = await admin(
      "select count(distinct inventory_unit_id)::int n from public.reservation_allocations where variant_id = $1",
      [variantId],
    );
    expect(units.rows).toEqual([{ n: 3 }]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "13:00"), end: june(19, "14:00") }]),
      ),
    ).toBe("RA001");
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(21, "13:00"), end: june(21, "14:00") }]),
      ),
    ).toBe("ok");
  });

  it("one request for several units is all-or-nothing", async () => {
    const { variantId } = await makeProduct(org, { units: 2 });
    expect(
      await outcome(
        reserve(SYSTEM, org, [
          { variantId, quantity: 3, start: june(22, "12:00"), end: june(22, "14:00") },
        ]),
      ),
    ).toBe("RA001");
    const { rows } = await admin(
      "select count(*)::int n from public.reservation_allocations where variant_id = $1",
      [variantId],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("the database itself refuses a double allocation of one unit (exclusion constraint)", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(
      staff(),
      org,
      [{ variantId, start: june(23, "12:00"), end: june(23, "18:00") }],
      { status: "confirmed" },
    );
    const alloc = await admin<{ inventory_unit_id: string }>(
      "select inventory_unit_id from public.reservation_allocations where reservation_id = $1",
      [rid],
    );
    await expect(
      admin(
        `insert into public.reservation_allocations (organization_id, reservation_id, variant_id, inventory_unit_id, rental_period, occupied_period, status)
         values ($1, $2, $3, $4, tstzrange($5, $6), tstzrange($5, $6), 'confirmed')`,
        [
          org.id,
          rid,
          variantId,
          alloc.rows[0]!.inventory_unit_id,
          june(23, "13:00"),
          june(23, "14:00"),
        ],
      ),
    ).rejects.toMatchObject({ code: "23P01" });
  });
});

describe("variants", () => {
  it("variants of one product have independent availability", async () => {
    const { productId, variantId: pink } = await makeProduct(org, { units: 1 });
    const blueRow = await admin<{ id: string }>(
      "insert into public.product_variants (organization_id, product_id, name) values ($1, $2, 'Blue') returning id",
      [org.id, productId],
    );
    const blue = blueRow.rows[0]!.id;
    await addUnits(org, blue, 1);
    await reserve(
      staff(),
      org,
      [{ variantId: pink, start: june(19, "12:00"), end: june(19, "18:00") }],
      { status: "confirmed" },
    );
    expect(
      (await checkStaff(staff(), org, pink, june(19, "12:00"), june(19, "18:00"))).available,
    ).toBe(false);
    expect(
      (await checkStaff(staff(), org, blue, june(19, "12:00"), june(19, "18:00"))).available,
    ).toBe(true);
  });

  it("inactive variants are unavailable", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    await admin("update public.product_variants set is_active = false where id = $1", [variantId]);
    expect(
      await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "18:00")),
    ).toMatchObject({
      available: false,
      reasons: ["VARIANT_INACTIVE"],
    });
  });
});

describe("setup and teardown buffers", () => {
  it("back-to-back bookings conflict through the default 60/60 buffers", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    await reserve(staff(), org, [{ variantId, start: june(19, "10:00"), end: june(19, "14:00") }], {
      status: "confirmed",
    });
    // Next event starts 14:00: its setup (13:00) overlaps the previous pickup (until 15:00).
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "14:00"), end: june(19, "18:00") }]),
      ),
    ).toBe("RA001");
    // 16:00 start → setup from 15:00, exactly when the previous pickup window ends (half-open): OK.
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "16:00"), end: june(19, "20:00") }]),
      ),
    ).toBe("ok");
  });

  it("zero buffers allow true back-to-back bookings (half-open periods)", async () => {
    const { variantId } = await makeProduct(org, { units: 1, setupBuffer: 0, teardownBuffer: 0 });
    await reserve(staff(), org, [{ variantId, start: june(19, "10:00"), end: june(19, "14:00") }], {
      status: "confirmed",
    });
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "14:00"), end: june(19, "18:00") }]),
      ),
    ).toBe("ok");
  });

  it("a category buffer overrides the organization, a variant buffer overrides everything", async () => {
    const cat = await admin<{ id: string }>(
      "insert into public.categories (organization_id, name, slug, setup_buffer_minutes, teardown_buffer_minutes) values ($1, 'Big', 'big-buffers', 180, 0) returning id",
      [org.id],
    );
    const { variantId } = await makeProduct(org, { units: 1, categoryId: cat.rows[0]!.id });
    const check = await rpc<{ occupied_start: Date; occupied_end: Date }>(
      staff(),
      "select occupied_start, occupied_end from public.check_availability($1, $2, $3, $4)",
      [org.id, variantId, june(19, "12:00"), june(19, "16:00")],
    );
    expect(check[0]!.occupied_start.toISOString()).toBe(new Date(june(19, "09:00")).toISOString());
    expect(check[0]!.occupied_end.toISOString()).toBe(new Date(june(19, "16:00")).toISOString());

    await admin("update public.product_variants set setup_buffer_minutes = 30 where id = $1", [
      variantId,
    ]);
    const after = await rpc<{ occupied_start: Date }>(
      staff(),
      "select occupied_start from public.check_availability($1, $2, $3, $4)",
      [org.id, variantId, june(19, "12:00"), june(19, "16:00")],
    );
    expect(after[0]!.occupied_start.toISOString()).toBe(new Date(june(19, "11:30")).toISOString());
  });

  it("buffers are frozen into the allocation at booking time", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(
      staff(),
      org,
      [{ variantId, start: june(24, "12:00"), end: june(24, "16:00") }],
      { status: "confirmed" },
    );
    await admin(
      "update public.organization_settings set default_teardown_buffer_minutes = 240 where organization_id = $1",
      [org.id],
    );
    const { rows } = await admin<{ upper: Date }>(
      "select upper(occupied_period) from public.reservation_allocations where reservation_id = $1",
      [rid],
    );
    expect(rows[0]!.upper.toISOString()).toBe(new Date(june(24, "17:00")).toISOString());
    await admin(
      "update public.organization_settings set default_teardown_buffer_minutes = 60 where organization_id = $1",
      [org.id],
    );
  });
});

describe("multi-day and overnight", () => {
  it("a Friday-evening to Sunday-noon rental blocks a Saturday booking", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    await reserve(staff(), org, [{ variantId, start: june(18, "17:00"), end: june(20, "12:00") }], {
      status: "confirmed",
    });
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "16:00") }]),
      ),
    ).toBe("RA001");
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(20, "15:00"), end: june(20, "19:00") }]),
      ),
    ).toBe("ok");
  });

  it("an overnight rental across the DST change occupies the correct real duration", async () => {
    // America/Chicago falls back at 02:00 on 2026-11-01: 18:00 CDT → 10:00 CST is 17 real hours.
    const { variantId } = await makeProduct(org, { units: 1, setupBuffer: 0, teardownBuffer: 0 });
    const rid = await reserve(
      staff(),
      org,
      [{ variantId, start: "2026-10-31T18:00:00-05:00", end: "2026-11-01T10:00:00-06:00" }],
      {
        status: "confirmed",
      },
    );
    const { rows } = await admin<{ hours: number }>(
      "select extract(epoch from upper(rental_period) - lower(rental_period))::int / 3600 as hours from public.reservation_allocations where reservation_id = $1",
      [rid],
    );
    expect(rows).toEqual([{ hours: 17 }]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [
          { variantId, start: "2026-11-01T09:00:00-06:00", end: "2026-11-01T12:00:00-06:00" },
        ]),
      ),
    ).toBe("RA001");
  });

  it("rentals longer than the organization's maximum are rejected", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(staff(), org, [{ variantId, start: june(1, "10:00"), end: june(30, "10:00") }]),
      ),
    ).toBe("RA006");
  });
});

describe("pooled stock", () => {
  it("uses peak concurrent use, not the sum of overlapping bookings", async () => {
    const { variantId } = await makeProduct(org, {
      pooled: 100,
      setupBuffer: 0,
      teardownBuffer: 0,
    });
    await reserve(
      staff(),
      org,
      [{ variantId, quantity: 60, start: june(19, "10:00"), end: june(19, "14:00") }],
      { status: "confirmed" },
    );
    await reserve(
      staff(),
      org,
      [{ variantId, quantity: 60, start: june(19, "15:00"), end: june(19, "19:00") }],
      { status: "confirmed" },
    );
    // 12:00–16:00 overlaps both, but never more than 60 are out at once → 40 still available.
    expect(
      await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "16:00"), 40),
    ).toMatchObject({ available: true, available_quantity: 40 });
    expect(
      await outcome(
        reserve(SYSTEM, org, [
          { variantId, quantity: 41, start: june(19, "12:00"), end: june(19, "16:00") },
        ]),
      ),
    ).toBe("RA001");
    expect(
      await outcome(
        reserve(SYSTEM, org, [
          { variantId, quantity: 40, start: june(19, "12:00"), end: june(19, "16:00") },
        ]),
      ),
    ).toBe("ok");
  });

  it("partial quantity blocks reduce pooled capacity; partial blocks are refused on serialized variants", async () => {
    const { variantId } = await makeProduct(org, { pooled: 50 });
    await admin(
      "insert into public.availability_blocks (organization_id, variant_id, period, reason, quantity) values ($1, $2, tstzrange($3, $4), 'repair', 20)",
      [org.id, variantId, june(19, "00:00"), june(20, "00:00")],
    );
    expect(
      (await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "16:00")))
        .available_quantity,
    ).toBe(30);
    const serial = await makeProduct(org, { units: 3 });
    await expect(
      admin(
        "insert into public.availability_blocks (organization_id, variant_id, period, reason, quantity) values ($1, $2, tstzrange($3, $4), 'repair', 1)",
        [org.id, serial.variantId, june(19, "00:00"), june(20, "00:00")],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("holds (ADR 0002)", () => {
  it("a 15-minute hold blocks others while live; once expired it blocks nothing", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(19, "12:00"), end: june(19, "18:00") },
    ]);
    const { rows } = await admin<{ minutes: number }>(
      "select round(extract(epoch from hold_expires_at - created_at) / 60)::int as minutes from public.reservations where id = $1",
      [hold],
    );
    expect(rows).toEqual([{ minutes: 15 }]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }]),
      ),
    ).toBe("RA001");

    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
      [hold],
    );
    expect(
      (await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "18:00"))).available,
    ).toBe(true);
    const winner = await reserve(SYSTEM, org, [
      { variantId, start: june(19, "12:00"), end: june(19, "18:00") },
    ]);
    expect(winner).toBeTruthy();
    const states = await admin("select status from public.reservations where id = $1", [hold]);
    expect(states.rows).toEqual([{ status: "released" }]);
  });

  it("an expired hold cannot be confirmed or renewed", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(25, "12:00"), end: june(25, "18:00") },
    ]);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 second' where id = $1",
      [hold],
    );
    expect(await outcome(rpc(staff(), "select public.confirm_reservation($1)", [hold]))).toBe(
      "RA004",
    );
    expect(await outcome(rpc(SYSTEM, "select public.renew_hold($1)", [hold]))).toBe("RA004");
  });

  it("a live hold can be confirmed into a firm reservation", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(26, "12:00"), end: june(26, "18:00") },
    ]);
    await rpc(staff(), "select public.confirm_reservation($1)", [hold]);
    const { rows } = await admin(
      "select r.status, r.hold_expires_at, (select array_agg(distinct a.status::text) from public.reservation_allocations a where a.reservation_id = r.id) as alloc from public.reservations r where r.id = $1",
      [hold],
    );
    expect(rows).toEqual([{ status: "confirmed", hold_expires_at: null, alloc: ["confirmed"] }]);
  });

  it("renewing extends a live hold, up to the organization's renewal limit", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(27, "12:00"), end: june(27, "18:00") },
    ]);
    await admin(
      "update public.reservations set hold_expires_at = now() + interval '1 minute' where id = $1",
      [hold],
    );
    await rpc(SYSTEM, "select public.renew_hold($1)", [hold]);
    const { rows } = await admin<{ minutes: number }>(
      "select round(extract(epoch from hold_expires_at - now()) / 60)::int as minutes from public.reservations where id = $1",
      [hold],
    );
    expect(rows[0]!.minutes).toBe(15);
    await rpc(SYSTEM, "select public.renew_hold($1)", [hold]);
    await rpc(SYSTEM, "select public.renew_hold($1)", [hold]);
    expect(await outcome(rpc(SYSTEM, "select public.renew_hold($1)", [hold]))).toBe("RA007");
  });

  it("replacing a hold is atomic: the old hold is released only if the new one succeeds", async () => {
    const castle = await makeProduct(org, { units: 1 });
    const slide = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId: castle.variantId, start: june(28, "12:00"), end: june(28, "18:00") },
    ]);

    // Someone else holds the slide → replacing the castle hold with the slide must fail and keep the castle.
    await reserve(
      staff(),
      org,
      [{ variantId: slide.variantId, start: june(28, "12:00"), end: june(28, "18:00") }],
      { status: "confirmed" },
    );
    expect(
      await outcome(
        reserve(
          SYSTEM,
          org,
          [{ variantId: slide.variantId, start: june(28, "12:00"), end: june(28, "18:00") }],
          { replaces: hold },
        ),
      ),
    ).toBe("RA001");
    expect(
      (await admin("select status from public.reservations where id = $1", [hold])).rows,
    ).toEqual([{ status: "held" }]);

    // Changing the time of the same item can reuse the unit the old hold had.
    const replacement = await reserve(
      SYSTEM,
      org,
      [{ variantId: castle.variantId, start: june(28, "13:00"), end: june(28, "19:00") }],
      {
        replaces: hold,
      },
    );
    const { rows } = await admin(
      "select status, replaced_by from public.reservations where id = $1",
      [hold],
    );
    expect(rows).toEqual([{ status: "released", replaced_by: replacement }]);
  });

  it("releasing a hold frees the inventory immediately; only staff can cancel confirmed bookings", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(29, "12:00"), end: june(29, "18:00") },
    ]);
    expect(await rpc(SYSTEM, "select public.release_reservation($1) as s", [hold])).toEqual([
      { s: "released" },
    ]);
    const booking = await reserve(
      staff(),
      org,
      [{ variantId, start: june(29, "12:00"), end: june(29, "18:00") }],
      { status: "confirmed" },
    );
    expect(await outcome(rpc(SYSTEM, "select public.release_reservation($1)", [booking]))).toBe(
      "RA006",
    );
    expect(await rpc(staff(), "select public.release_reservation($1) as s", [booking])).toEqual([
      { s: "cancelled" },
    ]);
  });

  it("the system context may only create temporary holds", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }], {
          status: "confirmed",
        }),
      ),
    ).toBe("RA006");
  });

  it("the sweeper marks expired holds released (housekeeping only)", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(30, "12:00"), end: june(30, "18:00") },
    ]);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 minute' where id = $1",
      [hold],
    );
    const [swept] = await rpc<{ n: number }>(
      SYSTEM,
      "select public.sweep_expired_holds() as n",
      [],
    );
    expect(swept!.n).toBeGreaterThanOrEqual(1);
    expect(
      (await admin("select status from public.reservations where id = $1", [hold])).rows,
    ).toEqual([{ status: "released" }]);
  });
});

describe("blocks", () => {
  it("a staff block overlapping an existing reservation flags it (never cancels) and blocks new bookings", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 2 });
    const booking = await reserve(
      staff(),
      org,
      [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }],
      { status: "confirmed" },
    );
    await as(
      staff(),
      (sql) =>
        sql(
          "insert into public.availability_blocks (organization_id, product_id, period, reason, notes) values ($1, $2, tstzrange($3, $4), 'staff_hold', 'Private event')",
          [org.id, productId, june(19, "00:00"), june(20, "00:00")],
        ),
      { commit: true },
    );
    const flags = await admin(
      "select kind, status from public.reservation_flags where reservation_id = $1",
      [booking],
    );
    expect(flags.rows).toEqual([{ kind: "availability_block", status: "open" }]);
    expect(
      (await admin("select status from public.reservations where id = $1", [booking])).rows,
    ).toEqual([{ status: "confirmed" }]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "13:00") }]),
      ),
    ).toBe("RA002");
    expect(
      (await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "13:00"))).reasons,
    ).toContain("PRODUCT_BLOCKED");
  });

  it("a maintenance block on one unit removes only that unit", async () => {
    const { variantId } = await makeProduct(org, { units: 2 });
    const units = await admin<{ id: string }>(
      "select id from public.inventory_units where variant_id = $1 order by label",
      [variantId],
    );
    await admin(
      "insert into public.availability_blocks (organization_id, inventory_unit_id, period, reason) values ($1, $2, tstzrange($3, $4), 'maintenance')",
      [org.id, units.rows[0]!.id, june(19, "00:00"), june(21, "00:00")],
    );
    expect(
      await checkStaff(staff(), org, variantId, june(19, "12:00"), june(19, "18:00")),
    ).toMatchObject({ available_quantity: 1, capacity: 2 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, start: june(19, "12:00"), end: june(19, "18:00") },
    ]);
    const alloc = await admin(
      "select inventory_unit_id from public.reservation_allocations where reservation_id = $1",
      [rid],
    );
    expect(alloc.rows).toEqual([{ inventory_unit_id: units.rows[1]!.id }]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(19, "12:00"), end: june(19, "18:00") }]),
      ),
    ).toBe("RA001");
  });

  it("an organization blackout blocks every product", async () => {
    const blackoutOrg = await createOrg("blackout");
    const { variantId } = await makeProduct(blackoutOrg, { pooled: 10 });
    await admin(
      "insert into public.availability_blocks (organization_id, period, reason) values ($1, tstzrange($2, $3), 'blackout')",
      [blackoutOrg.id, june(4, "00:00"), june(5, "00:00")],
    );
    expect(
      (
        await checkStaff(
          blackoutOrg.users.office,
          blackoutOrg,
          variantId,
          june(4, "12:00"),
          june(4, "14:00"),
        )
      ).reasons,
    ).toContain("BLACKOUT");
    expect(
      (await checkPublic(blackoutOrg, variantId, june(4, "12:00"), june(4, "14:00"))).reasons,
    ).toEqual(["BLACKOUT"]);
  });

  it("released and cancelled reservations do not block", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const booking = await reserve(
      staff(),
      org,
      [{ variantId, start: june(15, "12:00"), end: june(15, "18:00") }],
      { status: "confirmed" },
    );
    await rpc(staff(), "select public.release_reservation($1)", [booking]);
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(15, "12:00"), end: june(15, "18:00") }]),
      ),
    ).toBe("ok");
  });
});

describe("lead time", () => {
  const soon = (hours: number) => new Date(Date.now() + hours * 3600_000).toISOString();

  it("public requests inside the 12-hour lead time are rejected", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(await outcome(reserve(SYSTEM, org, [{ variantId, start: soon(3), end: soon(7) }]))).toBe(
      "RA003",
    );
    expect((await checkPublic(org, variantId, soon(3), soon(7))).reasons).toEqual([
      "OUTSIDE_LEAD_TIME",
    ]);
  });

  it("staff can explicitly override the lead time (same-day booking); the system context cannot", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(staff(), org, [{ variantId, start: soon(3), end: soon(7) }], {
          overrideLeadTime: true,
        }),
      ),
    ).toBe("ok");
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: soon(30), end: soon(34) }], {
          overrideLeadTime: true,
        }),
      ),
    ).toBe("RA006");
  });

  it("a product-level lead time overrides the organization default", async () => {
    const { variantId } = await makeProduct(org, { units: 1, leadTimeMinutes: 60 });
    expect(await outcome(reserve(SYSTEM, org, [{ variantId, start: soon(3), end: soon(7) }]))).toBe(
      "ok",
    );
  });
});

describe("public availability (storefront / assistant)", () => {
  it("never exposes exact quantities, only available + limited", async () => {
    const { variantId } = await makeProduct(org, { units: 3 });
    const result = await checkPublic(org, variantId, june(10, "12:00"), june(10, "16:00"));
    expect(result).toEqual({ available: true, limited: false, reasons: [] });
    await reserve(
      staff(),
      org,
      [{ variantId, quantity: 2, start: june(10, "12:00"), end: june(10, "16:00") }],
      { status: "confirmed" },
    );
    expect(await checkPublic(org, variantId, june(10, "12:00"), june(10, "16:00"))).toEqual({
      available: true,
      limited: true,
      reasons: [],
    });
  });

  it("unpublished products are not found publicly", async () => {
    const { variantId } = await makeProduct(org, { units: 1, published: false });
    expect(await outcome(checkPublic(org, variantId, june(10, "12:00"), june(10, "16:00")))).toBe(
      "RA005",
    );
    expect(
      await outcome(
        reserve(SYSTEM, org, [{ variantId, start: june(10, "12:00"), end: june(10, "16:00") }]),
      ),
    ).toBe("RA005");
  });
});

describe("tenant isolation during availability", () => {
  it("another organization's staff cannot check, reserve, confirm or release", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const hold = await reserve(SYSTEM, org, [
      { variantId, start: june(11, "12:00"), end: june(11, "16:00") },
    ]);
    const intruder = other.users.owner;
    expect(
      await outcome(checkStaff(intruder, org, variantId, june(11, "12:00"), june(11, "16:00"))),
    ).toBe("RA005");
    expect(
      await outcome(checkStaff(intruder, other, variantId, june(11, "12:00"), june(11, "16:00"))),
    ).toBe("RA005");
    expect(
      await outcome(
        reserve(intruder, other, [{ variantId, start: june(12, "12:00"), end: june(12, "16:00") }]),
      ),
    ).toBe("RA005");
    expect(await outcome(rpc(intruder, "select public.confirm_reservation($1)", [hold]))).toBe(
      "RA005",
    );
    expect(await outcome(rpc(intruder, "select public.release_reservation($1)", [hold]))).toBe(
      "RA005",
    );
    expect(
      (await admin("select status from public.reservations where id = $1", [hold])).rows,
    ).toEqual([{ status: "held" }]);
  });

  it("the system context cannot reserve one tenant's variant under another tenant id", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(SYSTEM, other, [{ variantId, start: june(12, "12:00"), end: june(12, "16:00") }]),
      ),
    ).toBe("RA005");
    expect(
      await outcome(
        reserve(SYSTEM, other, [
          { variantId: "not-a-uuid", start: june(12, "12:00"), end: june(12, "16:00") },
        ]),
      ),
    ).toBe("RA005");
  });

  it("anonymous visitors cannot reserve or run staff checks", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve({ kind: "anon" }, org, [
          { variantId, start: june(12, "12:00"), end: june(12, "16:00") },
        ]),
      ),
    ).toBe("42501");
    expect(
      await outcome(
        checkStaff({ kind: "anon" }, org, variantId, june(12, "12:00"), june(12, "16:00")),
      ),
    ).toBe("42501");
  });

  it("staff without availability.write cannot reserve; reservations are not directly writable", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(org.users.staff, org, [
          { variantId, start: june(12, "12:00"), end: june(12, "16:00") },
        ]),
      ),
    ).toBe("RA005");
    expect(
      await outcome(
        as(org.users.owner, (sql) =>
          sql(
            "insert into public.reservations (organization_id, source, status) values ($1, 'manual', 'confirmed')",
            [org.id],
          ),
        ),
      ),
    ).toBe("42501");
  });

  it("reservations and flags are invisible to other organizations", async () => {
    const n = await as(
      other.users.owner,
      async (sql) =>
        (
          await sql(
            "select (select count(*)::int from public.reservations where organization_id = $1) + (select count(*)::int from public.reservation_flags where organization_id = $1) as n",
            [org.id],
          )
        ).rows[0],
    );
    expect(n).toEqual({ n: 0 });
  });
});

describe("input validation", () => {
  it.each([
    [[{ start: june(19, "12:00"), end: june(19, "12:00") }], "RA006"],
    [[{ start: june(19, "14:00"), end: june(19, "12:00") }], "RA006"],
    [[{ start: "yesterday-ish", end: june(19, "12:00") }], "RA006"],
    [[], "RA006"],
  ])("rejects %j", async (periods, code) => {
    const { variantId } = await makeProduct(org, { units: 1 });
    expect(
      await outcome(
        reserve(
          staff(),
          org,
          periods.map((p) => ({ variantId, ...p })),
        ),
      ),
    ).toBe(code);
  });

  it("rejects zero or negative quantities", async () => {
    const { variantId } = await makeProduct(org, { pooled: 5 });
    expect(
      await outcome(
        reserve(staff(), org, [
          { variantId, quantity: 0, start: june(19, "12:00"), end: june(19, "14:00") },
        ]),
      ),
    ).toBe("RA006");
  });
});
