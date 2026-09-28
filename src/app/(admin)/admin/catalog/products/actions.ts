"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { slugify } from "@/domain/catalog/slug";
import { toFormError } from "@/server/actions";
import {
  deleteMedia,
  setPrimaryMedia,
  updateMediaRights,
  uploadProductMedia,
} from "@/server/catalog/media";
import {
  addInventoryUnit,
  archiveProduct,
  createProduct,
  setInventoryUnitStatus,
  setVariantInventory,
  updateProduct,
} from "@/server/catalog/products";
import { readHazardRuleForm, saveHazardRules } from "@/server/catalog/weather-rules";
import { FormReader } from "@/server/forms";

function readProduct(fd: FormData) {
  const f = new FormReader(fd);
  const name = f.text("name") ?? "";
  const categoryIds = f.all("categoryIds");
  return {
    name,
    slug: f.text("slug") ?? slugify(name),
    shortDescription: f.text("shortDescription"),
    description: f.text("description"),
    categoryIds,
    primaryCategoryId: f.text("primaryCategoryId") ?? categoryIds[0] ?? null,
    isPublished: f.checkbox("isPublished"),
    isFeatured: f.checkbox("isFeatured"),
    sortOrder: f.int("sortOrder") ?? 0,
    pricingType: f.text("pricingType") ?? "per_event",
    basePriceCents: f.cents("basePrice"),
    includedDurationMinutes: f.hoursAsMinutes("includedHours"),
    minimumRentalMinutes: f.hoursAsMinutes("minimumHours"),
    setupBufferMinutes: f.int("setupBufferMinutes"),
    teardownBufferMinutes: f.int("teardownBufferMinutes"),
    minBookingLeadTimeMinutes: f.hoursAsMinutes("leadTimeHours"),
    overnightAllowed: f.triState("overnightAllowed"),
    wetAllowed: f.checkbox("wetAllowed"),
    dryAllowed: f.checkbox("dryAllowed"),
    minimumAge: f.int("minimumAge"),
    maximumAge: f.int("maximumAge"),
    recommendedCapacity: f.int("recommendedCapacity"),
    maxRiderWeightLbs: f.int("maxRiderWeightLbs"),
    idealEventTypes: f.all("idealEventTypes"),
    indoorAllowed: f.checkbox("indoorAllowed"),
    outdoorAllowed: f.checkbox("outdoorAllowed"),
    allowedSurfaces: f.all("allowedSurfaces"),
    spaceLengthFt: f.decimal("spaceLengthFt"),
    spaceWidthFt: f.decimal("spaceWidthFt"),
    spaceHeightFt: f.decimal("spaceHeightFt"),
    powerOutletsRequired: f.int("powerOutletsRequired"),
    powerNotes: f.text("powerNotes"),
    waterRequired: f.checkbox("waterRequired"),
    operatorRequired: f.checkbox("operatorRequired"),
    attendantsRequired: f.int("attendantsRequired") ?? 0,
    setupMinutes: f.int("setupMinutes"),
    teardownMinutes: f.int("teardownMinutes"),
    setupRequirements: f.text("setupRequirements"),
    anchoringMethods: f.all("anchoringMethods"),
    tags: f.list("tags"),
    internalNotes: f.text("internalNotes"),
  };
}

export async function saveProductAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let createdId: string | null = null;
  try {
    const id = new FormReader(fd).text("id");
    if (id) {
      await updateProduct(z.uuid().parse(id), readProduct(fd));
      await saveHazardRules({ level: "product", productId: id }, readHazardRuleForm(fd));
      revalidatePath(`/admin/catalog/products/${id}`);
      revalidatePath("/admin/catalog");
      return { status: "success", message: "Product saved." };
    }
    createdId = await createProduct(readProduct(fd));
    await saveHazardRules({ level: "product", productId: createdId }, readHazardRuleForm(fd));
  } catch (error) {
    return toFormError(error);
  }
  revalidatePath("/admin/catalog");
  redirect(`/admin/catalog/products/${createdId}` as Route);
}

export async function archiveProductAction(fd: FormData): Promise<void> {
  await archiveProduct(z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/catalog");
  redirect("/admin/catalog");
}

export async function setInventoryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const productId = z.uuid().parse(f.text("productId"));
    const trackingMode = f.text("trackingMode");
    await setVariantInventory(z.uuid().parse(f.text("variantId")), {
      trackingMode,
      ...(trackingMode === "pooled" ? { pooledQuantity: f.int("pooledQuantity") ?? 0 } : {}),
    });
    revalidatePath(`/admin/catalog/products/${productId}`);
    return { status: "success", message: "Inventory saved." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function addUnitAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    await addInventoryUnit({
      variantId: f.text("variantId"),
      label: f.text("label"),
      serialNumber: f.text("serialNumber"),
    });
    revalidatePath(`/admin/catalog/products/${z.uuid().parse(f.text("productId"))}`);
    return { status: "success", message: "Unit added." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function setUnitStatusAction(fd: FormData): Promise<void> {
  const f = new FormReader(fd);
  await setInventoryUnitStatus(
    z.uuid().parse(f.text("unitId")),
    z.enum(["active", "retired"]).parse(f.text("status")),
  );
  revalidatePath(`/admin/catalog/products/${z.uuid().parse(f.text("productId"))}`);
}

export async function uploadMediaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const f = new FormReader(fd);
    const file = fd.get("file");
    if (!(file instanceof File)) return { status: "error", message: "Choose a file to upload." };
    const productId = z.uuid().parse(f.text("productId"));
    await uploadProductMedia(file, {
      productId,
      altText: f.text("altText"),
      rightsStatus: f.text("rightsStatus"),
      rightsNotes: f.text("rightsNotes"),
    });
    revalidatePath(`/admin/catalog/products/${productId}`);
    return { status: "success", message: "Uploaded." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function updateMediaAction(fd: FormData): Promise<void> {
  const f = new FormReader(fd);
  const productId = z.uuid().parse(f.text("productId"));
  const mediaId = z.uuid().parse(f.text("mediaId"));
  const intent = f.text("intent");
  if (intent === "delete") await deleteMedia(mediaId);
  else if (intent === "primary") await setPrimaryMedia(productId, mediaId);
  else
    await updateMediaRights(mediaId, {
      rightsStatus: f.text("rightsStatus"),
      rightsNotes: f.text("rightsNotes"),
      altText: f.text("altText"),
    });
  revalidatePath(`/admin/catalog/products/${productId}`);
}
