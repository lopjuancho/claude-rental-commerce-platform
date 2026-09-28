"use server";

import type { Route } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { IMPORT_FIELD_KEYS } from "@/domain/import/fields";
import { toFormError } from "@/server/actions";
import {
  commitImport,
  saveMappingPreset,
  stageImport,
  validateImport,
} from "@/server/catalog/imports";
import { enforceRateLimit } from "@/server/rate-limit";
import { getClientIp } from "@/server/request";

export async function uploadImportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let batchId: string;
  try {
    const file = fd.get("file");
    if (!(file instanceof File)) return { status: "error", message: "Choose a CSV file." };
    await enforceRateLimit("publicWrite", `import:${await getClientIp()}`);
    const adapter = fd.get("adapterId");
    batchId = await stageImport(
      file,
      typeof adapter === "string" && adapter !== "auto" ? adapter : undefined,
    );
  } catch (error) {
    return toFormError(error);
  }
  redirect(`/admin/catalog/import/${batchId}` as Route);
}

export async function validateImportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const batchId = z.uuid().parse(fd.get("batchId"));
    const mapping: Record<string, string> = {};
    for (const key of IMPORT_FIELD_KEYS) {
      const column = fd.get(`map.${key}`);
      if (typeof column === "string" && column !== "") mapping[key] = column;
    }
    const summary = await validateImport(batchId, mapping);
    revalidatePath(`/admin/catalog/import/${batchId}`);
    return {
      status: "success",
      message: `Ready: ${summary.create} to create, ${summary.update} to update, ${summary.skip} skipped (${summary.errors} with errors).`,
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function commitImportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const batchId = z.uuid().parse(fd.get("batchId"));
    const result = await commitImport(batchId);
    revalidatePath(`/admin/catalog/import/${batchId}`);
    revalidatePath("/admin/catalog");
    return {
      status: "success",
      message: `Imported: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped.`,
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function savePresetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    await saveMappingPreset(z.uuid().parse(fd.get("batchId")), z.string().parse(fd.get("name")));
    return { status: "success", message: "Mapping saved." };
  } catch (error) {
    return toFormError(error);
  }
}
