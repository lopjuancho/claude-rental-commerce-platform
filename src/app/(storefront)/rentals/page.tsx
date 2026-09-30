import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { JsonLd } from "@/components/storefront/json-ld";
import {
  Breadcrumbs,
  Container,
  CtaLink,
  EmptyState,
  ProductGrid,
} from "@/components/storefront/ui";
import { eventTypesOf, humanize } from "@/domain/storefront/catalog";
import { breadcrumbJsonLd } from "@/domain/storefront/seo";
import { cn } from "@/lib/utils";
import { siteOrigin, storefrontMetadata } from "@/server/public/site";
import { getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Search = Promise<{ event?: string | string[]; category?: string | string[] }>;

async function context() {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  return { tenant, store: await getStorefront(tenant) };
}

export async function generateMetadata(): Promise<Metadata> {
  const { tenant, store } = await context();
  return storefrontMetadata({
    tenant,
    store,
    path: "/rentals",
    title: `All rentals | ${tenant.name}`,
    description: `Browse every rental from ${tenant.name}. Pick your items and get an itemized quote online.`,
  });
}

const chip =
  "inline-flex min-h-10 shrink-0 items-center rounded-full border-2 px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40";

/** The whole published catalog, optionally narrowed to an event type (server-side, no client JS). */
export default async function RentalsPage({ searchParams }: { searchParams: Search }) {
  const { tenant, store } = await context();
  const query = await searchParams;
  // Category filtering lives on its own indexable URL.
  const wanted =
    typeof query.category === "string"
      ? store.categories.find((c) => c.slug === query.category)
      : null;
  if (wanted) redirect(`/categories/${wanted.slug}` as Route);
  const raw = query.event;
  const eventTypes = eventTypesOf(store.products);
  const event = typeof raw === "string" && eventTypes.includes(raw) ? raw : null;
  const products = event
    ? store.products.filter((p) => p.eventTypes.includes(event))
    : store.products;
  const categories = store.categories.filter((c) => c.productCount > 0);
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rentals", path: "/rentals" },
  ];

  return (
    <Container className="grid gap-8 py-8 sm:py-12">
      <JsonLd data={breadcrumbJsonLd(await siteOrigin(tenant), crumbs)} />
      <Breadcrumbs crumbs={crumbs} />
      <header className="grid gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          {event ? `Rentals for ${humanize(event).toLowerCase()} events` : "All rentals"}
        </h1>
        <p className="text-muted-foreground">
          {products.length} {products.length === 1 ? "rental" : "rentals"} · prices shown are base
          rates; your quote includes delivery, tax and options.
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

      {eventTypes.length ? (
        <nav aria-label="Event types" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Event:</span>
          {eventTypes.map((t) => (
            <Link
              key={t}
              href={(t === event ? "/rentals" : `/rentals?event=${encodeURIComponent(t)}`) as Route}
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
        <ProductGrid products={products} currency={tenant.currency} eager={3} />
      ) : (
        <EmptyState
          title={
            store.products.length
              ? "No rentals match that filter"
              : "Our online catalog is coming soon"
          }
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
