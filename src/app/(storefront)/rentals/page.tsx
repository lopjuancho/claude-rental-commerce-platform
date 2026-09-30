import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
import { humanize } from "@/domain/storefront/catalog";
import { breadcrumbJsonLd } from "@/domain/storefront/seo";
import { cn } from "@/lib/utils";
import { getSeo, storefrontMetadata } from "@/server/public/site";
import { getShell, loadProductPage } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Search = Promise<{
  event?: string | string[];
  category?: string | string[];
  page?: string | string[];
}>;

async function context(searchParams: Search) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const [store, query] = await Promise.all([getShell(tenant), searchParams]);
  // Only configured event types filter; anything else is ignored.
  const event =
    typeof query.event === "string" && store.eventTypes.includes(query.event) ? query.event : null;
  return { tenant, store, query, event, page: pageParam(query.page) };
}

const listHref = (event: string | null, page: number) => {
  const q = new URLSearchParams();
  if (event) q.set("event", event);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/rentals?${s}` : "/rentals";
};

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Search;
}): Promise<Metadata> {
  const { tenant, event, page } = await context(searchParams);
  return storefrontMetadata({
    tenant,
    // Filtered listings canonicalize to the unfiltered catalog; pages keep their number.
    path: listHref(null, event ? 1 : page),
    title: `${event ? `${humanize(event)} rentals` : "All rentals"}${page > 1 ? ` — page ${String(page)}` : ""} | ${tenant.name}`,
    description: `Browse every rental from ${tenant.name}. Pick your items and get an itemized quote online.`,
  });
}

const chip =
  "inline-flex min-h-10 shrink-0 items-center rounded-full border-2 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40";

/** The published catalog, one page at a time, optionally for an event type (server-side). */
export default async function RentalsPage({ searchParams }: { searchParams: Search }) {
  const { tenant, store, query, event, page } = await context(searchParams);
  // Category filtering lives on its own indexable URL.
  const wanted =
    typeof query.category === "string"
      ? store.categories.find((c) => c.slug === query.category)
      : null;
  if (wanted) redirect(`/categories/${wanted.slug}` as Route);

  const { products, total, pageCount } = await loadProductPage(tenant, {
    page,
    ...(event ? { eventType: event } : {}),
  });
  if (page > pageCount) notFound();
  const categories = store.categories.filter((c) => c.productCount > 0);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rentals", path: "/rentals" },
  ];
  const { canonicalOrigin } = await getSeo(tenant);

  return (
    <Container className="grid gap-8 py-8 sm:py-12">
      {canonicalOrigin ? <JsonLd data={breadcrumbJsonLd(canonicalOrigin, crumbs)} /> : null}
      <Breadcrumbs crumbs={crumbs} />
      <header className="grid gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          {event ? `Rentals for ${humanize(event).toLowerCase()} events` : "All rentals"}
        </h1>
        <p className="text-muted-foreground">
          {total} {total === 1 ? "rental" : "rentals"} · prices shown are starting prices; your
          quote includes delivery, tax and options.
        </p>
      </header>

      {categories.length ? (
        <nav
          aria-label="Categories"
          className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]"
        >
          <Link
            href="/rentals"
            aria-current={event ? undefined : "page"}
            className={cn(chip, !event && "border-primary bg-primary text-primary-foreground")}
          >
            All
          </Link>
          {categories.map((c) => (
            <Link
              key={c.id}
              href={`/categories/${c.slug}` as Route}
              className={cn(chip, "hover:border-primary")}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {store.eventTypes.length ? (
        <nav aria-label="Event types" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Event:</span>
          {store.eventTypes.map((t) => (
            <Link
              key={t}
              href={listHref(t === event ? null : t, 1) as Route}
              aria-current={t === event ? "true" : undefined}
              className={cn(
                chip,
                "min-h-9 border",
                t === event ? "border-primary bg-primary/10 text-primary" : "hover:border-primary",
              )}
            >
              {humanize(t)}
            </Link>
          ))}
        </nav>
      ) : null}

      {products.length ? (
        <>
          <ProductGrid products={products} currency={tenant.currency} eager={3} />
          <Pagination page={page} pageCount={pageCount} href={(p) => listHref(event, p)} />
        </>
      ) : (
        <EmptyState
          title={event ? "No rentals match that filter" : "Our online catalog is coming soon"}
        >
          <p>
            Tell us about your event and we&apos;ll put together a quote.{" "}
            {tenant.contact.phone ? `Or call us at ${tenant.contact.phone}.` : ""}
          </p>
          <div className="mt-4 flex justify-center">
            <CtaLink href="/quote">Get a quote</CtaLink>
          </div>
        </EmptyState>
      )}
    </Container>
  );
}
