import "server-only";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import {
  hazardRuleInputSchema,
  THRESHOLD_UNITS,
  WEATHER_HAZARDS,
  type WeatherHazard,
} from "@/domain/weather/hazards";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { fromDbError } from "./errors";

export type RuleScope =
  | { level: "organization" }
  | { level: "category"; categoryId: string }
  | { level: "product"; productId: string };

export interface HazardRuleRow {
  hazard: WeatherHazard;
  sensitive: boolean;
  threshold_value: number | null;
  threshold_unit: string | null;
}

/** Form contract: weather.<hazard>.mode = inherit|yes|no, .value, .unit */
export function readHazardRuleForm(fd: FormData) {
  return WEATHER_HAZARDS.map((hazard) => {
    const mode = fd.get(`weather.${hazard}.mode`);
    const rawValue = fd.get(`weather.${hazard}.value`);
    const unit = fd.get(`weather.${hazard}.unit`);
    const value = typeof rawValue === "string" && rawValue.trim() !== "" ? Number(rawValue) : null;
    return {
      hazard,
      mode: mode === "yes" || mode === "no" ? mode : ("inherit" as const),
      thresholdValue: value,
      thresholdUnit:
        value !== null &&
        typeof unit === "string" &&
        (THRESHOLD_UNITS as readonly string[]).includes(unit)
          ? unit
          : null,
    };
  });
}

export async function listHazardRules(scope: RuleScope): Promise<HazardRuleRow[]> {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  let query = db
    .from("weather_hazard_rules")
    .select("hazard, sensitive, threshold_value, threshold_unit")
    .eq("organization_id", ctx.organizationId);
  query =
    scope.level === "product"
      ? query.eq("product_id", scope.productId)
      : scope.level === "category"
        ? query.eq("category_id", scope.categoryId).is("product_id", null)
        : query.is("category_id", null).is("product_id", null);
  const { data, error } = await query;
  if (error) throw fromDbError(error, "Weather rule");
  return data;
}

const formRules = z.array(
  z.object({
    hazard: z.enum(WEATHER_HAZARDS),
    mode: z.enum(["inherit", "yes", "no"]),
    thresholdValue: z.number().nullable(),
    thresholdUnit: z.string().nullable(),
  }),
);

/** Replaces the rules at one scope. "inherit" removes the rule so the next level applies. */
export async function saveHazardRules(scope: RuleScope, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const rules = formRules.parse(raw);
  const db = await createUserClient();
  const scopeCols = {
    category_id: scope.level === "category" ? scope.categoryId : null,
    product_id: scope.level === "product" ? scope.productId : null,
  };

  for (const r of rules) {
    let del = db
      .from("weather_hazard_rules")
      .delete()
      .eq("organization_id", ctx.organizationId)
      .eq("hazard", r.hazard);
    del = scopeCols.product_id
      ? del.eq("product_id", scopeCols.product_id)
      : del.is("product_id", null);
    del = scopeCols.category_id
      ? del.eq("category_id", scopeCols.category_id)
      : del.is("category_id", null);
    const removed = await del;
    if (removed.error) throw fromDbError(removed.error, "Weather rule");
    if (r.mode === "inherit") continue;

    const input = hazardRuleInputSchema.safeParse({
      hazard: r.hazard,
      sensitive: r.mode === "yes",
      thresholdValue: r.mode === "yes" ? r.thresholdValue : null,
      thresholdUnit: r.mode === "yes" ? r.thresholdUnit : null,
    });
    if (!input.success)
      throw new DomainError(
        "INVALID_INPUT",
        `${r.hazard}: ${input.error.issues[0]?.message ?? "invalid rule"}`,
      );
    const { error } = await db.from("weather_hazard_rules").insert({
      organization_id: ctx.organizationId,
      ...scopeCols,
      hazard: input.data.hazard,
      sensitive: input.data.sensitive,
      threshold_value: input.data.thresholdValue ?? null,
      threshold_unit: input.data.thresholdUnit ?? null,
    });
    if (error) throw fromDbError(error, "Weather rule");
  }
}

/** Category-level rules for every category of the active organization, keyed by category id. */
export async function listCategoryHazardRules(): Promise<Map<string, HazardRuleRow[]>> {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("weather_hazard_rules")
    .select("category_id, hazard, sensitive, threshold_value, threshold_unit")
    .eq("organization_id", ctx.organizationId)
    .not("category_id", "is", null);
  if (error) throw fromDbError(error, "Weather rule");
  const map = new Map<string, HazardRuleRow[]>();
  for (const { category_id, ...rule } of data) {
    if (!category_id) continue;
    map.set(category_id, [...(map.get(category_id) ?? []), rule]);
  }
  return map;
}
