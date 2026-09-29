import "server-only";
import { z } from "zod";
import { postalAddressSchema } from "@/domain/delivery/address";
import { DomainError } from "@/domain/errors";
import { RULE_PARAM_SCHEMAS } from "@/domain/pricing/rules";
import { PRICING_RULE_TYPES, TAX_COMPONENTS } from "@/domain/pricing/types";
import { requireStaff } from "@/server/auth/context";
import { fromDbError } from "@/server/catalog/errors";
import { createUserClient } from "@/server/db/user";
import type { Json } from "@/types/database";

// ───────────── pricing rules ─────────────

export async function listPricingRules() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("pricing_rules")
    .select(
      "id, name, rule_type, category_id, product_id, variant_id, params, priority, discount_code, valid_from, valid_to, is_active, revision, categories(name), products(name)",
    )
    .eq("organization_id", ctx.organizationId)
    .order("rule_type")
    .order("name");
  if (error) throw fromDbError(error, "Pricing rule");
  return data;
}

const ruleInput = z.object({
  id: z.uuid().nullish(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(PRICING_RULE_TYPES),
  scope: z.enum(["organization", "category", "product"]),
  categoryId: z.uuid().nullish(),
  productId: z.uuid().nullish(),
  params: z.record(z.string(), z.unknown()),
  priority: z.int().min(-1000).max(1000).default(0),
  discountCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{2,40}$/, "Codes use letters, numbers, - and _ (2–40).")
    .nullish(),
  validFrom: z.iso.date().nullish(),
  validTo: z.iso.date().nullish(),
  active: z.boolean().default(true),
});

export async function savePricingRule(raw: unknown): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const input = ruleInput.parse(raw);
  const params = RULE_PARAM_SCHEMAS[input.type].safeParse(input.params);
  if (!params.success)
    throw new DomainError(
      "INVALID_INPUT",
      `Rule settings: ${params.error.issues[0]?.message ?? "invalid"}`,
    );
  if (input.discountCode && input.type !== "discount_percent" && input.type !== "discount_fixed") {
    throw new DomainError("INVALID_INPUT", "Only discounts can have a code.");
  }
  const row = {
    name: input.name,
    rule_type: input.type,
    category_id: input.scope === "category" ? (input.categoryId ?? null) : null,
    product_id: input.scope === "product" ? (input.productId ?? null) : null,
    variant_id: null,
    params: params.data as NonNullable<Json>,
    priority: input.priority,
    discount_code: input.discountCode ?? null,
    valid_from: input.validFrom ?? null,
    valid_to: input.validTo ?? null,
    is_active: input.active,
  };
  if (input.scope !== "organization" && !row.category_id && !row.product_id)
    throw new DomainError("INVALID_INPUT", "Choose the category or product.");
  const db = await createUserClient();
  const result = input.id
    ? await db
        .from("pricing_rules")
        .update(row)
        .eq("id", input.id)
        .eq("organization_id", ctx.organizationId)
    : await db.from("pricing_rules").insert({ organization_id: ctx.organizationId, ...row });
  if (result.error) throw fromDbError(result.error, "Pricing rule");
}

export async function deletePricingRule(id: string): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const db = await createUserClient();
  // Deleting is safe for history: stored calculations keep their own copy of the rule.
  const { error } = await db
    .from("pricing_rules")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Pricing rule");
}

// ───────────── delivery settings & service areas ─────────────

export async function getDeliverySettings() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("organization_settings")
    .select(
      "primary_depot_address_line1, primary_depot_city, primary_depot_state, primary_depot_postal_code, free_delivery_miles, per_mile_rate_cents, maximum_delivery_miles, mileage_rounding_method, mileage_basis",
    )
    .eq("organization_id", ctx.organizationId)
    .single();
  if (error) throw fromDbError(error, "Delivery settings");
  return data;
}

const deliveryInput = z.object({
  depot: postalAddressSchema.nullable(),
  freeMiles: z.number().min(0).max(1000).nullable(),
  perMileRateCents: z.int().min(0).max(100_000).nullable(),
  maximumMiles: z.number().positive().max(5000).nullable(),
  rounding: z.enum(["ceil_whole_mile", "round_whole_mile", "none"]),
  basis: z.enum(["one_way", "round_trip"]),
});

export async function saveDeliverySettings(raw: unknown): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const input = deliveryInput.parse(raw);
  if ((input.freeMiles === null) !== (input.perMileRateCents === null)) {
    throw new DomainError(
      "INVALID_INPUT",
      "Set both free miles and the per-mile rate, or neither.",
    );
  }
  const db = await createUserClient();
  const { error } = await db
    .from("organization_settings")
    .update({
      primary_depot_address_line1: input.depot?.line1 ?? null,
      primary_depot_city: input.depot?.city ?? null,
      primary_depot_state: input.depot?.state ?? null,
      primary_depot_postal_code: input.depot?.postalCode ?? null,
      free_delivery_miles: input.freeMiles,
      per_mile_rate_cents: input.perMileRateCents,
      maximum_delivery_miles: input.maximumMiles,
      mileage_rounding_method: input.rounding,
      mileage_basis: input.basis,
    })
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Delivery settings");
}

export async function listServiceAreas() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("service_areas")
    .select(
      "id, name, pricing, flat_fee_cents, priority, is_active, service_area_rules(rule_type, postal_code, city, state)",
    )
    .eq("organization_id", ctx.organizationId)
    .order("priority", { ascending: false })
    .order("name");
  if (error) throw fromDbError(error, "Service area");
  return data;
}

const areaInput = z.object({
  id: z.uuid().nullish(),
  name: z.string().trim().min(1).max(120),
  pricing: z.enum(["flat", "mileage", "manual_review"]),
  flatFeeCents: z.int().min(0).max(10_000_000).nullish(),
  priority: z.int().min(-1000).max(1000).default(0),
  active: z.boolean().default(true),
  postalCodes: z.array(z.string().regex(/^\d{5}$/, "ZIP codes are 5 digits.")).max(500),
  cities: z
    .array(
      z.object({ city: z.string().trim().min(2).max(120), state: z.string().regex(/^[A-Z]{2}$/) }),
    )
    .max(200),
});

export async function saveServiceArea(raw: unknown): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const input = areaInput.parse(raw);
  if (input.pricing === "flat" && input.flatFeeCents == null)
    throw new DomainError("INVALID_INPUT", "Enter the flat delivery fee.");
  if (input.postalCodes.length + input.cities.length === 0)
    throw new DomainError("INVALID_INPUT", "Add at least one ZIP code or city.");
  const db = await createUserClient();
  const row = {
    name: input.name,
    pricing: input.pricing,
    flat_fee_cents: input.pricing === "flat" ? (input.flatFeeCents ?? null) : null,
    priority: input.priority,
    is_active: input.active,
  };
  let areaId = input.id ?? null;
  if (areaId) {
    const r = await db
      .from("service_areas")
      .update(row)
      .eq("id", areaId)
      .eq("organization_id", ctx.organizationId);
    if (r.error) throw fromDbError(r.error, "Service area");
    const d = await db
      .from("service_area_rules")
      .delete()
      .eq("service_area_id", areaId)
      .eq("organization_id", ctx.organizationId);
    if (d.error) throw fromDbError(d.error, "Service area");
  } else {
    const r = await db
      .from("service_areas")
      .insert({ organization_id: ctx.organizationId, ...row })
      .select("id")
      .single();
    if (r.error) throw fromDbError(r.error, "Service area");
    areaId = r.data.id;
  }
  const rules = [
    ...[...new Set(input.postalCodes)].map((postal_code) => ({
      rule_type: "postal_code",
      postal_code,
      city: null,
      state: null,
    })),
    ...input.cities.map((c) => ({
      rule_type: "city",
      postal_code: null,
      city: c.city,
      state: c.state,
    })),
  ].map((r) => ({ organization_id: ctx.organizationId, service_area_id: areaId, ...r }));
  const ins = await db.from("service_area_rules").insert(rules);
  if (ins.error) throw fromDbError(ins.error, "Service area");
}

export async function deleteServiceArea(id: string): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const db = await createUserClient();
  const { error } = await db
    .from("service_areas")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Service area");
}

// ───────────── tax ─────────────

export async function listTaxJurisdictions() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("tax_jurisdictions")
    .select(
      "id, name, state, postal_codes, requires_review_postal_codes, status, priority, is_active, revision, tax_rates(id, name, rate_bps, valid_from, valid_to), tax_component_rules(component, taxable)",
    )
    .eq("organization_id", ctx.organizationId)
    .order("state")
    .order("name");
  if (error) throw fromDbError(error, "Tax jurisdiction");
  return data;
}

const jurisdictionInput = z.object({
  id: z.uuid().nullish(),
  name: z.string().trim().min(1).max(120),
  state: z.string().regex(/^[A-Z]{2}$/, "Use the two-letter state code."),
  postalCodes: z.array(z.string().regex(/^\d{5}$/)).max(1000),
  reviewPostalCodes: z.array(z.string().regex(/^\d{5}$/)).max(1000),
  status: z.enum(["test", "active"]),
  priority: z.int().min(-1000).max(1000).default(0),
  rates: z
    .array(z.object({ name: z.string().trim().min(1).max(120), rateBps: z.int().min(0).max(5000) }))
    .max(10),
  taxability: z.partialRecord(z.enum(TAX_COMPONENTS), z.boolean()),
});

/** Saves a jurisdiction with its rates and per-component taxability (replaces rates/taxability). */
export async function saveTaxJurisdiction(raw: unknown): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const input = jurisdictionInput.parse(raw);
  const db = await createUserClient();
  const row = {
    name: input.name,
    state: input.state,
    postal_codes: [...new Set(input.postalCodes)],
    requires_review_postal_codes: [...new Set(input.reviewPostalCodes)],
    status: input.status,
    priority: input.priority,
  };
  let jid = input.id ?? null;
  if (jid) {
    const r = await db
      .from("tax_jurisdictions")
      .update(row)
      .eq("id", jid)
      .eq("organization_id", ctx.organizationId);
    if (r.error) throw fromDbError(r.error, "Tax jurisdiction");
    for (const table of ["tax_rates", "tax_component_rules"] as const) {
      const d = await db
        .from(table)
        .delete()
        .eq("jurisdiction_id", jid)
        .eq("organization_id", ctx.organizationId);
      if (d.error) throw fromDbError(d.error, "Tax jurisdiction");
    }
  } else {
    const r = await db
      .from("tax_jurisdictions")
      .insert({ organization_id: ctx.organizationId, ...row })
      .select("id")
      .single();
    if (r.error) throw fromDbError(r.error, "Tax jurisdiction");
    jid = r.data.id;
  }
  if (input.rates.length > 0) {
    const r = await db.from("tax_rates").insert(
      input.rates.map((rate) => ({
        organization_id: ctx.organizationId,
        jurisdiction_id: jid,
        name: rate.name,
        rate_bps: rate.rateBps,
      })),
    );
    if (r.error) throw fromDbError(r.error, "Tax rate");
  }
  const rules = Object.entries(input.taxability).map(([component, taxable]) => ({
    organization_id: ctx.organizationId,
    jurisdiction_id: jid,
    component: component as (typeof TAX_COMPONENTS)[number],
    taxable,
  }));
  if (rules.length > 0) {
    const r = await db.from("tax_component_rules").insert(rules);
    if (r.error) throw fromDbError(r.error, "Tax rule");
  }
}

export async function deleteTaxJurisdiction(id: string): Promise<void> {
  const ctx = await requireStaff("pricing.write");
  const db = await createUserClient();
  const { error } = await db
    .from("tax_jurisdictions")
    .delete()
    .eq("id", z.uuid().parse(id))
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Tax jurisdiction");
}
