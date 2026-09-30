import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Container, CtaLink } from "@/components/storefront/ui";
import { STALE_MESSAGE } from "@/domain/storefront/quote-step";
import {
  localToday,
  normalizeItems,
  prefillFromQuote,
  type QuotePrefill,
} from "@/domain/storefront/quote-prefill";
import { listQuoteOptions } from "@/server/public/catalog";
import { getPublicQuote } from "@/server/public/quotes";
import { storefrontMetadata } from "@/server/public/site";
import { getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";
import { QuoteRequestForm } from "./quote-request-form";

type Search = Promise<{ item?: string | string[]; from?: string | string[] }>;

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  return storefrontMetadata({
    tenant,
    store: await getStorefront(tenant),
    path: "/quote",
    title: `Get a quote | ${tenant.name}`,
    description: `Check availability and get an itemized quote from ${tenant.name}.`,
  });
}

/**
 * Public quote request (ADR 0016). `?item=<slug>` preselects a published product of this tenant;
 * `?from=<token>` starts from the customer's earlier quote (e.g. after their event changed). Both
 * only prefill the form — the server validates and prices the submission from scratch.
 */
export default async function QuoteRequestPage({ searchParams }: { searchParams: Search }) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const [options, store, query] = await Promise.all([
    listQuoteOptions(tenant),
    getStorefront(tenant),
    searchParams,
  ]);
  const offered = new Set(options.map((o) => o.variantId));

  let prefill: QuotePrefill = { items: [], event: null };
  let from: "stale" | "earlier" | null = null;
  if (typeof query.from === "string") {
    const earlier = await getPublicQuote(tenant, query.from).catch(() => null);
    if (earlier) {
      prefill = prefillFromQuote(earlier, tenant.timezone, offered);
      from = earlier.stale ? "stale" : "earlier";
    }
  }
  const item =
    typeof query.item === "string" ? store.products.find((p) => p.slug === query.item) : null;
  if (item?.defaultVariantId) {
    prefill = {
      ...prefill,
      items: normalizeItems(
        [...prefill.items, { variantId: item.defaultVariantId, quantity: 1 }],
        offered,
      ),
    };
  }

  return (
    <Container className="grid max-w-2xl gap-6 py-8 sm:py-12">
      <header className="grid gap-2">
        <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
          {from ? "Update your quote" : "Get a quote"}
        </h1>
        <p className="text-muted-foreground">
          {from === "stale" ? `${STALE_MESSAGE} ` : ""}
          {from
            ? "We've started from your earlier quote. Check the details below, confirm your event address, and we'll price it again."
            : "Tell us what you need and when. We check availability and calculate your price from our current rates."}
        </p>
      </header>
      {options.length === 0 ? (
        <div className="grid gap-3 rounded-3xl border p-6">
          <p>Online quotes are not available yet. Please contact us.</p>
          {tenant.contact.phone ? (
            <CtaLink href={`tel:${tenant.contact.phone}`} variant="secondary">
              Call {tenant.contact.phone}
            </CtaLink>
          ) : null}
        </div>
      ) : (
        <QuoteRequestForm
          options={options}
          timeZone={tenant.timezone}
          prefill={prefill}
          minDate={localToday(tenant.timezone)}
        />
      )}
    </Container>
  );
}
