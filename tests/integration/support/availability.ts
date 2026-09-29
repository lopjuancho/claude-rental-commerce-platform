import { randomUUID } from "node:crypto";
import { type Actor, admin, adminGated, as, type TestOrg } from "./db";

export interface Item {
  variantId: string;
  quantity?: number;
  start: string;
  end: string;
}

/** Local wall-clock time in Memphis for a date in June 2027 (CDT, UTC−5). */
export const june = (day: number, hhmm: string) =>
  `2027-06-${String(day).padStart(2, "0")}T${hhmm}:00-05:00`;

export async function makeProduct(
  org: TestOrg,
  opts: {
    units?: number;
    pooled?: number;
    published?: boolean;
    categoryId?: string | null;
    setupBuffer?: number | null;
    teardownBuffer?: number | null;
    leadTimeMinutes?: number | null;
  } = {},
) {
  const slug = `p-${randomUUID().slice(0, 8)}`;
  const { rows } = await admin<{ id: string }>(
    `insert into public.products (organization_id, name, slug, base_price_cents, is_published, primary_category_id,
                                  setup_buffer_minutes, teardown_buffer_minutes, min_booking_lead_time_minutes)
     values ($1, $2, $2, 10000, $3, $4, $5, $6, $7) returning id`,
    [
      org.id,
      slug,
      opts.published ?? true,
      opts.categoryId ?? null,
      opts.setupBuffer ?? null,
      opts.teardownBuffer ?? null,
      opts.leadTimeMinutes ?? null,
    ],
  );
  const productId = rows[0]!.id;
  const variant = await admin<{ id: string }>(
    "select id from public.product_variants where product_id = $1",
    [productId],
  );
  const variantId = variant.rows[0]!.id;
  if (opts.pooled !== undefined) {
    await adminGated(
      org.id,
      "update public.product_variants set tracking_mode = 'pooled', pooled_quantity = $2 where id = $1",
      [variantId, opts.pooled],
    );
  } else {
    await addUnits(org, variantId, opts.units ?? 1);
  }
  return { productId, variantId };
}

export async function addUnits(org: TestOrg, variantId: string, n: number) {
  const ids: string[] = [];
  for (let i = 1; i <= n; i++) {
    const { rows } = await adminGated<{ id: string }>(
      org.id,
      "insert into public.inventory_units (organization_id, variant_id, label) values ($1, $2, $3) returning id",
      [org.id, variantId, `Unit ${String(i).padStart(2, "0")}-${randomUUID().slice(0, 4)}`],
    );
    ids.push(rows[0]!.id);
  }
  return ids;
}

const toJson = (items: Item[]) =>
  JSON.stringify(
    items.map((i) => ({
      variant_id: i.variantId,
      quantity: i.quantity ?? 1,
      start: i.start,
      end: i.end,
    })),
  );

/** Calls reserve_inventory as `actor` in its own committed transaction. Resolves to the reservation id. */
export function reserve(
  actor: Actor,
  org: TestOrg,
  items: Item[],
  opts: { status?: "held" | "confirmed"; replaces?: string; overrideLeadTime?: boolean } = {},
): Promise<string> {
  return as(
    actor,
    async (sql) =>
      (
        await sql<{ id: string }>(
          "select public.reserve_inventory($1, $2::jsonb, $3::public.reservation_status, 'booking_request', $4, $5) as id",
          [
            org.id,
            toJson(items),
            opts.status ?? "held",
            opts.replaces ?? null,
            opts.overrideLeadTime ?? false,
          ],
        )
      ).rows[0]!.id,
    { commit: true },
  );
}

export function rpc<T = unknown>(actor: Actor, text: string, params: unknown[]): Promise<T[]> {
  return as(
    actor,
    async (sql) => (await sql<T & Record<string, unknown>>(text, params)).rows as T[],
    { commit: true },
  );
}

export async function checkStaff(
  actor: Actor,
  org: TestOrg,
  variantId: string,
  start: string,
  end: string,
  qty = 1,
) {
  const rows = await rpc<{
    available: boolean;
    available_quantity: number;
    capacity: number;
    reasons: string[];
  }>(
    actor,
    "select available, available_quantity, capacity, reasons from public.check_availability($1, $2, $3, $4, $5)",
    [org.id, variantId, start, end, qty],
  );
  return rows[0]!;
}

export async function checkPublic(
  org: TestOrg,
  variantId: string,
  start: string,
  end: string,
  qty = 1,
) {
  const rows = await rpc<{ available: boolean; limited: boolean; reasons: string[] }>(
    { kind: "anon" },
    "select available, limited, reasons from public.check_public_availability($1, $2, $3, $4, $5)",
    [org.id, variantId, start, end, qty],
  );
  return rows[0]!;
}

export const SYSTEM: Actor = { kind: "service" };

/** SQLSTATE of a rejected promise (or "ok"). */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
}
