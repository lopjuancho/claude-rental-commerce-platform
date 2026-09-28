import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isDomainError } from "@/domain/errors";
import { requireStaff } from "@/server/auth/context";
import { listCategories } from "@/server/catalog/categories";
import { signedMediaUrls } from "@/server/catalog/media";
import { getProduct, type ProductDetail } from "@/server/catalog/products";
import { archiveProductAction } from "../actions";
import { ProductForm } from "../product-form";
import { InventoryPanel } from "./inventory-panel";
import { MediaPanel } from "./media-panel";

export const metadata: Metadata = { title: "Product" };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaff("org.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  let product: ProductDetail;
  try {
    product = await getProduct(id);
  } catch (e) {
    if (isDomainError(e) && e.code === "NOT_FOUND") notFound();
    throw e;
  }
  const canWrite = ctx.permissions.has("catalog.write");
  const categories = await listCategories();
  const variant = product.product_variants.find((v) => v.is_default) ?? product.product_variants[0];
  const media = [...product.product_media].sort(
    (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order,
  );
  const urls = await signedMediaUrls(media.map((m) => m.storage_path));
  const {
    product_categories,
    product_variants: _variants,
    product_media: _media,
    ...row
  } = product;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/admin/catalog" className="text-sm text-muted-foreground hover:underline">
          ← Catalog
        </Link>
        <h1 className="mr-auto w-full text-2xl font-semibold sm:w-auto">{product.name}</h1>
        {canWrite ? (
          <form action={archiveProductAction}>
            <input type="hidden" name="id" value={product.id} />
            <Button type="submit" variant="outline" size="sm">
              Archive
            </Button>
          </form>
        ) : null}
      </div>
      <ProductForm
        canWrite={canWrite}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        values={{ ...row, categoryIds: product_categories.map((c) => c.category_id) }}
      />
      {variant ? (
        <Card>
          <CardHeader>
            <CardTitle>Inventory</CardTitle>
          </CardHeader>
          <CardContent>
            <InventoryPanel
              productId={product.id}
              variantId={variant.id}
              trackingMode={variant.tracking_mode}
              pooledQuantity={variant.pooled_quantity}
              units={variant.inventory_units.map((u) => ({
                id: u.id,
                label: u.label,
                serial_number: u.serial_number,
                status: u.status,
              }))}
              canWrite={canWrite}
            />
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Photos and videos</CardTitle>
        </CardHeader>
        <CardContent>
          <MediaPanel
            productId={product.id}
            canWrite={canWrite}
            media={media.map((m) => ({
              id: m.id,
              url: urls.get(m.storage_path) ?? null,
              kind: m.kind,
              alt_text: m.alt_text,
              is_primary: m.is_primary,
              rights_status: m.rights_status,
              rights_notes: m.rights_notes,
              original_filename: m.original_filename,
            }))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
