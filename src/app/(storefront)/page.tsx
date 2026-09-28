import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TenantTheme } from "@/components/tenant-theme";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getRequestTenant();
  return { title: tenant?.name ?? "Not found" };
}

/** Tenant storefront home. Milestone 1 placeholder; the conversational home ships in M6/M7. */
export default async function StorefrontHome() {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();

  return (
    <TenantTheme
      primaryColor={tenant.branding.primaryColor}
      secondaryColor={tenant.branding.secondaryColor}
    >
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-5 py-16">
        <p className="text-sm font-medium uppercase tracking-wide text-accent">{tenant.name}</p>
        <h1 className="text-4xl font-bold tracking-tight">What are you planning?</h1>
        <p className="text-lg text-muted-foreground">
          Our online catalog and event assistant are coming soon.
        </p>
        {tenant.contact.phone || tenant.contact.email ? (
          <p className="text-muted-foreground">
            Contact us{" "}
            {tenant.contact.phone ? (
              <a
                className="font-medium text-primary underline"
                href={`tel:${tenant.contact.phone}`}
              >
                {tenant.contact.phone}
              </a>
            ) : null}
            {tenant.contact.phone && tenant.contact.email ? " · " : null}
            {tenant.contact.email ? (
              <a
                className="font-medium text-primary underline"
                href={`mailto:${tenant.contact.email}`}
              >
                {tenant.contact.email}
              </a>
            ) : null}
          </p>
        ) : null}
      </main>
    </TenantTheme>
  );
}
