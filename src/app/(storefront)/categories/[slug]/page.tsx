import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/storefront/json-ld";
import {
  Breadcrumbs,
  Container,
  CtaLink,
  EmptyState,
  ProductGrid,
} from "@/components/storefront/ui";
import { breadcrumbJsonLd } from "@/domain/storefront/seo";
import { siteOrigin, storefrontMetadata } from "@/server/public/site";
import { getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Params = Promise<{ slug: string }>;

/** The category must be a published category of the host's tenant; anything else is a 404. */
async function context(params: Params) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const store = await getStorefront(tenant);
  const { slug } = await params;
  const category = store.categories.find((c) => c.slug === slug);
  if (!category) notFound();
  return { tenant, store, category };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenant, store, category } = await context(params);
  return storefrontMetadata({
    tenant,
    store,
    path: `/categories/${category.slug}`,
    title: `${category.name} rentals | ${tenant.name}`,
    description:
      category.description ??
      `${category.name} rentals from ${tenant.name}. Get an itemized quote online.`,
    imagePath: category.image?.url ?? null,
  });
}

export default async function CategoryPage({ params }: { params: Params }) {
  const { tenant, store, category } = await context(params);
  const products = store.products.filter((p) => p.categoryIds.includes(category.id));
  const others = store.categories.filter((c) => c.id !== category.id && c.productCount > 0);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rentals", path: "/rentals" },
    { name: category.name, path: `/categories/${category.slug}` },
  ];

  return (
    <Container className="grid gap-8 py-8 sm:py-12">
      <JsonLd data={breadcrumbJsonLd(await siteOrigin(tenant), crumbs)} />
      <Breadcrumbs crumbs={crumbs} />
      <header className="grid max-w-3xl gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{category.name}</h1>
        {category.description ? (
          <p className="text-lg text-muted-foreground">{category.description}</p>
        ) : null}
      </header>

      {products.length ? (
        <ProductGrid products={products} currency={tenant.currency} eager={3} />
      ) : (
        <EmptyState title="Nothing here yet">
          <p>Tell us about your event and we&apos;ll put together a quote.</p>
          <div className="mt-4 flex justify-center">
            <CtaLink href="/quote">Get a quote</CtaLink>
          </div>
        </EmptyState>
      )}

      {others.length ? (
        <nav aria-label="Other categories" className="grid gap-3 border-t pt-8">
          <h2 className="text-lg font-bold">More to rent</h2>
          <ul className="flex flex-wrap gap-2">
            {others.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/categories/${c.slug}` as Route}
                  className="inline-flex min-h-10 items-center rounded-full border-2 px-4 text-sm font-semibold hover:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
                >
                  {c.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </Container>
  );
}
