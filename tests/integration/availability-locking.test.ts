import { beforeAll, describe, expect, it } from "vitest";
import { june, makeProduct, outcome, reserve, rpc, SYSTEM } from "./support/availability";
import { admin, adminGated, createOrg, type TestOrg } from "./support/db";
import { flagsFor, openTx, settle, waitUntilBlocked } from "./support/tx";

/**
 * Hardening H1: every operation that can reduce availability takes part in the same lock
 * protocol as reserve_inventory, so no interleaving can leave an oversold or unflagged state.
 *
 * Each race is made deterministic: transaction A runs its critical statement and stays open;
 * transaction B's competing statement must then be WAITING on a lock (checked in
 * pg_stat_activity). Without the protocol, B would not wait and would commit an invalid state.
 * A final randomized stress run checks the invariants over many concurrent mixed operations.
 */
let org: TestOrg;
const W = { start: june(26, "12:00"), end: june(26, "16:00") };

beforeAll(async () => {
  org = await createOrg("locking");
  // No lead time or buffers noise: the races are about capacity.
  await admin(
    "update public.organization_settings set min_booking_lead_time_minutes = 0 where organization_id = $1",
    [org.id],
  );
});

const holdSql = "select public.reserve_inventory($1, $2::jsonb) as id";
const items = (variantId: string, quantity = 1, w = W) =>
  JSON.stringify([{ variant_id: variantId, quantity, start: w.start, end: w.end }]);

async function peakAndQuantity(variantId: string) {
  const r = await admin<{ peak: number; qty: number }>(
    "select app.future_peak_usage($1) as peak, pooled_quantity as qty from public.product_variants where id = $1",
    [variantId],
  );
  return r.rows[0]!;
}

describe("hold creation vs pooled quantity reduction", () => {
  it("hold first: the reduction waits, then is refused (CAPACITY_IN_USE)", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const a = await openTx(SYSTEM);
    await a.q(holdSql, [org.id, items(variantId, 3)]);
    const b = await openTx(org.users.office);
    const reduce = settle(
      b.q("update public.product_variants set pooled_quantity = 2 where id = $1", [variantId]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await reduce).toBe("RA011");
    await b.rollback();
    expect(await peakAndQuantity(variantId)).toEqual({ peak: 3, qty: 3 });
  });

  it("reduction first: the hold waits, then sees the new quantity (INSUFFICIENT_AVAILABILITY)", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const b = await openTx(org.users.office);
    await b.q("update public.product_variants set pooled_quantity = 2 where id = $1", [variantId]);
    const a = await openTx(SYSTEM);
    const hold = settle(a.q(holdSql, [org.id, items(variantId, 3)]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await hold).toBe("RA001");
    await a.rollback();
    expect(await peakAndQuantity(variantId)).toEqual({ peak: 0, qty: 2 });
  });

  it("retiring a serialized unit that a concurrent hold just took is refused", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const unit = (
      await admin<{ id: string }>("select id from public.inventory_units where variant_id = $1", [
        variantId,
      ])
    ).rows[0]!.id;
    const a = await openTx(SYSTEM);
    await a.q(holdSql, [org.id, items(variantId)]);
    const b = await openTx(org.users.office);
    const retire = settle(
      b.q("update public.inventory_units set status = 'retired' where id = $1", [unit]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await retire).toBe("RA011");
    await b.rollback();
    // Deleting it is refused too.
    expect(await settle(admin("delete from public.inventory_units where id = $1", [unit]))).toMatch(
      /RA011|23503/,
    );
  });
});

describe("hold creation vs maintenance block", () => {
  it("block first: the hold waits, then is BLOCKED", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const b = await openTx(org.users.office);
    await b.q(
      "insert into public.availability_blocks (organization_id, product_id, period, reason, created_by) values ($1, $2, tstzrange($3, $4), 'maintenance', $5)",
      [org.id, productId, june(26, "08:00"), june(26, "20:00"), org.users.office.id],
    );
    const a = await openTx(SYSTEM);
    const hold = settle(a.q(holdSql, [org.id, items(variantId)]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await hold).toBe("RA002");
    await a.rollback();
  });

  it("hold first: the block waits, then flags the hold for staff (never an unflagged overlap)", async () => {
    const { productId, variantId } = await makeProduct(org, { units: 1 });
    const a = await openTx(SYSTEM);
    const rid = (await a.q<{ id: string }>(holdSql, [org.id, items(variantId)])).rows[0]!.id;
    const b = await openTx(org.users.office);
    const block = settle(
      b.q(
        "insert into public.availability_blocks (organization_id, product_id, period, reason, created_by) values ($1, $2, tstzrange($3, $4), 'maintenance', $5)",
        [org.id, productId, june(26, "08:00"), june(26, "20:00"), org.users.office.id],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await block).toBe("ok");
    await b.commit();
    expect(await flagsFor(rid)).toEqual(["availability_block"]);
  });
});

describe("hold creation vs staff block", () => {
  it("partial staff block first on pooled stock: the hold waits, then gets only what is left", async () => {
    const { variantId } = await makeProduct(org, { pooled: 2 });
    const b = await openTx(org.users.office);
    await b.q(
      "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason, created_by) values ($1, $2, 1, tstzrange($3, $4), 'staff_hold', $5)",
      [org.id, variantId, june(26, "08:00"), june(26, "20:00"), org.users.office.id],
    );
    const a = await openTx(SYSTEM);
    const hold = settle(a.q(holdSql, [org.id, items(variantId, 2)]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await hold).toBe("RA001");
    await a.rollback();
    expect(await outcome(reserve(SYSTEM, org, [{ variantId, quantity: 1, ...W }]))).toBe("ok");
  });

  it("hold first: the staff block waits, then flags the overlapping hold", async () => {
    const { variantId } = await makeProduct(org, { pooled: 2 });
    const a = await openTx(SYSTEM);
    const rid = (await a.q<{ id: string }>(holdSql, [org.id, items(variantId, 2)])).rows[0]!.id;
    const b = await openTx(org.users.office);
    const block = settle(
      b.q(
        "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason, created_by) values ($1, $2, 1, tstzrange($3, $4), 'staff_hold', $5)",
        [org.id, variantId, june(26, "08:00"), june(26, "20:00"), org.users.office.id],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await block).toBe("ok");
    await b.commit();
    expect(await flagsFor(rid)).toEqual(["availability_block"]);
  });

  it("an organization-wide blackout waits for in-flight holds of any product (exclusive lock)", async () => {
    const { variantId } = await makeProduct(org, { units: 1 });
    const a = await openTx(SYSTEM);
    const rid = (
      await a.q<{ id: string }>(holdSql, [
        org.id,
        items(variantId, 1, { start: june(27, "12:00"), end: june(27, "14:00") }),
      ])
    ).rows[0]!.id;
    const b = await openTx(org.users.office);
    const blackout = settle(
      b.q(
        "insert into public.availability_blocks (organization_id, period, reason, created_by) values ($1, tstzrange($2, $3), 'blackout', $4)",
        [org.id, june(27, "00:00"), june(28, "00:00"), org.users.office.id],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await blackout).toBe("ok");
    await b.commit();
    expect(await flagsFor(rid)).toEqual(["availability_block"]);
    await admin(
      "delete from public.availability_blocks where organization_id = $1 and reason = 'blackout'",
      [org.id],
    );
  });
});

describe("confirmation vs inventory reduction", () => {
  it("confirming first: the reduction waits, then is refused", async () => {
    const { variantId } = await makeProduct(org, { pooled: 2 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_reservation($1)", [rid]);
    const b = await openTx(org.users.office);
    const reduce = settle(
      b.q("update public.product_variants set pooled_quantity = 1 where id = $1", [variantId]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await reduce).toBe("RA011");
    await b.rollback();
  });

  it("a hold confirmed at the last moment is never treated as expired by a concurrent reduction", async () => {
    const { variantId } = await makeProduct(org, { pooled: 2 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    await admin(
      "update public.reservations set hold_expires_at = now() + interval '1500 milliseconds' where id = $1",
      [rid],
    );
    const a = await openTx(org.users.office);
    await a.q("select public.confirm_reservation($1)", [rid]); // passes: hold still live
    await new Promise((r) => setTimeout(r, 1700)); // the hold's expiry time passes, A not committed
    const b = await openTx(org.users.office);
    const reduce = settle(
      b.q("update public.product_variants set pooled_quantity = 0 where id = $1", [variantId]),
    );
    await waitUntilBlocked(b.pid); // without the lock B would see an "expired" hold and succeed
    await a.commit();
    expect(await reduce).toBe("RA011");
    await b.rollback();
    expect(await peakAndQuantity(variantId)).toEqual({ peak: 2, qty: 2 });
  });

  it("reduction first: confirming waits and still succeeds when the hold fits", async () => {
    const { variantId } = await makeProduct(org, { pooled: 3 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    const b = await openTx(org.users.office);
    await b.q("update public.product_variants set pooled_quantity = 2 where id = $1", [variantId]);
    const a = await openTx(org.users.office);
    const confirm = settle(a.q("select public.confirm_reservation($1)", [rid]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await confirm).toBe("ok");
    await a.commit();
    expect(await peakAndQuantity(variantId)).toEqual({ peak: 2, qty: 2 });
  });

  it("renewing a hold is serialized with reductions as well", async () => {
    const { variantId } = await makeProduct(org, { pooled: 1 });
    const rid = await reserve(SYSTEM, org, [{ variantId, quantity: 1, ...W }]);
    const a = await openTx(SYSTEM);
    await a.q("select public.renew_hold($1)", [rid]);
    const b = await openTx(org.users.office);
    const reduce = settle(
      b.q("update public.product_variants set pooled_quantity = 0 where id = $1", [variantId]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await reduce).toBe("RA011");
    await b.rollback();
  });
});

describe("two availability-affecting admin mutations at once", () => {
  it("a variant-scoped block and a quantity change on the same variant are serialized", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    await reserve(SYSTEM, org, [{ variantId, quantity: 2, ...W }]);
    const a = await openTx(org.users.office);
    await a.q(
      "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason, created_by) values ($1, $2, 1, tstzrange($3, $4), 'repair', $5)",
      [org.id, variantId, june(26, "08:00"), june(26, "20:00"), org.users.office.id],
    );
    const b = await openTx(org.users.admin);
    const reduce = settle(
      b.q("update public.product_variants set pooled_quantity = 1 where id = $1", [variantId]),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await reduce).toBe("RA011"); // 2 are booked
    await b.rollback();
  });

  it("an organization-wide change waits for a variant-scoped one and neither deadlocks", async () => {
    const { variantId } = await makeProduct(org, { pooled: 4 });
    const a = await openTx(org.users.office);
    await a.q("update public.product_variants set pooled_quantity = 5 where id = $1", [variantId]);
    const b = await openTx(org.users.admin);
    const settings = settle(
      b.q(
        "update public.organization_settings set default_setup_buffer_minutes = 30 where organization_id = $1",
        [org.id],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await settings).toBe("ok");
    await b.commit();
  });

  it("a reduction must also leave room for units blocked for repair (found by the stress test)", async () => {
    const { variantId } = await makeProduct(org, { pooled: 6 });
    await admin(
      "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason) values ($1, $2, 2, tstzrange($3, $4), 'repair')",
      [org.id, variantId, june(26, "08:00"), june(26, "20:00")],
    );
    await reserve(SYSTEM, org, [{ variantId, quantity: 4, ...W }]); // 4 booked + 2 in repair = 6
    expect(
      await outcome(
        admin("update public.product_variants set pooled_quantity = 5 where id = $1", [variantId]),
      ),
    ).toBe("RA011");
    expect(
      await outcome(
        admin("update public.product_variants set pooled_quantity = 7 where id = $1", [variantId]),
      ),
    ).toBe("ok");
  });

  it("two reductions of the same variant: the second sees the first", async () => {
    const { variantId } = await makeProduct(org, { pooled: 5 });
    await reserve(SYSTEM, org, [{ variantId, quantity: 3, ...W }]);
    const a = await openTx(org.users.office);
    await a.q("update public.product_variants set pooled_quantity = 3 where id = $1", [variantId]);
    const b = await openTx(org.users.admin);
    const second = settle(
      b.q(
        "update public.product_variants set pooled_quantity = pooled_quantity - 1 where id = $1",
        [variantId],
      ),
    );
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await second).toBe("RA011"); // 3 - 1 = 2 < 3 booked
    await b.rollback();
    expect(await peakAndQuantity(variantId)).toEqual({ peak: 3, qty: 3 });
  });
});

describe("randomized stress: invariants hold under many concurrent mixed operations", () => {
  it.each([42, 7, 1234, 99, 2027])(
    "seed %i: no oversell, no unflagged overlap with a full block, no deadlock",
    async (initialSeed) => {
      const pooled = await makeProduct(org, { pooled: 6 });
      const serial = await makeProduct(org, { units: 3 });
      const window = (i: number) => ({
        start: june(10 + (i % 3), "10:00"),
        end: june(10 + (i % 3), `${12 + (i % 4)}:00`),
      });
      let seed = initialSeed;
      const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const ops: Promise<string>[] = [];
      const errors: string[] = [];
      for (let i = 0; i < 60; i++) {
        const r = rand();
        const w = window(i);
        let op: Promise<unknown>;
        if (r < 0.45) {
          const v = rand() < 0.5 ? pooled.variantId : serial.variantId;
          op = reserve(SYSTEM, org, [
            {
              variantId: v,
              quantity: v === pooled.variantId ? 1 + Math.floor(rand() * 3) : 1,
              ...w,
            },
          ]);
        } else if (r < 0.6) {
          op = adminGated(
            org.id,
            "update public.product_variants set pooled_quantity = $2 where id = $1",
            [pooled.variantId, 2 + Math.floor(rand() * 6)],
          );
        } else if (r < 0.72) {
          op = adminGated(
            org.id,
            "insert into public.availability_blocks (organization_id, variant_id, quantity, period, reason) values ($1, $2, $3, tstzrange($4, $5), 'staff_hold')",
            [org.id, pooled.variantId, 1 + Math.floor(rand() * 2), w.start, w.end],
          );
        } else if (r < 0.82) {
          op = adminGated(
            org.id,
            "insert into public.availability_blocks (organization_id, product_id, period, reason) values ($1, $2, tstzrange($3, $4), 'maintenance')",
            [org.id, serial.productId, w.start, w.end],
          );
        } else if (r < 0.9) {
          op = adminGated(
            org.id,
            "update public.inventory_units set status = case when status = 'active' then 'retired' else 'active' end where id = (select id from public.inventory_units where variant_id = $1 order by label limit 1)",
            [serial.variantId],
          );
        } else {
          op = admin(
            "select public.confirm_reservation(r.id) from public.reservations r where r.organization_id = $1 and r.status = 'held' order by r.created_at limit 1",
            [org.id],
          ).catch((e: unknown) => {
            throw e;
          });
        }
        ops.push(
          outcome(op).then((o) => {
            if (!["ok", "RA001", "RA002", "RA011", "RA004", "RA006", "RA005"].includes(o))
              errors.push(o);
            return o;
          }),
        );
      }
      await Promise.all(ops);
      expect(errors).toEqual([]); // in particular no 40P01 deadlocks

      // 1. Pooled: booked/held units never exceed the quantity at any future moment.
      const p = await peakAndQuantity(pooled.variantId);
      expect(p.peak).toBeLessThanOrEqual(p.qty);
      // 2. Serialized: no active allocation sits on a retired unit.
      const onRetired = await admin(
        `select 1 from public.reservation_allocations a join public.inventory_units u on u.id = a.inventory_unit_id
       where u.status <> 'active' and app.allocation_is_active(a.status, a.hold_expires_at) and upper(a.occupied_period) > now()`,
      );
      expect(onRetired.rowCount).toBe(0);
      // 3. Every active allocation overlapping a full (maintenance) block is flagged for staff.
      const unflagged = await admin(
        `select a.reservation_id from public.reservation_allocations a
       join public.product_variants v on v.id = a.variant_id
       join public.availability_blocks b on b.product_id = v.product_id and b.period && a.occupied_period and b.quantity is null
       where a.organization_id = $1 and app.allocation_is_active(a.status, a.hold_expires_at)
         and not exists (select 1 from public.reservation_flags f where f.reservation_id = a.reservation_id and f.availability_block_id = b.id)`,
        [org.id],
      );
      expect(unflagged.rows).toEqual([]);
      // 4. Pooled partial blocks: at every moment where an UNFLAGGED booking/hold exists,
      //    booked + blocked units fit the quantity (blocks created over bookings flag them).
      const overCapacity = await admin<{ peak: number }>(
        `with iv as (
           select a.occupied_period r, a.quantity qa, 0 qb from public.reservation_allocations a
           where a.variant_id = $1 and app.allocation_is_active(a.status, a.hold_expires_at)
             and upper(a.occupied_period) > now()
             and not exists (select 1 from public.reservation_flags f where f.reservation_id = a.reservation_id)
           union all
           select b.period, 0, b.quantity from public.availability_blocks b where b.variant_id = $1 and b.quantity is not null),
         ev as (select lower(r) t, qa da, qb db from iv union all select upper(r), -qa, -qb from iv),
         running as (select sum(da) over w booked, sum(db) over w blocked from ev
                     window w as (order by t, da + db rows between unbounded preceding and current row))
         select coalesce(max(booked + blocked) filter (where booked > 0), 0)::int as peak from running`,
        [pooled.variantId],
      );
      expect(overCapacity.rows[0]!.peak).toBeLessThanOrEqual(p.qty);
    },
  );
});

describe("weather rules and weather blocks (Codex re-review blocker 2)", () => {
  // A confirmed 20 mph wind block over the window; products only become blocked through rules.
  const setup = async () => {
    const cat = await admin<{ id: string }>(
      "insert into public.categories (organization_id, name, slug) values ($1, 'Inflatables', $2) returning id",
      [org.id, `inflatables-${Math.random().toString(36).slice(2, 8)}`],
    );
    const categoryId = cat.rows[0]!.id;
    const p = await makeProduct(org, { units: 1, categoryId });
    await admin(
      "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
      [org.id, p.productId, categoryId],
    );
    const day = { start: june(12, "12:00"), end: june(12, "16:00") };
    const block = await admin<{ id: string }>(
      `insert into public.weather_blocks (organization_id, hazard, period, status, scope, reason, observed_value, observed_unit)
       values ($1, 'wind', tstzrange($2, $3), 'confirmed', 'all_sensitive', 'Gusts', 20, 'mph') returning id`,
      [org.id, june(12, "00:00"), june(13, "00:00")],
    );
    return { ...p, categoryId, day, blockId: block.rows[0]!.id };
  };
  const ruleSql =
    "insert into public.weather_hazard_rules (organization_id, category_id, hazard, sensitive, threshold_value, threshold_unit) values ($1, $2, 'wind', true, 15, 'mph')";
  const cleanup = (blockId: string) =>
    admin("update public.weather_blocks set status = 'lifted' where id = $1", [blockId]);

  it("rule first (uncommitted INSERT): the hold waits, then is BLOCKED by the new rule", async () => {
    const s = await setup();
    const b = await openTx(org.users.admin);
    await b.q(ruleSql, [org.id, s.categoryId]);
    const a = await openTx(SYSTEM);
    const hold = settle(a.q(holdSql, [org.id, items(s.variantId, 1, s.day)]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await hold).toBe("RA002");
    await a.rollback();
    await cleanup(s.blockId);
  });

  it("hold first: the rule INSERT waits, then flags the now-affected hold (never cancels it)", async () => {
    const s = await setup();
    const a = await openTx(SYSTEM);
    const rid = (await a.q<{ id: string }>(holdSql, [org.id, items(s.variantId, 1, s.day)]))
      .rows[0]!.id;
    const b = await openTx(org.users.admin);
    const rule = settle(b.q(ruleSql, [org.id, s.categoryId]));
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await rule).toBe("ok");
    await b.commit();
    expect(await flagsFor(rid)).toEqual(["weather_block"]);
    // …and the hold can no longer be confirmed while the block stands.
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_reservation($1)", [rid])),
    ).toBe("RA002");
    await cleanup(s.blockId);
  });

  it("deleting a product-level 'not sensitive' override exposes the product: bookings are flagged", async () => {
    const s = await setup();
    await admin(ruleSql, [org.id, s.categoryId]);
    const override = await admin<{ id: string }>(
      "insert into public.weather_hazard_rules (organization_id, product_id, hazard, sensitive) values ($1, $2, 'wind', false) returning id",
      [org.id, s.productId],
    );
    const rid = await reserve(SYSTEM, org, [{ variantId: s.variantId, ...s.day }]);
    expect(
      await outcome(rpc(org.users.office, "select public.confirm_reservation($1)", [rid])),
    ).toBe("ok");
    await admin("delete from public.weather_hazard_rules where id = $1", [override.rows[0]!.id]);
    expect(await flagsFor(rid)).toEqual(["weather_block"]);
    expect(await outcome(reserve(SYSTEM, org, [{ variantId: s.variantId, ...s.day }]))).toBe(
      "RA002",
    );
    await cleanup(s.blockId);
  });

  it("joining a category targeted by a 'selected' weather block is serialized with holds", async () => {
    const s = await setup();
    const other = await admin<{ id: string }>(
      "insert into public.categories (organization_id, name, slug) values ($1, 'Tents', $2) returning id",
      [org.id, `tents-${Math.random().toString(36).slice(2, 8)}`],
    );
    const sel = await admin<{ id: string }>(
      `insert into public.weather_blocks (organization_id, hazard, period, status, scope, reason)
       values ($1, 'lightning', tstzrange($2, $3), 'confirmed', 'selected', 'Storm') returning id`,
      [org.id, june(12, "00:00"), june(13, "00:00")],
    );
    await admin(
      "insert into public.weather_block_targets (organization_id, weather_block_id, category_id) values ($1, $2, $3)",
      [org.id, sel.rows[0]!.id, other.rows[0]!.id],
    );
    const b = await openTx(org.users.office);
    await b.q(
      "insert into public.product_categories (organization_id, product_id, category_id) values ($1, $2, $3)",
      [org.id, s.productId, other.rows[0]!.id],
    );
    const a = await openTx(SYSTEM);
    const hold = settle(a.q(holdSql, [org.id, items(s.variantId, 1, s.day)]));
    await waitUntilBlocked(a.pid);
    await b.commit();
    expect(await hold).toBe("RA002");
    await a.rollback();
    await cleanup(sel.rows[0]!.id);
    await cleanup(s.blockId);
  });

  it("lifting a weather block is serialized with in-flight holds too", async () => {
    const s = await setup();
    const other = await makeProduct(org, { units: 1 });
    const a = await openTx(SYSTEM);
    await a.q(holdSql, [org.id, items(other.variantId, 1, s.day)]);
    const b = await openTx(org.users.admin);
    const lifting = settle(b.q("select public.lift_weather_block($1)", [s.blockId]));
    await waitUntilBlocked(b.pid);
    await a.commit();
    expect(await lifting).toBe("ok");
    await b.commit();
  });
});
