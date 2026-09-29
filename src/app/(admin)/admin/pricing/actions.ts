"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { localRentalPeriod } from "@/domain/availability/local-time";
import { DomainError } from "@/domain/errors";
import type { PriceResult } from "@/domain/pricing/types";
import { TAX_COMPONENTS } from "@/domain/pricing/types";
import { toFormError } from "@/server/actions";
import { getOrganizationTimezone } from "@/server/availability/service";
import { FormReader } from "@/server/forms";
import {
  deletePricingRule,
  deleteServiceArea,
  deleteTaxJurisdiction,
  saveDeliverySettings,
  savePricingRule,
  saveServiceArea,
  saveTaxJurisdiction,
} from "@/server/pricing/config";
import { priceForStaff } from "@/server/pricing/service";

const percentToBps = (v: number | null) =>
  v === null || Number.isNaN(v) ? v : Math.round(v * 100);
const splitList = (v: string | null) =>
  (v ?? "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

function ruleParams(f: FormReader, type: string): Record<string, unknown> {
  const amount = f.cents("amount");
  const percent = percentToBps(f.decimal("percent"));
  const out: Record<string, unknown> = {};
  switch (type) {
    case "extra_hour":
      out.amount_cents = amount;
      if (f.int("incrementMinutes") !== null) out.increment_minutes = f.int("incrementMinutes");
      break;
    case "overnight":
    case "additional_day":
      if (f.text("mode") === "percent") out.percent_of_base_bps = percent;
      else out.amount_cents = amount;
      break;
    case "attendant_fee":
      out.amount_cents = amount;
      out.per = f.text("per") ?? "event";
      break;
    case "fee":
      out.amount_cents = amount;
      out.per = f.text("per") === "unit" ? "unit" : "order";
      if (f.text("label")) out.label = f.text("label");
      break;
    case "discount_percent":
      out.percent_bps = percent;
      if (f.int("minQuantity") !== null) out.min_quantity = f.int("minQuantity");
      break;
    case "discount_fixed":
    case "minimum_charge":
      out.amount_cents = amount;
      break;
  }
  return out;
}

export async function saveRuleAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const type = f.text("type") ?? "";
    const scope = f.text("scope") ?? "organization";
    const [kind, id] = scope.split(":");
    await savePricingRule({
      id: f.text("id"),
      name: f.text("name"),
      type,
      scope: kind === "category" || kind === "product" ? kind : "organization",
      categoryId: kind === "category" ? id : null,
      productId: kind === "product" ? id : null,
      params: ruleParams(f, type),
      priority: f.int("priority") ?? 0,
      discountCode: f.text("discountCode"),
      validFrom: f.text("validFrom"),
      validTo: f.text("validTo"),
      active: f.checkbox("active"),
    });
    revalidatePath("/admin/pricing");
    return {
      status: "success",
      message: "Rule saved. Existing quotes keep the prices they were calculated with.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function deleteRuleAction(fd: FormData): Promise<void> {
  await deletePricingRule(z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/pricing");
}

export async function saveDeliveryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const line1 = f.text("depotLine1");
    await saveDeliverySettings({
      depot: line1
        ? {
            line1,
            city: f.text("depotCity"),
            state: f.text("depotState")?.toUpperCase(),
            postalCode: f.text("depotPostalCode"),
          }
        : null,
      freeMiles: f.decimal("freeMiles"),
      perMileRateCents: f.cents("perMileRate"),
      maximumMiles: f.decimal("maximumMiles"),
      rounding: f.text("rounding"),
      basis: f.text("basis"),
    });
    revalidatePath("/admin/pricing/delivery");
    return { status: "success", message: "Delivery settings saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function saveAreaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const cities = (f.text("cities") ?? "")
      .split(/\n|;/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const m = /^(.+?),\s*([A-Za-z]{2})$/.exec(line);
        if (!m?.[1] || !m[2])
          throw new DomainError("INVALID_INPUT", `Write cities as "City, ST" (got "${line}").`);
        return { city: m[1].trim(), state: m[2].toUpperCase() };
      });
    await saveServiceArea({
      id: f.text("id"),
      name: f.text("name"),
      pricing: f.text("pricing"),
      flatFeeCents: f.cents("flatFee"),
      priority: f.int("priority") ?? 0,
      active: f.checkbox("active"),
      postalCodes: splitList(f.text("postalCodes")),
      cities,
    });
    revalidatePath("/admin/pricing/delivery");
    return { status: "success", message: "Service area saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function deleteAreaAction(fd: FormData): Promise<void> {
  await deleteServiceArea(z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/pricing/delivery");
}

export async function saveTaxAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const rates = [0, 1, 2]
      .map((i) => ({
        name: f.text(`rateName${i}`),
        bps: percentToBps(f.decimal(`ratePercent${i}`)),
      }))
      .filter((r) => r.name || r.bps !== null)
      .map((r) => ({ name: r.name ?? "Rate", rateBps: r.bps }));
    const taxability: Record<string, boolean> = {};
    for (const c of TAX_COMPONENTS) {
      const v = f.text(`taxable.${c}`);
      if (v === "yes" || v === "no") taxability[c] = v === "yes";
    }
    await saveTaxJurisdiction({
      id: f.text("id"),
      name: f.text("name"),
      state: f.text("state")?.toUpperCase(),
      postalCodes: splitList(f.text("postalCodes")),
      reviewPostalCodes: splitList(f.text("reviewPostalCodes")),
      status: f.text("status"),
      priority: f.int("priority") ?? 0,
      rates,
      taxability,
    });
    revalidatePath("/admin/pricing/tax");
    return { status: "success", message: "Tax configuration saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function deleteTaxAction(fd: FormData): Promise<void> {
  await deleteTaxJurisdiction(z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/pricing/tax");
}

export interface CalcState extends FormState {
  result?: PriceResult;
  calculationId?: string | null;
}

export async function calculateAction(_prev: CalcState, fd: FormData): Promise<CalcState> {
  try {
    const f = new FormReader(fd);
    const timeZone = await getOrganizationTimezone();
    const period = localRentalPeriod({
      date: f.text("date") ?? "",
      startTime: f.text("startTime") ?? "",
      endTime: f.text("endTime") ?? "",
      ...(f.text("endDate") ? { endDate: f.text("endDate") ?? "" } : {}),
      timeZone,
    });
    const items = [0, 1, 2, 3]
      .map((i) => ({
        variantId: f.text(`variant${i}`),
        quantity: f.int(`quantity${i}`) ?? 1,
        kind: f.checkbox(`addon${i}`) ? "add_on" : "rental",
      }))
      .filter((i) => i.variantId)
      .map((i) => ({ ...i, start: period.start.toISOString(), end: period.end.toISOString() }));
    const line1 = f.text("line1");
    const adjustment = f.cents("adjustment");
    const run = await priceForStaff(
      {
        items,
        eventAddress: line1
          ? {
              line1,
              city: f.text("city"),
              state: f.text("state")?.toUpperCase(),
              postalCode: f.text("postalCode"),
            }
          : null,
        discountCodes: splitList(f.text("codes")),
        adjustments: adjustment
          ? [
              {
                label: f.text("adjustmentLabel") ?? "Manual adjustment",
                amountCents: adjustment * (f.checkbox("adjustmentCredit") ? -1 : 1),
              },
            ]
          : [],
      },
      { save: f.checkbox("save") },
    );
    return { status: "success", result: run.output, calculationId: run.calculationId };
  } catch (error) {
    if (error instanceof RangeError) return { status: "error", message: error.message };
    return toFormError(error);
  }
}
