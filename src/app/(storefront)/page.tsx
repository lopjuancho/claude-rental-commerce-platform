import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/storefront/json-ld";
import { Container, CtaLink, ProductGrid, ProductImage, Section } from "@/components/storefront/ui";
import { eventTypesOf, humanize } from "@/domain/storefront/catalog";
import { localBusinessJsonLd } from "@/domain/storefront/seo";
import { siteOrigin, storefrontMetadata } from "@/server/public/site";
import { brandAssetUrl, getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

async function context() {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  return { tenant, store: await getStorefront(tenant) };
}

function whereWeServe(store: Awaited<ReturnType<typeof context>>["store"]): string | null {
  const { serviceAreas, address } = store.profile;
  if (serviceAreas.length) return serviceAreas.join(" · ");
  if (address.city && address.state) return `${address.city}, ${address.state}`;
  return null;
}

export async function generateMetadata(): Promise<Metadata> {
  const { tenant, store } = await context();
  const where = whereWeServe(store);
  return storefrontMetadata({
    tenant,
    store,
    path: "/",
    title: `${tenant.name} — Event rentals`,
    description: where
      ? `Event rentals from ${tenant.name}, serving ${where}. Browse rentals and get an itemized quote online.`
      : `Event rentals from ${tenant.name}. Browse rentals and get an itemized quote online.`,
  });
}

/** Tenant storefront home (ADR 0016): everything shown is configured, published tenant data. */
export default async function StorefrontHome() {
  const { tenant, store } = await context();
  const featured = store.products.filter((p) => p.featured);
  const heroImage =
    (featured.length ? featured : store.products).flatMap((p) => p.images)[0] ?? null;
  const categories = store.categories.filter((c) => c.productCount > 0);
  const eventTypes = eventTypesOf(store.products).slice(0, 8);
  const where = whereWeServe(store);
  const { freeDeliveryMiles, maximumDeliveryMiles, serviceAreas } = store.profile;
  const safetyPolicy = store.profile.policies.find((p) => /weather|safety/.test(p.type));
  const origin = await siteOrigin(tenant);

  const trust = [
    {
      title: "Clear, itemized quotes",
      text: "Prices come from our current rates, calculated when you ask — no surprises before you book.",
    },
    tenant.contact.phone
      ? { title: "Talk to a real person", text: `Questions? Call us at ${tenant.contact.phone}.` }
      : null,
    where ? { title: "Local service", text: `Serving ${where}.` } : null,
    safetyPolicy
      ? {
          title: safetyPolicy.title,
          text: "Read how we keep every event safe.",
          href: `/policies/${safetyPolicy.type}`,
        }
      : null,
  ].filter((t): t is { title: string; text: string; href?: string } => t !== null);

  return (
    <>
      <JsonLd
        data={localBusinessJsonLd(
          origin,
          {
            name: tenant.name,
            currency: tenant.currency,
            phone: tenant.contact.phone,
            email: tenant.contact.email,
            logoUrl: brandAssetUrl(tenant.branding.logoPath),
          },
          store.profile,
        )}
      />

      <section
        aria-labelledby="hero-title"
        className="relative overflow-hidden bg-primary text-primary-foreground"
      >
        <div
          aria-hidden="true"
          className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-accent/30 blur-3xl"
        />
        <Container className="relative grid items-center gap-10 py-14 sm:py-20 lg:grid-cols-2">
          <div className="grid gap-6">
            <p className="text-sm font-semibold uppercase tracking-widest opacity-80">
              {tenant.name}
            </p>
            <h1
              id="hero-title"
              className="text-4xl font-extrabold leading-tight tracking-tight sm:text-5xl"
            >
              Rentals that make your event
            </h1>
            <p className="max-w-xl text-lg opacity-90">
              Browse our rentals, pick your date and get an itemized quote in minutes.
              {where ? ` Serving ${where}.` : ""}
            </p>
            <div className="flex flex-wrap gap-3">
              <CtaLink
                href="/quote"
                className="bg-background text-foreground hover:bg-background/90"
              >
                Check availability &amp; get a quote
              </CtaLink>
              <CtaLink
                href="/rentals"
                variant="secondary"
                className="border-primary-foreground/40 bg-transparent text-primary-foreground hover:border-primary-foreground"
              >
                Browse rentals
              </CtaLink>
            </div>
          </div>
          {heroImage ? (
            <div className="overflow-hidden rounded-[2rem] shadow-2xl ring-4 ring-primary-foreground/10">
              <ProductImage
                image={heroImage}
                name={tenant.name}
                priority
                sizes="(min-width: 1024px) 50vw, 100vw"
              />
            </div>
          ) : null}
        </Container>
      </section>

      {categories.length ? (
        <Section id="categories" title="Browse by category">
          <ul className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {categories.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/categories/${c.slug}` as Route}
                  className="group block overflow-hidden rounded-3xl border bg-card shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40 motion-reduce:transition-none"
                >
                  <ProductImage
                    image={c.image}
                    name={c.name}
                    sizes="(min-width: 1024px) 25vw, 50vw"
                  />
                  <span className="block p-4">
                    <span className="block font-bold">{c.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {c.productCount} {c.productCount === 1 ? "rental" : "rentals"}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {featured.length ? (
        <Section
          id="featured"
          title="Popular rentals"
          className="bg-muted/40"
          action={
            <CtaLink href="/rentals" variant="ghost">
              See all rentals →
            </CtaLink>
          }
        >
          <ProductGrid products={featured.slice(0, 6)} currency={tenant.currency} />
        </Section>
      ) : null}

      {eventTypes.length ? (
        <Section
          id="events"
          title="Perfect for your event"
          intro="Find rentals picked for the kind of event you're planning."
        >
          <ul className="flex flex-wrap gap-3">
            {eventTypes.map((t) => (
              <li key={t}>
                <Link
                  href={`/rentals?event=${encodeURIComponent(t)}` as Route}
                  className="inline-flex min-h-11 items-center rounded-full border-2 px-5 font-semibold hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
                >
                  {humanize(t)}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {trust.length ? (
        <Section id="why" title={`Why book with ${tenant.name}`} className="bg-muted/40">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {trust.map((t) => (
              <li key={t.title} className="rounded-3xl bg-card p-6 shadow-sm">
                <p className="font-bold">{t.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t.text}</p>
                {t.href ? (
                  <Link
                    href={t.href as Route}
                    className="mt-2 inline-block text-sm font-semibold text-primary hover:underline"
                  >
                    Read more
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {serviceAreas.length || maximumDeliveryMiles || (freeDeliveryMiles ?? 0) > 0 ? (
        <Section id="delivery" title="Delivery & service area">
          <div className="grid gap-3 rounded-3xl border p-6 text-muted-foreground sm:p-8">
            {serviceAreas.length ? (
              <p>
                <span className="font-semibold text-foreground">We deliver to:</span>{" "}
                {serviceAreas.join(", ")}.
              </p>
            ) : null}
            {maximumDeliveryMiles ? (
              <p>We deliver up to {maximumDeliveryMiles} miles from our base.</p>
            ) : null}
            {(freeDeliveryMiles ?? 0) > 0 ? (
              <p>Delivery is free within {freeDeliveryMiles} miles.</p>
            ) : null}
            <p>Your exact delivery fee is calculated in your quote from your event address.</p>
          </div>
        </Section>
      ) : null}

      <section aria-labelledby="cta-title" className="py-14">
        <Container className="grid gap-4 rounded-[2rem] bg-secondary p-8 text-center sm:p-12">
          <h2 id="cta-title" className="text-2xl font-extrabold tracking-tight sm:text-3xl">
            Ready to plan your event?
          </h2>
          <p className="text-muted-foreground">
            Pick your rentals and date — we&apos;ll price it right away.
          </p>
          <div className="flex justify-center">
            <CtaLink href="/quote">Get my quote</CtaLink>
          </div>
        </Container>
      </section>
    </>
  );
}
