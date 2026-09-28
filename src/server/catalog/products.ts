import "server-only";
import { z } from "zod";
import {
  productInputSchema,
  type ProductInput,
  variantInventoryInputSchema,
} from "@/domain/catalog/schemas";
import { DomainError } from "@/domain/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { fromDbError } from "./errors";

function toRow(p: ProductInput) {
  return {
    name: p.name,
    slug: p.slug,
    short_description: p.shortDescription ?? null,
    description: p.description ?? null,
    primary_category_id: p.primaryCategoryId ?? p.categoryIds[0] ?? null,
    is_published: p.isPublished,
    is_featured: p.isFeatured,
    sort_order: p.sortOrder,
    pricing_type: p.pricingType,
    base_price_cents: p.basePriceCents,
    included_duration_minutes: p.includedDurationMinutes ?? null,
    minimum_rental_minutes: p.minimumRentalMinutes ?? null,
    setup_buffer_minutes: p.setupBufferMinutes ?? null,
    teardown_buffer_minutes: p.teardownBufferMinutes ?? null,
    min_booking_lead_time_minutes: p.minBookingLeadTimeMinutes ?? null,
    overnight_allowed: p.overnightAllowed ?? null,
    wet_allowed: p.wetAllowed,
    dry_allowed: p.dryAllowed,
    minimum_age: p.minimumAge ?? null,
    maximum_age: p.maximumAge ?? null,
    recommended_capacity: p.recommendedCapacity ?? null,
    max_rider_weight_lbs: p.maxRiderWeightLbs ?? null,
    ideal_event_types: p.idealEventTypes,
    indoor_allowed: p.indoorAllowed,
    outdoor_allowed: p.outdoorAllowed,
    allowed_surfaces: p.allowedSurfaces,
    space_length_ft: p.spaceLengthFt ?? null,
    space_width_ft: p.spaceWidthFt ?? null,
    space_height_ft: p.spaceHeightFt ?? null,
    power_outlets_required: p.powerOutletsRequired ?? null,
    power_notes: p.powerNotes ?? null,
    water_required: p.waterRequired,
    operator_required: p.operatorRequired,
    attendants_required: p.attendantsRequired,
    setup_minutes: p.setupMinutes ?? null,
    teardown_minutes: p.teardownMinutes ?? null,
    setup_requirements: p.setupRequirements ?? null,
    anchoring_methods: p.anchoringMethods,
    tags: [...new Set(p.tags)],
    internal_notes: p.internalNotes ?? null,
  };
}

export async function listProducts(filter: { search?: string; categoryId?: string } = {}) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  let query = db
    .from("products")
    .select(
      "id, name, slug, base_price_cents, is_published, is_featured, primary_category_id, updated_at, product_variants(tracking_mode, pooled_quantity, inventory_units(status))",
    )
    .eq("organization_id", ctx.organizationId)
    .is("archived_at", null)
    .order("sort_order")
    .order("name")
    .limit(500);
  if (filter.search) query = query.ilike("name", `%${filter.search.replace(/[%_\\]/g, "\\$&")}%`);
  if (filter.categoryId) query = query.eq("primary_category_id", filter.categoryId);
  const { data, error } = await query;
  if (error) throw fromDbError(error, "Product");
  return data.map((p) => ({
    ...p,
    quantity: p.product_variants.reduce(
      (sum, v) =>
        sum +
        (v.tracking_mode === "pooled"
          ? (v.pooled_quantity ?? 0)
          : v.inventory_units.filter((u) => u.status === "active").length),
      0,
    ),
  }));
}

export async function getProduct(id: string) {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("products")
    .select(
      "*, product_categories(category_id), product_variants(*, inventory_units(*)), product_media(*)",
    )
    .eq("organization_id", ctx.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw fromDbError(error, "Product");
  if (!data) throw new DomainError("NOT_FOUND", "Product not found.");
  return data;
}

export type ProductDetail = Awaited<ReturnType<typeof getProduct>>;

async function replaceCategories(organizationId: string, productId: string, categoryIds: string[]) {
  const db = await createUserClient();
  const del = await db
    .from("product_categories")
    .delete()
    .eq("organization_id", organizationId)
    .eq("product_id", productId);
  if (del.error) throw fromDbError(del.error, "Product");
  if (categoryIds.length === 0) return;
  const ins = await db.from("product_categories").insert(
    [...new Set(categoryIds)].map((category_id) => ({
      organization_id: organizationId,
      product_id: productId,
      category_id,
    })),
  );
  if (ins.error) throw fromDbError(ins.error, "Product");
}

export async function createProduct(raw: unknown): Promise<string> {
  const ctx = await requireStaff("catalog.write");
  const input = productInputSchema.parse(raw);
  const db = await createUserClient();
  const { data, error } = await db
    .from("products")
    .insert({ organization_id: ctx.organizationId, ...toRow(input) })
    .select("id")
    .single();
  if (error) throw fromDbError(error, "Product");
  await replaceCategories(ctx.organizationId, data.id, input.categoryIds);
  return data.id;
}

export async function updateProduct(id: string, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = productInputSchema.parse(raw);
  const db = await createUserClient();
  const { data, error } = await db
    .from("products")
    .update(toRow(input))
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .select("id");
  if (error) throw fromDbError(error, "Product");
  if (data.length === 0) throw new DomainError("NOT_FOUND", "Product not found.");
  await replaceCategories(ctx.organizationId, id, input.categoryIds);
}

export async function archiveProduct(id: string): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { error } = await db
    .from("products")
    .update({ archived_at: new Date().toISOString(), is_published: false })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Product");
}

/** Switches the default variant between serialized units and a pooled quantity. */
export async function setVariantInventory(variantId: string, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = variantInventoryInputSchema.parse(raw);
  const db = await createUserClient();
  if (input.trackingMode === "pooled") {
    const units = await db
      .from("inventory_units")
      .select("id")
      .eq("variant_id", variantId)
      .eq("status", "active")
      .limit(1);
    if (units.error) throw fromDbError(units.error, "Inventory");
    if (units.data.length > 0) {
      throw new DomainError(
        "INVALID_INPUT",
        "Retire the individual units before switching to a pooled quantity.",
      );
    }
  }
  const { error } = await db
    .from("product_variants")
    .update({
      tracking_mode: input.trackingMode,
      pooled_quantity: input.trackingMode === "pooled" ? input.pooledQuantity : null,
    })
    .eq("id", variantId)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Inventory");
}

const unitInput = z.object({
  variantId: z.uuid(),
  label: z.string().trim().min(1).max(120),
  serialNumber: z.string().trim().max(120).nullish(),
});

export async function addInventoryUnit(raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = unitInput.parse(raw);
  const db = await createUserClient();
  const { error } = await db.from("inventory_units").insert({
    organization_id: ctx.organizationId,
    variant_id: input.variantId,
    label: input.label,
    serial_number: input.serialNumber ?? null,
  });
  if (error) throw fromDbError(error, "Inventory unit");
}

/** Units are retired, never deleted, so booking history keeps pointing at real rows. */
export async function setInventoryUnitStatus(
  unitId: string,
  status: "active" | "retired",
): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { error } = await db
    .from("inventory_units")
    .update({ status })
    .eq("id", unitId)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Inventory unit");
}
