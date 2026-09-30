import "server-only";
import { cache } from "react";
import {
  assembleStorefront,
  type CategoryRow,
  type MediaRow,
  type PolicyRow,
  type ProductRow,
  type ServiceAreaRow,
  type SettingsRow,
  type Storefront,
  type VariantRow,
} from "@/domain/storefront/catalog";
import { fromDbError } from "@/server/catalog/errors";
import { createPublicClient } from "@/server/db/public";
import { getServerEnv } from "@/server/env";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Storefront reads (ADR 0016): the anon-safe public views only — published data of active
 * organizations, filtered by the host-resolved tenant. No service role, no session.
 */
export interface StorefrontSource {
  settings(organizationId: string): Promise<SettingsRow | null>;
  policies(organizationId: string): Promise<PolicyRow[]>;
  serviceAreas(organizationId: string): Promise<ServiceAreaRow[]>;
  categories(organizationId: string): Promise<CategoryRow[]>;
  products(organizationId: string): Promise<ProductRow[]>;
  media(organizationId: string): Promise<MediaRow[]>;
  variants(organizationId: string): Promise<VariantRow[]>;
}

function rows<T>(
  res: { data: T[] | null; error: Parameters<typeof fromDbError>[0] | null },
  what: string,
): T[] {
  if (res.error) throw fromDbError(res.error, what);
  return res.data ?? [];
}

export function supabaseStorefrontSource(): StorefrontSource {
  const db = createPublicClient();
  return {
    settings: async (org) =>
      rows(
        await db.from("public_storefront_settings").select("*").eq("organization_id", org).limit(1),
        "Store",
      )[0] ?? null,
    policies: async (org) =>
      rows(
        await db
          .from("public_storefront_policies")
          .select("id, organization_id, policy_type, title, body, updated_at")
          .eq("organization_id", org)
          .limit(50),
        "Policy",
      ),
    serviceAreas: async (org) =>
      rows(
        await db
          .from("public_service_areas")
          .select("organization_id, name, priority")
          .eq("organization_id", org)
          .limit(200),
        "Service area",
      ),
    categories: async (org) =>
      rows(
        await db
          .from("public_catalog_categories")
          .select("*")
          .eq("organization_id", org)
          .limit(500),
        "Category",
      ),
    products: async (org) =>
      rows(
        await db.from("public_catalog_products").select("*").eq("organization_id", org).limit(1000),
        "Product",
      ),
    media: async (org) =>
      rows(
        await db
          .from("public_catalog_product_media")
          .select("*")
          .eq("organization_id", org)
          .limit(4000),
        "Media",
      ),
    variants: async (org) =>
      rows(
        await db.from("public_catalog_variants").select("*").eq("organization_id", org).limit(4000),
        "Product",
      ),
  };
}

/** Everything the storefront shows for one tenant, loaded once per request. */
export async function loadStorefront(
  tenant: ResolvedTenant,
  source: StorefrontSource,
): Promise<Storefront> {
  const org = tenant.organizationId;
  const [settings, policies, serviceAreas, categories, products, media, variants] =
    await Promise.all([
      source.settings(org),
      source.policies(org),
      source.serviceAreas(org),
      source.categories(org),
      source.products(org),
      source.media(org),
      source.variants(org),
    ]);
  return assembleStorefront(org, {
    settings,
    policies,
    serviceAreas,
    categories,
    products,
    media,
    variants,
  });
}

/** Per-request cache keyed by tenant (a request only ever serves one tenant). */
export const getStorefront = cache((tenant: ResolvedTenant) =>
  loadStorefront(tenant, supabaseStorefrontSource()),
);

/** Public URL of a tenant brand asset (the brand-assets bucket is public by design). */
export function brandAssetUrl(path: string | null): string | null {
  if (!path) return null;
  const base = getServerEnv().NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "");
  return `${base}/storage/v1/object/public/brand-assets/${path.split("/").map(encodeURIComponent).join("/")}`;
}
