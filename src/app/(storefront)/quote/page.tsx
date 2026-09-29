import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TenantTheme } from "@/components/tenant-theme";
import { listQuoteOptions } from "@/server/public/catalog";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";
import { QuoteRequestForm } from "./quote-request-form";

export const metadata: Metadata = { title: "Get a quote" };

/** Public quote request. Correctness first; the full storefront experience is M6. */
export default async function QuoteRequestPage() {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const options = await listQuoteOptions(tenant);
  return (
    <TenantTheme
      primaryColor={tenant.branding.primaryColor}
      secondaryColor={tenant.branding.secondaryColor}
    >
      <main className="mx-auto grid max-w-2xl gap-6 px-5 py-10">
        <header className="grid gap-1">
          <p className="text-sm font-medium uppercase tracking-wide text-accent">{tenant.name}</p>
          <h1 className="text-3xl font-bold tracking-tight">Get a quote</h1>
          <p className="text-muted-foreground">
            Prices are calculated from our current rates when you submit.
          </p>
        </header>
        {options.length === 0 ? (
          <p>Online quotes are not available yet. Please contact us.</p>
        ) : (
          <QuoteRequestForm options={options} timeZone={tenant.timezone} />
        )}
      </main>
    </TenantTheme>
  );
}
