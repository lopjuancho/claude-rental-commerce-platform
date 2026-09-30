import type { Route } from "next";
import Link from "next/link";
import type { StorefrontShell } from "@/domain/storefront/catalog";
import { Container, CtaLink } from "./ui";

/** What the header/footer need to know about the tenant (from server-side resolution only). */
export interface SiteBrand {
  name: string;
  logoUrl: string | null;
  phone: string | null;
  email: string | null;
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, "")}`;

export function SiteHeader({ brand, store }: { brand: SiteBrand; store: StorefrontShell }) {
  const nav = store.categories.filter((c) => c.productCount > 0).slice(0, 4);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-full focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Container className="flex h-16 items-center gap-4">
        <Link
          href="/"
          className="flex min-w-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40"
        >
          {brand.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- public brand asset
            <img
              src={brand.logoUrl}
              alt={brand.name}
              height={40}
              width={160}
              className="h-10 w-auto max-w-[10rem] object-contain"
            />
          ) : (
            <span className="truncate text-lg font-extrabold tracking-tight">{brand.name}</span>
          )}
        </Link>
        <nav
          aria-label="Main"
          className="ml-4 hidden items-center gap-5 text-sm font-medium md:flex"
        >
          <Link href="/rentals" className="hover:text-primary">
            All rentals
          </Link>
          {nav.map((c) => (
            <Link key={c.id} href={`/categories/${c.slug}` as Route} className="hover:text-primary">
              {c.name}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {brand.phone ? (
            <a
              href={telHref(brand.phone)}
              className="hidden rounded-full px-3 py-2 text-sm font-semibold hover:text-primary sm:inline-flex"
            >
              <span className="sr-only">Call us: </span>
              {brand.phone}
            </a>
          ) : null}
          <CtaLink href="/quote" className="min-h-10 px-4 text-sm">
            Get a quote
          </CtaLink>
        </div>
      </Container>
      <nav aria-label="Browse categories" className="border-t md:hidden">
        <Container className="flex gap-4 overflow-x-auto py-2 text-sm font-medium [scrollbar-width:none]">
          <Link href="/rentals" className="shrink-0 hover:text-primary">
            All rentals
          </Link>
          {nav.map((c) => (
            <Link
              key={c.id}
              href={`/categories/${c.slug}` as Route}
              className="shrink-0 hover:text-primary"
            >
              {c.name}
            </Link>
          ))}
        </Container>
      </nav>
    </header>
  );
}

export function SiteFooter({ brand, store }: { brand: SiteBrand; store: StorefrontShell }) {
  const a = store.profile.address;
  const cityLine = [a.city, [a.state, a.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  return (
    <footer className="mt-auto border-t bg-muted/60">
      <Container className="grid gap-8 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div className="grid content-start gap-2">
          <p className="text-lg font-extrabold">{brand.name}</p>
          {a.line1 || cityLine ? (
            <address className="not-italic text-sm text-muted-foreground">
              {a.line1 ? <span className="block">{a.line1}</span> : null}
              {cityLine ? <span className="block">{cityLine}</span> : null}
            </address>
          ) : null}
        </div>
        <div className="grid content-start gap-2 text-sm">
          <p className="font-semibold">Contact</p>
          {brand.phone ? (
            <a className="hover:underline" href={telHref(brand.phone)}>
              {brand.phone}
            </a>
          ) : null}
          {brand.email ? (
            <a className="hover:underline" href={`mailto:${brand.email}`}>
              {brand.email}
            </a>
          ) : null}
          <Link className="hover:underline" href="/quote">
            Request a quote
          </Link>
        </div>
        <nav aria-label="Rentals" className="grid content-start gap-2 text-sm">
          <p className="font-semibold">Rentals</p>
          <Link className="hover:underline" href="/rentals">
            All rentals
          </Link>
          {store.categories
            .filter((c) => c.productCount > 0)
            .map((c) => (
              <Link key={c.id} className="hover:underline" href={`/categories/${c.slug}` as Route}>
                {c.name}
              </Link>
            ))}
        </nav>
        {store.profile.policies.length ? (
          <nav aria-label="Policies" className="grid content-start gap-2 text-sm">
            <p className="font-semibold">Policies</p>
            {store.profile.policies.map((p) => (
              <Link key={p.type} className="hover:underline" href={`/policies/${p.type}` as Route}>
                {p.title}
              </Link>
            ))}
          </nav>
        ) : null}
      </Container>
      <Container className="border-t py-6 text-xs text-muted-foreground">© {brand.name}</Container>
    </footer>
  );
}
