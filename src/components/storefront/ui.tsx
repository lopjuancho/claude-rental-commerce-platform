import type { Route } from "next";
import Link from "next/link";
import type * as React from "react";
import type { Image, Product } from "@/domain/storefront/catalog";
import { priceSummary } from "@/domain/storefront/present";
import { cn } from "@/lib/utils";

/**
 * Storefront building blocks (server components, no client JS). Styling uses the tenant brand
 * variables set by <TenantTheme>; nothing here is tenant-specific.
 */

export function Container({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-6", className)}>{children}</div>;
}

export function Section({
  id,
  title,
  intro,
  children,
  className,
  action,
}: {
  id?: string;
  title: string;
  intro?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section aria-labelledby={headingId} className={cn("py-12 sm:py-16", className)}>
      <Container>
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div className="max-w-2xl">
            <h2 id={headingId} className="text-2xl font-extrabold tracking-tight sm:text-3xl">
              {title}
            </h2>
            {intro ? <p className="mt-2 text-muted-foreground">{intro}</p> : null}
          </div>
          {action}
        </div>
        {children}
      </Container>
    </section>
  );
}

const buttonBase =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-6 text-base font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/40 motion-reduce:transition-none";

export function CtaLink({
  href,
  children,
  variant = "primary",
  className,
}: {
  href: string;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "ghost";
  className?: string;
}) {
  const styles = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
    secondary: "border-2 border-primary/20 bg-background text-foreground hover:border-primary/50",
    ghost: "text-primary underline-offset-4 hover:underline px-0",
  }[variant];
  return (
    <Link href={href as Route} className={cn(buttonBase, styles, className)}>
      {children}
    </Link>
  );
}

/** Product photo with intrinsic size (no layout shift); lazy below the fold. */
export function ProductImage({
  image,
  name,
  priority = false,
  className,
  sizes,
}: {
  image: Image | null;
  name: string;
  priority?: boolean;
  className?: string;
  sizes?: string;
}) {
  if (!image) {
    return (
      <div
        role="img"
        aria-label={`${name} (no photo yet)`}
        className={cn(
          "flex aspect-[4/3] w-full items-center justify-center bg-gradient-to-br from-primary/15 via-secondary to-accent/20 text-4xl font-extrabold text-primary/40",
          className,
        )}
      >
        {name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- tenant media is served by /media with caching
    <img
      src={image.url}
      alt={image.alt || name}
      width={image.width ?? 1200}
      height={image.height ?? 900}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : "auto"}
      decoding="async"
      sizes={sizes}
      className={cn("aspect-[4/3] w-full object-cover", className)}
    />
  );
}

export function PriceTag({
  product,
  currency,
  size = "sm",
}: {
  product: Product;
  currency: string;
  size?: "sm" | "lg";
}) {
  const price = priceSummary(product, currency);
  if (!price) {
    return <p className="text-sm font-medium text-muted-foreground">Price in your quote</p>;
  }
  return (
    <p className={size === "lg" ? "text-lg" : "text-sm"}>
      <span className={cn("font-extrabold tabular-nums", size === "lg" ? "text-3xl" : "text-lg")}>
        {price.amount}
      </span>{" "}
      <span className="text-muted-foreground">
        {price.unit}
        {price.detail ? ` · ${price.detail}` : ""}
      </span>
    </p>
  );
}

export function ProductCard({
  product,
  currency,
  priority = false,
}: {
  product: Product;
  currency: string;
  priority?: boolean;
}) {
  const href = `/rentals/${product.slug}`;
  return (
    <article className="group relative flex flex-col overflow-hidden rounded-3xl border bg-card shadow-sm transition-shadow hover:shadow-md motion-reduce:transition-none">
      <ProductImage
        image={product.images[0] ?? null}
        name={product.name}
        priority={priority}
        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
      />
      <div className="flex flex-1 flex-col gap-2 p-5">
        <h3 className="text-lg font-bold leading-snug">
          {/* The whole card is clickable through this link's overlay. */}
          <Link
            href={href as Route}
            className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-4 focus-visible:after:ring-primary/40 after:rounded-3xl"
          >
            {product.name}
          </Link>
        </h3>
        {product.shortDescription ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{product.shortDescription}</p>
        ) : null}
        <div className="mt-auto pt-2">
          <PriceTag product={product} currency={currency} />
        </div>
      </div>
    </article>
  );
}

export function ProductGrid({
  products,
  currency,
  eager = 0,
}: {
  products: Product[];
  currency: string;
  eager?: number;
}) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((p, i) => (
        <li key={p.id} className="flex">
          <ProductCard product={p} currency={currency} priority={i < eager} />
        </li>
      ))}
    </ul>
  );
}

export function Breadcrumbs({ crumbs }: { crumbs: { name: string; path: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((c, i) => (
          <li key={c.path} className="flex items-center gap-1">
            {i > 0 ? <span aria-hidden="true">/</span> : null}
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="font-medium text-foreground">
                {c.name}
              </span>
            ) : (
              <Link href={c.path as Route} className="hover:text-foreground hover:underline">
                {c.name}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Bottom action bar on phones (the primary CTA stays in reach); hidden from md up. */
export function StickyMobileCta({
  href,
  label,
  sub,
}: {
  href: string;
  label: string;
  sub?: string;
}) {
  return (
    <>
      <div aria-hidden="true" className="h-20 md:hidden" />
      <div
        data-testid="sticky-cta"
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur md:hidden"
      >
        <div className="mx-auto flex max-w-md items-center gap-3">
          {sub ? (
            <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{sub}</p>
          ) : null}
          <CtaLink href={href} className={sub ? "shrink-0" : "w-full"}>
            {label}
          </CtaLink>
        </div>
      </div>
    </>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-dashed p-10 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="mt-2 text-muted-foreground">{children}</div> : null}
    </div>
  );
}
