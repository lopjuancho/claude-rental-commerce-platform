import "server-only";
import { categoryInputSchema } from "@/domain/catalog/schemas";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { fromDbError } from "./errors";

export async function listCategories() {
  const ctx = await requireStaff("org.read");
  const db = await createUserClient();
  const { data, error } = await db
    .from("categories")
    .select(
      "id, parent_id, name, slug, description, sort_order, is_published, setup_buffer_minutes, teardown_buffer_minutes, included_duration_minutes, overnight_allowed, wind_sensitive, wind_threshold_mph, archived_at",
    )
    .eq("organization_id", ctx.organizationId)
    .is("archived_at", null)
    .order("sort_order")
    .order("name");
  if (error) throw fromDbError(error, "Category");
  return data;
}

export type CategoryRow = Awaited<ReturnType<typeof listCategories>>[number];

function toRow(input: ReturnType<typeof categoryInputSchema.parse>) {
  return {
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    parent_id: input.parentId ?? null,
    sort_order: input.sortOrder,
    is_published: input.isPublished,
    setup_buffer_minutes: input.setupBufferMinutes ?? null,
    teardown_buffer_minutes: input.teardownBufferMinutes ?? null,
    included_duration_minutes: input.includedDurationMinutes ?? null,
    overnight_allowed: input.overnightAllowed ?? null,
    wind_sensitive: input.windSensitive ?? null,
    wind_threshold_mph: input.windThresholdMph ?? null,
  };
}

export async function createCategory(raw: unknown): Promise<string> {
  const ctx = await requireStaff("catalog.write");
  const input = categoryInputSchema.parse(raw);
  const db = await createUserClient();
  const { data, error } = await db
    .from("categories")
    .insert({ organization_id: ctx.organizationId, ...toRow(input) })
    .select("id")
    .single();
  if (error) throw fromDbError(error, "Category");
  return data.id;
}

export async function updateCategory(id: string, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = categoryInputSchema.parse(raw);
  const db = await createUserClient();
  const { error } = await db
    .from("categories")
    .update(toRow(input))
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Category");
}

export async function archiveCategory(id: string): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { error } = await db
    .from("categories")
    .update({ archived_at: new Date().toISOString(), is_published: false })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Category");
}
