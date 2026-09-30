import { createPublicClient } from "@/server/db/public";
import { getServerEnv } from "@/server/env";
import { IMAGE_WIDTHS } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVABLE = /^(image\/(jpeg|png|webp|avif)|video\/mp4)$/;

const notFound = () =>
  new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

/** `?w=` must be one of the fixed derivative widths; anything else is refused (no arbitrary sizes). */
function requestedWidth(url: URL): number | null | "invalid" {
  const raw = url.searchParams.get("w");
  if (raw === null) return null;
  const w = Number(raw);
  return (IMAGE_WIDTHS as readonly number[]).includes(w) ? w : "invalid";
}

/**
 * Product media for the storefront (ADR 0016). The id must be a published, rights-verified media
 * item of the host-resolved tenant (anon-safe view); the object is then read with the anonymous
 * client, which the storage policy allows for exactly those objects. No service role.
 *
 * `?w=<width>` (one of IMAGE_WIDTHS) serves a width-bounded image through Supabase Storage image
 * transformations when STOREFRONT_IMAGE_TRANSFORMS=on (§13); otherwise the original is served.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const tenant = await getRequestTenant();
  const { id } = await params;
  const width = requestedWidth(new URL(request.url));
  if (!tenant || !UUID.test(id) || width === "invalid") return notFound();

  const db = createPublicClient();
  const { data, error } = await db
    .from("public_catalog_product_media")
    .select("storage_path, kind")
    .eq("organization_id", tenant.organizationId)
    .eq("id", id)
    .maybeSingle();
  if (error || !data?.storage_path) return notFound();

  const transform =
    width !== null && data.kind === "image" && getServerEnv().STOREFRONT_IMAGE_TRANSFORMS === "on"
      ? { transform: { width } }
      : undefined;
  const file = await db.storage.from("product-media").download(data.storage_path, transform);
  if (file.error) return notFound();
  const type = SERVABLE.test(file.data.type) ? file.data.type : "application/octet-stream";
  return new Response(file.data, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400",
      Vary: "Host",
      ...(type === "application/octet-stream" ? { "Content-Disposition": "attachment" } : {}),
    },
  });
}
