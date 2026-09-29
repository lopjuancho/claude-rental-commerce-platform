"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { AVAILABILITY_REASONS, isAvailabilityReason } from "@/domain/availability/reasons";
import { toFormError } from "@/server/actions";
import {
  checkAvailability,
  confirmReservation,
  confirmWeatherBlock,
  createBlock,
  createStaffReservation,
  deleteBlock,
  deleteProposedWeatherBlock,
  liftWeatherBlock,
  proposeWeatherBlock,
  releaseReservation,
  resolveFlag,
} from "@/server/availability/service";
import { FormReader } from "@/server/forms";

function period(f: FormReader) {
  return {
    date: f.text("date"),
    startTime: f.text("startTime"),
    endTime: f.text("endTime"),
    ...(f.text("endDate") ? { endDate: f.text("endDate") } : {}),
    ...(f.text("fold") ? { fold: f.text("fold") } : {}),
  };
}

export interface CheckState extends FormState {
  result?: { available: boolean; availableQuantity: number; capacity: number; reasons: string[] };
}

export async function checkAction(_prev: CheckState, fd: FormData): Promise<CheckState> {
  try {
    const f = new FormReader(fd);
    const r = await checkAvailability({
      variantId: f.text("variantId"),
      quantity: f.int("quantity") ?? 1,
      overrideLeadTime: f.checkbox("overrideLeadTime"),
      period: period(f),
    });
    const reasons = r.reasons.map((x) => (isAvailabilityReason(x) ? AVAILABILITY_REASONS[x] : x));
    return {
      status: "success",
      message: r.available ? "Available." : "Not available.",
      result: {
        available: r.available,
        availableQuantity: r.available_quantity,
        capacity: r.capacity,
        reasons,
      },
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function bookAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    await createStaffReservation({
      variantId: f.text("variantId"),
      quantity: f.int("quantity") ?? 1,
      status: f.text("status") === "held" ? "held" : "confirmed",
      overrideLeadTime: f.checkbox("overrideLeadTime"),
      notes: f.text("notes"),
      period: period(f),
    });
    revalidatePath("/admin/availability");
    return { status: "success", message: "Reservation created." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function reservationAction(fd: FormData): Promise<void> {
  const f = new FormReader(fd);
  const id = z.uuid().parse(f.text("reservationId"));
  const intent = f.text("intent");
  if (intent === "confirm") await confirmReservation(id);
  else if (intent === "release") await releaseReservation(id);
  revalidatePath("/admin/availability");
}

export async function resolveFlagAction(fd: FormData): Promise<void> {
  await resolveFlag(z.uuid().parse(fd.get("flagId")));
  revalidatePath("/admin/availability");
}

export async function createBlockAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const target = f.text("target") ?? "organization";
    const [kind, id] = target.split(":");
    await createBlock({
      scope:
        kind === "product"
          ? "product"
          : kind === "unit"
            ? "unit"
            : kind === "variant"
              ? "variant_quantity"
              : "organization",
      productId: kind === "product" ? id : null,
      unitId: kind === "unit" ? id : null,
      variantId: kind === "variant" ? id : null,
      quantity: f.int("quantity"),
      reason: f.text("reason"),
      notes: f.text("notes"),
      period: period(f),
    });
    revalidatePath("/admin/availability/blocks");
    revalidatePath("/admin/availability");
    return {
      status: "success",
      message: "Block added. Overlapping bookings (if any) were flagged for review.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function deleteBlockAction(fd: FormData): Promise<void> {
  await deleteBlock(z.uuid().parse(fd.get("blockId")));
  revalidatePath("/admin/availability/blocks");
}

export async function proposeWeatherAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    await proposeWeatherBlock({
      hazard: f.text("hazard"),
      scope: f.text("scope"),
      reason: f.text("reason"),
      observedValue: f.decimal("observedValue"),
      observedUnit: f.text("observedUnit"),
      categoryIds: f.all("categoryIds"),
      productIds: f.all("productIds"),
      period: period(f),
    });
    revalidatePath("/admin/availability/weather");
    return {
      status: "success",
      message: "Weather block proposed. Confirm it to make it take effect.",
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function weatherBlockAction(fd: FormData): Promise<void> {
  const f = new FormReader(fd);
  const id = z.uuid().parse(f.text("weatherBlockId"));
  const intent = f.text("intent");
  if (intent === "confirm") await confirmWeatherBlock(id);
  else if (intent === "lift") await liftWeatherBlock(id);
  else if (intent === "delete") await deleteProposedWeatherBlock(id);
  revalidatePath("/admin/availability/weather");
  revalidatePath("/admin/availability");
}
