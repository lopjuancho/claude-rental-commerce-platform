import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCents } from "@/domain/money";
import { requireStaff } from "@/server/auth/context";
import { listProducts } from "@/server/catalog/products";

export const metadata: Metadata = { title: "Catalog" };

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requireStaff("org.read");
  const q = (await searchParams).q?.slice(0, 100) ?? "";
  const products = await listProducts(q ? { search: q } : {});
  const canWrite = ctx.permissions.has("catalog.write");

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Catalog</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/catalog/categories">Categories</Link>
        </Button>
        {canWrite ? (
          <>
            <Button asChild variant="outline" size="sm">
              <Link href="/admin/catalog/import">Import CSV</Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/admin/catalog/products/new">New product</Link>
            </Button>
          </>
        ) : null}
      </div>
      <form className="flex gap-2">
        <label htmlFor="q" className="sr-only">
          Search products
        </label>
        <Input id="q" name="q" defaultValue={q} placeholder="Search by name" />
        <Button type="submit" variant="outline">
          Search
        </Button>
      </form>
      {products.length === 0 ? (
        <p className="text-muted-foreground">
          {q ? "No products match." : "No products yet. Create one or import a CSV."}
        </p>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {products.map((p) => (
            <li key={p.id}>
              <Link
                href={`/admin/catalog/products/${p.id}`}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                <span className="text-sm tabular-nums">{formatCents(p.base_price_cents)}</span>
                <span className="w-16 text-right text-sm text-muted-foreground tabular-nums">
                  × {p.quantity}
                </span>
                <span
                  className={
                    p.is_published
                      ? "rounded-full bg-muted px-2 py-0.5 text-xs"
                      : "rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {p.is_published ? "Live" : "Draft"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
