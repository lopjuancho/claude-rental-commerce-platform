import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/storefront/json-ld";
import {
  Breadcrumbs,
  Container,
  CtaLink,
  PriceTag,
  ProductGrid,
  ProductImage,
  Section,
  StickyMobileCta,
} from "@/components/storefront/ui";
import { humanize, relatedProducts } from "@/domain/storefront/catalog";
import {
  priceSummary,
  PRICE_QUALIFIER,
  specGroups,
  weatherNotes,
} from "@/domain/storefront/present";
import { breadcrumbJsonLd, metaDescription, productJsonLd } from "@/domain/storefront/seo";
import { siteOrigin, storefrontMetadata } from "@/server/public/site";
import { brandAssetUrl, getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

type Params = Promise<{ slug: string }>;

/** The product must be published by the host's tenant; any other slug (incl. another tenant's) 404s. */
async function context(params: Params) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const store = await getStorefront(tenant);
  const { slug } = await params;
  const product = store.products.find((p) => p.slug === slug);
  if (!product) notFound();
  return { tenant, store, product };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { tenant, store, product } = await context(params);
  return storefrontMetadata({
    tenant,
    store,
    path: `/rentals/${product.slug}`,
    title: `${product.name} rental | ${tenant.name}`,
    description:
      metaDescription(product.shortDescription, product.description) ??
      `Rent the ${product.name} from ${tenant.name}. Get an itemized quote online.`,
    imagePath: product.images[0]?.url ?? null,
  });
}

export default async function ProductPage({ params }: { params: Params }) {
  const { tenant, store, product } = await context(params);
  const path = `/rentals/${product.slug}`;
  const origin = await siteOrigin(tenant);
  const category =
    store.categories.find((c) => c.id === product.primaryCategoryId) ??
    store.categories.find((c) => product.categoryIds.includes(c.id));
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Rentals", path: "/rentals" },
    ...(category ? [{ name: category.name, path: `/categories/${category.slug}` }] : []),
    { name: product.name, path },
  ];
  const [main, ...more] = product.images;
  const specs = specGroups(product);
  const weather = weatherNotes(product);
  const price = priceSummary(product, tenant.currency);
  const related = relatedProducts(store.products, product);
  const quoteHref = `/quote?item=${encodeURIComponent(product.slug)}`;
  const safetyPolicy = store.profile.policies.find((p) => /weather|safety/.test(p.type));

  return (
    <>
      <JsonLd
        data={[
          productJsonLd(
            origin,
            {
              name: tenant.name,
              currency: tenant.currency,
              phone: tenant.contact.phone,
              email: tenant.contact.email,
              logoUrl: brandAssetUrl(tenant.branding.logoPath),
            },
            product,
            path,
          ),
          breadcrumbJsonLd(origin, crumbs),
        ]}
      />
      <Container className="grid gap-8 py-8 sm:py-12">
        <Breadcrumbs crumbs={crumbs} />
        <div className="grid gap-10 lg:grid-cols-[3fr_2fr] lg:items-start">
          <div className="grid gap-3">
            <div className="overflow-hidden rounded-3xl border">
              <ProductImage
                image={main ?? null}
                name={product.name}
                priority
                sizes="(min-width: 1024px) 60vw, 100vw"
              />
            </div>
            {more.length ? (
              <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4" aria-label="More photos">
                {more.map((img) => (
                  <li key={img.id} className="overflow-hidden rounded-2xl border">
                    <ProductImage
                      image={img}
                      name={product.name}
                      sizes="(min-width: 1024px) 15vw, 33vw"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="grid gap-6 lg:sticky lg:top-24">
            <header className="grid gap-3">
              <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">{product.name}</h1>
              {product.shortDescription ? (
                <p className="text-lg text-muted-foreground">{product.shortDescription}</p>
              ) : null}
            </header>
            <div className="grid gap-1 rounded-3xl border bg-card p-5">
              <PriceTag product={product} currency={tenant.currency} size="lg" />
              <p className="text-sm text-muted-foreground">
                {price
                  ? PRICE_QUALIFIER
                  : "Your price is calculated in your quote from your date, address and options."}
              </p>
            </div>
            <div className="grid gap-3">
              <CtaLink href={quoteHref} className="w-full">
                Check availability &amp; get a quote
              </CtaLink>
              <p className="text-center text-sm text-muted-foreground">
                Free, itemized quote. Nothing is booked until you request it.
                {tenant.contact.phone ? (
                  <>
                    {" "}
                    Questions?{" "}
                    <a
                      href={`tel:${tenant.contact.phone}`}
                      className="font-semibold text-primary hover:underline"
                    >
                      Call {tenant.contact.phone}
                    </a>
                  </>
                ) : null}
              </p>
            </div>
            {weather.length ? (
              <aside
                aria-label="Weather and safety"
                className="grid gap-1 rounded-2xl bg-muted/60 p-4 text-sm"
              >
                {weather.map((w) => (
                  <p key={w.hazard}>{w.text}</p>
                ))}
                {safetyPolicy ? (
                  <Link
                    href={`/policies/${safetyPolicy.type}` as Route}
                    className="font-semibold text-primary hover:underline"
                  >
                    {safetyPolicy.title}
                  </Link>
                ) : null}
              </aside>
            ) : null}
          </div>
        </div>

        {product.description || specs.length || product.eventTypes.length ? (
          <div className="grid gap-10 lg:grid-cols-[3fr_2fr]">
            <div className="grid content-start gap-4">
              {product.description ? (
                <>
                  <h2 className="text-2xl font-bold">About this rental</h2>
                  {product.description.split(/\n{2,}/).map((para, i) => (
                    <p
                      // Paragraphs of immutable text: position is their identity.
                      // eslint-disable-next-line @eslint-react/no-array-index-key
                      key={i}
                      className="whitespace-pre-line leading-relaxed text-muted-foreground"
                    >
                      {para}
                    </p>
                  ))}
                </>
              ) : null}
              {product.eventTypes.length ? (
                <div className="grid gap-2">
                  <h2 className="text-lg font-bold">Great for</h2>
                  <ul className="flex flex-wrap gap-2">
                    {product.eventTypes.map((t) => (
                      <li key={t}>
                        <Link
                          href={`/rentals?event=${encodeURIComponent(t)}` as Route}
                          className="inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-semibold hover:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
                        >
                          {humanize(t)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {specs.length ? (
              <div className="grid content-start gap-4">
                <h2 className="text-2xl font-bold">Specifications</h2>
                {specs.map((g) => (
                  <section key={g.title} aria-label={g.title} className="rounded-2xl border p-4">
                    <h3 className="mb-2 font-semibold">{g.title}</h3>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                      {g.specs.map((s) => (
                        <div key={s.label} className="contents">
                          <dt className="text-muted-foreground">{s.label}</dt>
                          <dd className="font-medium">{s.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </Container>

      {related.length ? (
        <Section id="related" title="You might also like" className="bg-muted/40">
          <ProductGrid products={related} currency={tenant.currency} />
        </Section>
      ) : null}

      <StickyMobileCta
        href={quoteHref}
        label="Get a quote"
        sub={price ? `${price.amount} ${price.unit}` : product.name}
      />
    </>
  );
}
