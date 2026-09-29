import "server-only";
import { priceRequestSchema } from "@/domain/pricing/context";
import { createSystemClient } from "@/server/db/system";
import { runPricing } from "@/server/pricing/run";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Pricing for the storefront and the AI assistant (ADR 0001). The organization comes only from
 * the server-resolved tenant; only published products; no manual adjustments. The assistant must
 * present exactly this output (and only as final when manualReviewRequired is false).
 */
export async function priceForTenant(
  tenant: ResolvedTenant,
  raw: unknown,
  opts: { save?: boolean } = {},
) {
  const request = priceRequestSchema.parse({ ...(raw as object), adjustments: [] });
  return runPricing(createSystemClient(), tenant.organizationId, request, {
    channel: "public",
    save: opts.save ?? false,
  });
}
