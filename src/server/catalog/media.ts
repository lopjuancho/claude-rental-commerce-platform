import "server-only";
import { z } from "zod";
import { MEDIA_RIGHTS } from "@/domain/catalog/vocabulary";
import { DomainError } from "@/domain/errors";
import { ALLOWED_MEDIA, MAX_MEDIA_BYTES, sniffMediaType } from "@/domain/media/sniff";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";
import { fromDbError } from "./errors";

export const MEDIA_BUCKET = "product-media";

const uploadInput = z.object({
  productId: z.uuid(),
  altText: z.string().trim().max(300).nullish(),
  rightsStatus: z.enum(MEDIA_RIGHTS),
  rightsNotes: z.string().trim().max(1000).nullish(),
});

/**
 * Uploads a product photo/video under `{organization_id}/products/{product_id}/` (enforced again
 * by storage RLS and a CHECK constraint) and records ownership/rights metadata (ADR 0006).
 */
export async function uploadProductMedia(file: File, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = uploadInput.parse(raw);
  if (file.size === 0 || file.size > MAX_MEDIA_BYTES) {
    throw new DomainError("INVALID_INPUT", "Files must be between 1 byte and 10 MB.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffMediaType(bytes);
  if (!type)
    throw new DomainError(
      "INVALID_INPUT",
      "Only JPEG, PNG, WebP, AVIF images and MP4 videos are allowed.",
    );

  const db = await createUserClient();
  const product = await db
    .from("products")
    .select("id")
    .eq("id", input.productId)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (product.error) throw fromDbError(product.error, "Product");
  if (!product.data) throw new DomainError("NOT_FOUND", "Product not found.");

  const path = `${ctx.organizationId}/products/${input.productId}/${crypto.randomUUID()}.${ALLOWED_MEDIA[type].ext}`;
  const upload = await db.storage
    .from(MEDIA_BUCKET)
    .upload(path, bytes, { contentType: type, upsert: false });
  if (upload.error) throw new DomainError("INTERNAL", "Upload failed.", { cause: upload.error });

  const existing = await db
    .from("product_media")
    .select("id")
    .eq("product_id", input.productId)
    .limit(1);
  const { error } = await db.from("product_media").insert({
    organization_id: ctx.organizationId,
    product_id: input.productId,
    kind: ALLOWED_MEDIA[type].kind,
    storage_path: path,
    alt_text: input.altText ?? null,
    source: "upload",
    original_filename: file.name.slice(0, 255),
    rights_status: input.rightsStatus,
    rights_notes: input.rightsNotes ?? null,
    is_primary: (existing.data?.length ?? 0) === 0,
  });
  if (error) {
    await db.storage.from(MEDIA_BUCKET).remove([path]);
    throw fromDbError(error, "Media");
  }
}

export async function updateMediaRights(mediaId: string, raw: unknown): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const input = z
    .object({
      rightsStatus: z.enum(MEDIA_RIGHTS),
      rightsNotes: z.string().trim().max(1000).nullish(),
      altText: z.string().trim().max(300).nullish(),
    })
    .parse(raw);
  const db = await createUserClient();
  const { error } = await db
    .from("product_media")
    .update({
      rights_status: input.rightsStatus,
      rights_notes: input.rightsNotes ?? null,
      alt_text: input.altText ?? null,
    })
    .eq("id", mediaId)
    .eq("organization_id", ctx.organizationId);
  if (error) throw fromDbError(error, "Media");
}

export async function setPrimaryMedia(productId: string, mediaId: string): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const clear = await db
    .from("product_media")
    .update({ is_primary: false })
    .eq("product_id", productId)
    .eq("organization_id", ctx.organizationId);
  if (clear.error) throw fromDbError(clear.error, "Media");
  const set = await db
    .from("product_media")
    .update({ is_primary: true })
    .eq("id", mediaId)
    .eq("organization_id", ctx.organizationId);
  if (set.error) throw fromDbError(set.error, "Media");
}

export async function deleteMedia(mediaId: string): Promise<void> {
  const ctx = await requireStaff("catalog.write");
  const db = await createUserClient();
  const { data, error } = await db
    .from("product_media")
    .delete()
    .eq("id", mediaId)
    .eq("organization_id", ctx.organizationId)
    .select("storage_path");
  if (error) throw fromDbError(error, "Media");
  const paths = data.map((m) => m.storage_path);
  if (paths.length > 0) await db.storage.from(MEDIA_BUCKET).remove(paths);
}

/** Short-lived signed URLs for admin previews (the bucket is private). */
export async function signedMediaUrls(paths: string[]): Promise<Map<string, string>> {
  if (paths.length === 0) return new Map();
  const db = await createUserClient();
  const { data } = await db.storage.from(MEDIA_BUCKET).createSignedUrls(paths, 3600);
  return new Map(
    (data ?? []).flatMap((d) => (d.path && d.signedUrl ? [[d.path, d.signedUrl] as const] : [])),
  );
}
