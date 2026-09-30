import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/storefront/json-ld";
import {
  Breadcrumbs,
  Container,
  CtaLink,
  EmptyState,
  Pagination,
  pageParam,
  ProductGrid,
} from "@/components/storefront/ui";
import { breadcrumbJsonLd } from "@/domain/storefront/seo";
import { getSeo, storefrontMetadata } from "@/server/public/site";
import { getShell, loadProductPage } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Params = Promise<{ slug: string }>;
type Search = Promise<{ page?: string | string[] }>;

/**
 * The category must be a published category of the host's tenant (the tenant's complete category
 * list, read with pagination); anything else is a 404.
 */
async function context(params: Params, searchParams: Search) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const [store, { slug }, query] = await Promise.all([getShell(tenant), params, searchParams]);
  const category = store.categories.find((c) => c.slug === slug);
  if (!category) notFound();
  return { tenant, store, category, page: pageParam(query.page) };
}

const pageHref = (slug: string, page: number) =>
  page > 1 ? `/categories/${slug}?page=${String(page)}` : `/categories/${slug}`;

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}): Promise<Metadata> {
  const { tenant, category, page } = await context(params, searchParams);
  return storefrontMetadata({
    tenant,
    path: pageHref(category.slug, page),
    title: `${category.name} rentals${page > 1 ? ` — page ${String(page)}` : ""} | ${tenant.name}`,
    description:
      category.description ??
      `${category.name} rentals from ${tenant.name}. Get an itemized quote online.`,
    imagePath: category.image?.url ?? null,
  });
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: Search;
}) {
  const { tenant, store, category, page } = await context(params, searchParams);
  const { products, pageCount } = await loadProductPage(tenant, { page, categoryId: category.id });
  if (page > pageCount) notFound();
  const others = store.categories.filter((c) => c.id !== category.id && c.productCount > 0);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rentals", path: "/rentals" },
    { name: category.name, path: `/categories/${category.slug}` },
  ];
  const { canonicalOrigin } = await getSeo(tenant);

  return (
    <Container className="grid gap-8 py-8 sm:py-12">
      {canonicalOrigin ? <JsonLd data={breadcrumbJsonLd(canonicalOrigin, crumbs)} /> : null}
      <Breadcrumbs crumbs={crumbs} />
      <header className="grid max-w-3xl gap-3">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{category.name}</h1>
        {category.description ? (
          <p className="text-lg text-muted-foreground">{category.description}</p>
        ) : null}
      </header>

      {products.length ? (
        <>
          <ProductGrid products={products} currency={tenant.currency} eager={3} />
          <Pagination page={page} pageCount={pageCount} href={(p) => pageHref(category.slug, p)} />
        </>
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
