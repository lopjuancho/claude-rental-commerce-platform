import "server-only";
import { headers } from "next/headers";
import { cache } from "react";
import { normalizeHost } from "@/domain/tenancy/host";
import { createPublicClient } from "@/server/db/public";
import { getServerEnv } from "@/server/env";

declare const tenantBrand: unique symbol;

/**
 * An organization resolved on the server from the request host. The brand makes it impossible
 * to construct one from request input by accident: public write paths accept only this type.
 */
export interface ResolvedTenant {
  readonly [tenantBrand]: true;
  readonly organizationId: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly currency: string;
  /** All optional: a tenant without branding renders with neutral platform defaults. */
  readonly branding: {
    readonly logoPath: string | null;
    readonly logoMarkPath: string | null;
    readonly faviconPath: string | null;
    readonly primaryColor: string | null;
    readonly secondaryColor: string | null;
    readonly accentColor: string | null;
  };
  readonly contact: {
    readonly phone: string | null;
    readonly smsPhone: string | null;
    readonly email: string | null;
    readonly websiteUrl: string | null;
  };
  readonly resolvedBy: "host" | "dev-slug";
}

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  currency: string;
  logo_media_path: string | null;
  logo_mark_media_path: string | null;
  favicon_media_path: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  accent_color: string | null;
  contact_phone: string | null;
  sms_phone: string | null;
  contact_email: string | null;
  website_url: string | null;
}

function toTenant(row: TenantRow, resolvedBy: ResolvedTenant["resolvedBy"]): ResolvedTenant {
  return {
    organizationId: row.id,
    slug: row.slug,
    name: row.name,
    timezone: row.timezone,
    currency: row.currency,
    branding: {
      logoPath: row.logo_media_path,
      logoMarkPath: row.logo_mark_media_path,
      faviconPath: row.favicon_media_path,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      accentColor: row.accent_color,
    },
    contact: {
      phone: row.contact_phone,
      smsPhone: row.sms_phone,
      email: row.contact_email,
      websiteUrl: row.website_url,
    },
    resolvedBy,
  } as ResolvedTenant;
}

/** Resolves a normalized hostname. Exported for tests and non-request contexts. */
export async function resolveTenantByHost(host: string | null): Promise<ResolvedTenant | null> {
  const db = createPublicClient();
  if (host) {
    const { data, error } = await db.rpc("resolve_organization_by_host", { p_host: host });
    if (error) throw new Error("Tenant resolution failed", { cause: error });
    const row = data[0];
    if (row) return toTenant(row, "host");
  }

  const env = getServerEnv();
  if (env.APP_ENV !== "production" && env.DEV_TENANT_SLUG) {
    const { data, error } = await db.rpc("resolve_organization_by_slug", {
      p_slug: env.DEV_TENANT_SLUG,
    });
    if (error) throw new Error("Tenant resolution failed", { cause: error });
    const row = data[0];
    if (row) return toTenant(row, "dev-slug");
  }
  return null;
}

/**
 * The tenant for the current request, from the Host header only. Never reads organization ids
 * from query strings, bodies or custom headers (ADR 0001). Cached per request.
 */
export const getRequestTenant = cache(async (): Promise<ResolvedTenant | null> => {
  const h = await headers();
  return resolveTenantByHost(normalizeHost(h.get("host")));
});
