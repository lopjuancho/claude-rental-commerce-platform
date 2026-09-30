import { notFound } from "next/navigation";
import type * as React from "react";
import { SiteFooter, SiteHeader, type SiteBrand } from "@/components/storefront/site-chrome";
import { TenantTheme } from "@/components/tenant-theme";
import { brandAssetUrl, getStorefront } from "@/server/public/storefront";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Storefront shell (ADR 0016). The tenant comes from the Host header only; an unknown host is a
 * 404. Everything shown is the tenant's configured, published data.
 */
export default async function StorefrontLayout({ children }: { children: React.ReactNode }) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const store = await getStorefront(tenant);
  const brand: SiteBrand = {
    name: tenant.name,
    logoUrl: brandAssetUrl(tenant.branding.logoPath),
    phone: tenant.contact.phone,
    email: tenant.contact.email,
  };
  return (
    <TenantTheme
      primaryColor={tenant.branding.primaryColor}
      secondaryColor={tenant.branding.secondaryColor}
      accentColor={tenant.branding.accentColor}
      className="flex min-h-dvh flex-col"
    >
      <SiteHeader brand={brand} store={store} />
      <main id="main" tabIndex={-1} className="flex-1 focus:outline-none">
        {children}
      </main>
      <SiteFooter brand={brand} store={store} />
    </TenantTheme>
  );
}
