import type { Metadata } from "next";
import { requireStaff } from "@/server/auth/context";
import { listCategories } from "@/server/catalog/categories";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "New product" };

export default async function NewProductPage() {
  await requireStaff("catalog.write");
  const categories = await listCategories();
  return (
    <div className="grid gap-5">
      <h1 className="text-2xl font-semibold">New product</h1>
      <ProductForm canWrite categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
    </div>
  );
}
