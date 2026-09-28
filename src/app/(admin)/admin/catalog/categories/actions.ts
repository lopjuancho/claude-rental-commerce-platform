"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { slugify } from "@/domain/catalog/slug";
import { toFormError } from "@/server/actions";
import { archiveCategory, createCategory, updateCategory } from "@/server/catalog/categories";
import { readHazardRuleForm, saveHazardRules } from "@/server/catalog/weather-rules";
import { FormReader } from "@/server/forms";

function readCategory(fd: FormData) {
  const f = new FormReader(fd);
  const name = f.text("name") ?? "";
  return {
    name,
    slug: f.text("slug") ?? slugify(name),
    description: f.text("description"),
    parentId: f.text("parentId"),
    sortOrder: f.int("sortOrder") ?? 0,
    isPublished: f.checkbox("isPublished"),
    setupBufferMinutes: f.int("setupBufferMinutes"),
    teardownBufferMinutes: f.int("teardownBufferMinutes"),
    includedDurationMinutes: f.hoursAsMinutes("includedHours"),
    overnightAllowed: f.triState("overnightAllowed"),
  };
}

export async function saveCategoryAction(_prev: FormState, fd: FormData): Promise<FormState> {
  try {
    const id = new FormReader(fd).text("id");
    const categoryId = id ? z.uuid().parse(id) : null;
    if (categoryId) await updateCategory(categoryId, readCategory(fd));
    const savedId = categoryId ?? (await createCategory(readCategory(fd)));
    await saveHazardRules({ level: "category", categoryId: savedId }, readHazardRuleForm(fd));
    revalidatePath("/admin/catalog/categories");
    return { status: "success", message: id ? "Category saved." : "Category created." };
  } catch (error) {
    return toFormError(error);
  }
}

export async function archiveCategoryAction(fd: FormData): Promise<void> {
  await archiveCategory(z.uuid().parse(fd.get("id")));
  revalidatePath("/admin/catalog/categories");
}
