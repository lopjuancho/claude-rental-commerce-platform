import "server-only";
import { z } from "zod";
import { localRentalPeriod } from "@/domain/availability/local-time";
import { DomainError } from "@/domain/errors";
import { WEATHER_HAZARDS, THRESHOLD_UNITS } from "@/domain/weather/hazards";
import { requireStaff } from "@/server/auth/context";
import { fromDbError } from "@/server/catalog/errors";
import { createUserClient } from "@/server/db/user";
import { fromEngineError } from "./errors";

const localPeriod = z.object({
  date: z.iso.date(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  endDate: z.iso.date().optional(),
});

async function organizationTimezone(organizationId: string): Promise<string> {
  const db = await createUserClient();
  const { data, error } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .single();
  if (error) throw fromDbError(error, "Organization");
  return data.timezone;
}

/** Local date/time in the organization's time zone → ISO instants for the engine. */
async function toPeriod(organizationId: string, raw: unknown) {
  const p = localPeriod.parse(raw);
  try {
    const { start, end } = localRentalPeriod({
      ...p,
      timeZone: await organizationTimezone(organizationId),
    });
    return { start: start.toISOString(), end: end.toISOString() };
  } catch (e) {
    throw new DomainError("INVALID_INPUT", e instanceof Error ? e.message : "Invalid period");
  }
}

export async function checkAvailability(raw: unknown) {
  const ctx = await requireStaff("org.read");
  const input = z
    .object({
      variantId: z.uuid(),
      quantity: z.int().min(1).max(10000),
      overrideLeadTime: z.boolean().default(false),
      period: z.unknown(),
    })
    .parse(raw);
  const period = await toPeriod(ctx.organizationId, input.period);
  const db = await createUserClient();
  const { data, error } = await db.rpc("check_availability", {
    p_organization_id: ctx.organizationId,
    p_variant_id: input.variantId,
    p_start: period.start,
    p_end: period.end,
    p_quantity: input.quantity,
    p_override_lead_time: input.overrideLeadTime,
  });
  if (error) throw fromEngineError(error);
  const row = data[0];
  if (!row) throw new DomainError("INTERNAL");
  return { ...row, period };
}

/** Staff booking or hold (manual source). Reservations are only ever created by the engine. */
export async function createStaffReservation(raw: unknown): Promise<string> {
  const ctx = await requireStaff("availability.write");
  const input = z
    .object({
      variantId: z.uuid(),
      quantity: z.int().min(1).max(10000),
      status: z.enum(["held", "confirmed"]),
      overrideLeadTime: z.boolean().default(false),
      notes: z.string().trim().max(2000).nullish(),
      period: z.unknown(),
    })
    .parse(raw);
  const period = await toPeriod(ctx.organizationId, input.period);
  const db = await createUserClient();
  const { data, error } = await db.rpc("reserve_inventory", {
    p_organization_id: ctx.organizationId,
    p_items: [
      {
        variant_id: input.variantId,
        quantity: input.quantity,
        start: period.start,
        end: period.end,
      },
    ],
    p_status: input.status,
    p_source: "manual",
    p_override_lead_time: input.overrideLeadTime,
    ...(input.notes ? { p_notes: input.notes } : {}),
  });
  if (error) throw fromEngineError(error);
  return data;
}

export async function confirmReservation(id: string, ignoreWeather = false) {
  await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db.rpc("confirm_reservation", {
    p_reservation_id: z.uuid().parse(id),
    p_ignore_weather: ignoreWeather,
  });
  if (error) throw fromEngineError(error);
}

export async function releaseReservation(id: string) {
  await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db.rpc("release_reservation", { p_reservation_id: z.uuid().parse(id) });
  if (error) throw fromEngineError(error);
}

export async function listUpcomingReservations(days = 60) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);
  const { data, error } = await db
    .from("reservation_allocations")
    .select(
      "reservation_id, quantity, rental_period, status, hold_expires_at, inventory_unit_id, product_variants(name, is_default, products(name)), inventory_units(label)",
    )
    .eq("organization_id", ctx.organizationId)
    .in("status", ["held", "confirmed"])
    .overlaps("rental_period", `[${now.toISOString()},${until.toISOString()})`)
    .order("rental_period")
    .limit(300);
  if (error) throw fromDbError(error, "Reservation");
  return data.filter(
    (a) =>
      a.status === "confirmed" || (a.hold_expires_at !== null && new Date(a.hold_expires_at) > now),
  );
}

export async function listOpenFlags() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("reservation_flags")
    .select("id, reservation_id, kind, message, created_at")
    .eq("organization_id", ctx.organizationId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw fromDbError(error, "Flag");
  return data;
}

export async function resolveFlag(id: string) {
  const ctx = await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db
    .from("reservation_flags")
    .update({ status: "resolved", resolved_by: ctx.user.id, resolved_at: new Date().toISOString() })
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Flag");
}

// ───────────── blocks ─────────────

export async function listBlocks() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("availability_blocks")
    .select(
      "id, period, reason, quantity, notes, product_id, variant_id, inventory_unit_id, products(name), inventory_units(label)",
    )
    .eq("organization_id", ctx.organizationId)
    .overlaps("period", `[${new Date(Date.now() - 86_400_000).toISOString()},)`)
    .order("period")
    .limit(200);
  if (error) throw fromDbError(error, "Block");
  return data;
}

const blockInput = z.object({
  scope: z.enum(["organization", "product", "unit", "variant_quantity"]),
  productId: z.uuid().nullish(),
  unitId: z.uuid().nullish(),
  variantId: z.uuid().nullish(),
  quantity: z.int().min(1).nullish(),
  reason: z.enum(["blackout", "maintenance", "repair", "private_use", "staff_hold", "other"]),
  notes: z.string().trim().max(1000).nullish(),
  period: z.unknown(),
});

export async function createBlock(raw: unknown) {
  const ctx = await requireStaff("availability.write");
  const input = blockInput.parse(raw);
  const period = await toPeriod(ctx.organizationId, input.period);
  const scope = {
    product_id: input.scope === "product" ? (input.productId ?? null) : null,
    inventory_unit_id: input.scope === "unit" ? (input.unitId ?? null) : null,
    variant_id: input.scope === "variant_quantity" ? (input.variantId ?? null) : null,
    quantity: input.scope === "variant_quantity" ? (input.quantity ?? null) : null,
  };
  if (
    input.scope !== "organization" &&
    !scope.product_id &&
    !scope.inventory_unit_id &&
    !scope.variant_id
  ) {
    throw new DomainError("INVALID_INPUT", "Choose what to block.");
  }
  const db = await createUserClient();
  const { error } = await db.from("availability_blocks").insert({
    organization_id: ctx.organizationId,
    period: `[${period.start},${period.end})`,
    reason: input.reason,
    notes: input.notes ?? null,
    ...scope,
  });
  if (error) throw fromDbError(error, "Block");
}

export async function deleteBlock(id: string) {
  const ctx = await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db
    .from("availability_blocks")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Block");
}

// ───────────── weather blocks ─────────────

export async function listWeatherBlocks() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("weather_blocks")
    .select(
      "id, hazard, period, status, source, scope, reason, observed_value, observed_unit, confirmed_at, lifted_at, weather_block_targets(category_id, product_id, categories(name), products(name))",
    )
    .eq("organization_id", ctx.organizationId)
    .overlaps("period", `[${new Date(Date.now() - 7 * 86_400_000).toISOString()},)`)
    .order("period", { ascending: false })
    .limit(100);
  if (error) throw fromDbError(error, "Weather block");
  return data;
}

const weatherInput = z
  .object({
    hazard: z.enum(WEATHER_HAZARDS),
    scope: z.enum(["all_sensitive", "selected"]),
    reason: z.string().trim().min(1).max(500),
    observedValue: z.number().min(0).max(9999).nullish(),
    observedUnit: z.enum(THRESHOLD_UNITS).nullish(),
    categoryIds: z.array(z.uuid()).max(50).default([]),
    productIds: z.array(z.uuid()).max(200).default([]),
    period: z.unknown(),
  })
  .refine((w) => w.scope === "all_sensitive" || w.categoryIds.length + w.productIds.length > 0, {
    message: "Choose at least one category or product for a selected-scope block.",
  });

/** Proposes a weather block; it has no effect until a staff member confirms it (ADR 0010). */
export async function proposeWeatherBlock(raw: unknown): Promise<string> {
  const ctx = await requireStaff("availability.write");
  const input = weatherInput.parse(raw);
  const period = await toPeriod(ctx.organizationId, input.period);
  const db = await createUserClient();
  const { data, error } = await db
    .from("weather_blocks")
    .insert({
      organization_id: ctx.organizationId,
      hazard: input.hazard,
      scope: input.scope,
      reason: input.reason,
      period: `[${period.start},${period.end})`,
      observed_value: input.observedValue ?? null,
      observed_unit: input.observedValue == null ? null : (input.observedUnit ?? null),
    })
    .select("id")
    .single();
  if (error) throw fromDbError(error, "Weather block");
  if (input.scope === "selected") {
    const targets = [
      ...input.categoryIds.map((category_id) => ({
        organization_id: ctx.organizationId,
        weather_block_id: data.id,
        category_id,
      })),
      ...input.productIds.map((product_id) => ({
        organization_id: ctx.organizationId,
        weather_block_id: data.id,
        product_id,
      })),
    ];
    const t = await db.from("weather_block_targets").insert(targets);
    if (t.error) throw fromDbError(t.error, "Weather block");
  }
  return data.id;
}

export async function confirmWeatherBlock(id: string): Promise<number> {
  await requireStaff("availability.write");
  const db = await createUserClient();
  const { data, error } = await db.rpc("confirm_weather_block", {
    p_weather_block_id: z.uuid().parse(id),
  });
  if (error) throw fromEngineError(error, "Weather block");
  return data;
}

export async function liftWeatherBlock(id: string) {
  await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db.rpc("lift_weather_block", { p_weather_block_id: z.uuid().parse(id) });
  if (error) throw fromEngineError(error, "Weather block");
}

export async function deleteProposedWeatherBlock(id: string) {
  const ctx = await requireStaff("availability.write");
  const db = await createUserClient();
  const { error } = await db
    .from("weather_blocks")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId)
    .eq("status", "proposed");
  if (error) throw fromDbError(error, "Weather block");
}

export async function getOrganizationTimezone(): Promise<string> {
  const ctx = await requireStaff("org.read");
  return organizationTimezone(ctx.organizationId);
}

/** Bookable variants for pickers: "Castle", "Castle — Blue", with tracking info and units. */
export async function listVariantOptions() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("product_variants")
    .select(
      "id, name, is_default, tracking_mode, pooled_quantity, products!inner(id, name, archived_at), inventory_units(id, label, status)",
    )
    .eq("organization_id", ctx.organizationId)
    .is("archived_at", null)
    .is("products.archived_at", null)
    .order("name")
    .limit(1000);
  if (error) throw fromDbError(error, "Product");
  return data
    .map((v) => ({
      variantId: v.id,
      productId: v.products.id,
      label: v.is_default ? v.products.name : `${v.products.name} — ${v.name}`,
      trackingMode: v.tracking_mode,
      units: v.inventory_units
        .filter((u) => u.status === "active")
        .map((u) => ({ id: u.id, label: u.label })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
