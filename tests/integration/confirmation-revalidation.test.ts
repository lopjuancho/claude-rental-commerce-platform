import { beforeAll, describe, expect, it } from "vitest";
import { june, makeProduct, outcome, reserve, rpc, SYSTEM } from "./support/availability";
import { admin, createOrg, type TestOrg } from "./support/db";
import { flagsFor, openTx, settle, waitUntilBlocked } from "./support/tx";

/**
 * Codex re-review blocker 1: confirming a hold must re-validate availability under the lock
 * protocol. A block, retirement or other capacity loss between hold and confirmation must make
 * the confirmation fail — the hold is never converted into a confirmed reservation on stock that
 * is no longer there. Existing CONFIRMED bookings are never cancelled; they are flagged.
 */
let org: TestOrg;
const W = { start: june(26, "12:00"), end: june(26, "16:00") };
const COVER = { start: june(26, "08:00"), end: june(26, "20:00") };

beforeAll(async () => {
  org = await createOrg("confirm");
  await admin(
    "update public.organization_settings set min_booking_lead_time_minutes = 0 where organization_id = $1",
    [org.id],
  );
});

const confirm = (rid: string) =>
  outcome(rpc(org.users.office, "select public.confirm_reservation($1)", [rid]));
const status = async (rid: string) =>
  (
    await admin<{ status: string }>("select status::text from public.reservations where id = $1", [
      rid,
    ])
  ).rows[0]!.status;
const heldUnit = async (rid: string) =>
  (
    await admin<{ u: string }>(
      "select inventory_unit_id as u from public.reservation_allocations where reservation_id = $1",
      [rid],
    )
  ).rows[0]!.u;
const block = (cols: string, vals: unknown[], reason = "maintenance") =>
  admin(
    `insert into public.availability_blocks (organization_id, ${cols}, period, reason) values ($1, ${vals
      .map((_, i) => `$${i + 2}`)
      .join(", ")}, tstzrange($${vals.length + 2}, $${vals.length + 3}), '${reason}')`,
    [org.id, ...vals, COVER.start, COVER.end],
  );

describe("hold → capacity loss → confirmation is refused", () => {
  it("maintenance block on the product", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    await block("product_id", [productId]);
    expect(await flagsFor(rid)).toEqual(["availability_block"]); // staff are told
    expect(await confirm(rid)).toBe("RA002");
    expect(await status(rid)).toBe("held");
  });

  it("the held physical unit goes to repair (unit block), even though another unit is free", async () => {
    const { variantId } = await makeProduct(org, { units: 2 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    await block("inventory_unit_id", [await heldUnit(rid)], "repair");
    expect(await confirm(rid)).toBe("RA002");
    expect(await status(rid)).toBe("held");
  });

  it("retiring the held unit is refused outright while the hold is live", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    expect(
      await outcome(
        admin("update public.inventory_units set status = 'retired' where id = $1", [
          await heldUnit(rid),
        ]),
      ),
    ).toBe("RA011");
    expect(await confirm(rid)).toBe("ok");
  });

  it("staff block (variant-wide) and organization blackout", async () => {
    const a = await makeProduct(org, { units: 1 });
    const ra = await reserve(SYSTEM, org, [{ variantId: a.variantId, ...W }]);
    await block("variant_id", [a.variantId], "staff_hold");
    expect(await confirm(ra)).toBe("RA002");

    const blackoutOrg = await createOrg("confirm-blackout");
    await admin(
      "update public.organization_settings set min_booking_lead_time_minutes = 0 where organization_id = $1",
      [blackoutOrg.id],
    );
    const b = await makeProduct(blackoutOrg, { units: 1 });
    const rb = await reserve(SYSTEM, blackoutOrg, [{ variantId: b.variantId, ...W }]);
    await admin(
      "insert into public.availability_blocks (organization_id, period, reason) values ($1, tstzrange($2, $3), 'blackout')",
      [blackoutOrg.id, COVER.start, COVER.end],
    );
    expect(
      await outcome(rpc(blackoutOrg.users.office, "select public.confirm_reservation($1)", [rb])),
    ).toBe("RA002");
  });

  it("pooled: a partial staff/repair block leaves too few units for the held quantity", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    await admin(
      "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason) values ($1, $2, 2, tstzrange($3, $4), 'repair')",
      [org.id, variantId, COVER.start, COVER.end],
    );
    expect(await confirm(rid)).toBe("RA001");
  });

  it("pooled: reducing the quantity below a live hold is refused, so the hold stays confirmable", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    expect(
      await outcome(
        admin("update public.product_variants set pooled_quantity = 1 where id = $1", [variantId]),
      ),
    ).toBe("RA011");
    expect(await confirm(rid)).toBe("ok");
  });

  it("the product was archived / the variant deactivated after the hold", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    await admin("update public.products set archived_at = now() where id = $1", [productId]);
    expect(await confirm(rid)).toBe("RA002");
  });

  it("with capacity intact the hold still confirms (the check does not count the hold against itself)", async () => {
    const pooled = await makeProduct(org, { pooled: 2 });
    const r1 = await reserve(SYSTEM, org, [{ variantId: pooled.variantId, quantity: 2, ...W }]);
    expect(await confirm(r1)).toBe("ok");
    const serial = await makeProduct(org, { units: 1 });
    const r2 = await reserve(SYSTEM, org, [{ variantId: serial.variantId, ...W }]);
    expect(await confirm(r2)).toBe("ok");
  });

  it("existing CONFIRMED bookings are flagged by a new block, never cancelled", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    expect(await confirm(rid)).toBe("ok");
    await block("product_id", [productId]);
    expect(await status(rid)).toBe("confirmed");
    expect(await flagsFor(rid)).toEqual(["availability_block"]);
  });
});

describe("concurrent confirmation vs block", () => {
  it("block first (uncommitted): confirmation waits, then re-validates and is refused", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    const b = await openTx(org.users.office);
    await b.q(
      "insert into public.availability_blocks (organization_id, product_id, period, reason, created_by) values ($1, $2, tstzrange($3, $4), 'maintenance', $5)",
      [org.id, productId, COVER.start, COVER.end, org.users.office.id],
    );
    const a = await openTx(org.users.office);
    const confirming = settle(a.q("select public.confirm_reservation($1)", [rid]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await confirming).toBe("RA002");
    await a.rollback();
    expect(await status(rid)).toBe("held");
  });

  it("confirmation first (uncommitted): the block waits, then flags the confirmed booking", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_reservation($1)", [rid]);
    const b = await openTx(org.users.office);
    const blocking = settle(
      b.q(
        "insert into public.availability_blocks (organization_id, product_id, period, reason, created_by) values ($1, $2, tstzrange($3, $4), 'maintenance', $5)",
        [org.id, productId, COVER.start, COVER.end, org.users.office.id],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await blocking).toBe("ok");
    await b.commit();
    expect(await status(rid)).toBe("confirmed");
    expect(await flagsFor(rid)).toEqual(["availability_block"]);
  });

  it("unit repair block vs confirmation of the hold on that unit", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, ...W }]);
    const unit = await heldUnit(rid);
    const b = await openTx(org.users.office);
    await b.q(
      "insert into public.availability_blocks (organization_id, inventory_unit_id, period, reason, created_by) values ($1, $2, tstzrange($3, $4), 'repair', $5)",
      [org.id, unit, COVER.start, COVER.end, org.users.office.id],
    );
    const a = await openTx(org.users.office);
    const confirming = settle(a.q("select public.confirm_reservation($1)", [rid]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await confirming).toBe("RA002");
    await a.rollback();
  });
});

describe("Codex B1 follow-up: several lines of the SAME pooled hold are counted together", () => {
  // Default buffers (60 min setup / 60 min pickup) are fixed on each allocation at hold time:
  // A 12:00–16:00 occupies 11:00–17:00, B 14:00–18:00 occupies 13:00–19:00 (overlap 13:00–17:00).
  const A = { start: june(26, "12:00"), end: june(26, "16:00") };
  const B = { start: june(26, "14:00"), end: june(26, "18:00") };
  const NEXT_DAY = { start: june(27, "12:00"), end: june(27, "16:00") };
  const partial = (variantId: string, quantity: number, from = "08:00", to = "20:00", day = 26) =>
    admin(
      "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason) values ($1, $2, $3, tstzrange($4, $5), 'repair')",
      [org.id, variantId, quantity, june(day, from), june(day, to)],
    );

  it("two overlapping lines + a later partial block exceed capacity → confirmation refused", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...B },
    ]); // 2 + 2 = 4 simultaneous: fits exactly at hold time
    await partial(variantId, 1); // now 2 + 2 + 1 = 5 > 4 during the overlap
    expect(await confirm(rid)).toBe("RA001");
    expect(await status(rid)).toBe("held");
  });

  it("two overlapping lines exactly at capacity still confirm", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...B },
    ]);
    expect(await confirm(rid)).toBe("ok");
  });

  it("non-overlapping lines are not added together (each day fits beside its block)", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...NEXT_DAY },
    ]);
    await partial(variantId, 1); // day 26 only: 2 + 1 = 3
    expect(await confirm(rid)).toBe("ok");
  });

  it("the same variant repeated across three lines", async () => {
    const ok = await makeProduct(org, { pooled: 3 });
    const r1 = await reserve(SYSTEM, org, [
      { variantId: ok.variantId, quantity: 1, ...A },
      { variantId: ok.variantId, quantity: 1, ...A },
      { variantId: ok.variantId, quantity: 1, ...B },
    ]);
    expect(await confirm(r1)).toBe("ok");

    const over = await makeProduct(org, { pooled: 3 });
    const r2 = await reserve(SYSTEM, org, [
      { variantId: over.variantId, quantity: 1, ...A },
      { variantId: over.variantId, quantity: 1, ...A },
      { variantId: over.variantId, quantity: 1, ...B },
    ]);
    await partial(over.variantId, 1);
    expect(await confirm(r2)).toBe("RA001");
  });

  it("the same pooled variant plus other (external) reservations", async () => {
    const { variantId } = await makeProduct(org, { pooled: 5 });
    const external = await reserve(SYSTEM, org, [{ variantId, quantity: 1, ...A }]);
    expect(await confirm(external)).toBe("ok");
    const otherHold = await reserve(SYSTEM, org, [{ variantId, quantity: 1, ...B }]);
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 1, ...A },
      { variantId, quantity: 2, ...B },
    ]); // 1 + 1 + 1 + 2 = 5 during the overlap
    expect(await confirm(rid)).toBe("ok");

    const v2 = await makeProduct(org, { pooled: 5 });
    await reserve(SYSTEM, org, [{ variantId: v2.variantId, quantity: 1, ...A }]);
    const rid2 = await reserve(SYSTEM, org, [
      { variantId: v2.variantId, quantity: 2, ...A },
      { variantId: v2.variantId, quantity: 2, ...B },
    ]); // 1 + 2 + 2 = 5
    await partial(v2.variantId, 1); // 6 > 5
    expect(await confirm(rid2)).toBe("RA001");
    expect(otherHold).toBeTruthy();
  });

  it("expired holds of other customers are not counted", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const stale = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...A }]);
    await admin(
      "update public.reservations set hold_expires_at = now() - interval '1 minute' where id = $1",
      [stale],
    );
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...B },
    ]);
    expect(await confirm(rid)).toBe("ok");
  });

  it("a partial block that does not coincide with the overlap still lets the hold confirm", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...B },
    ]);
    // 18:30–20:00: only B (occupied until 19:00) is active then → 2 + 1 = 3 ≤ 4.
    await partial(variantId, 1, "18:30", "20:00");
    expect(await confirm(rid)).toBe("ok");
  });

  it("concurrent: confirming a two-line hold while another hold for the same stock is attempted", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const rid = await reserve(SYSTEM, org, [
      { variantId, quantity: 2, ...A },
      { variantId, quantity: 2, ...B },
    ]);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_reservation($1)", [rid]);
    const b = await openTx(SYSTEM);
    const second = settle(
      b.q("select public.reserve_inventory($1, $2::jsonb)", [
        org.id,
        JSON.stringify([{ variant_id: variantId, quantity: 1, start: A.start, end: A.end }]),
      ]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await second).toBe("RA001");
    await b.rollback();
    expect(await status(rid)).toBe("confirmed");
  });
});
