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
