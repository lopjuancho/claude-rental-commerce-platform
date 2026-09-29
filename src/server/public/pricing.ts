import "server-only";
import { priceRequestSchema } from "@/domain/pricing/context";
import { getDistanceProvider } from "@/server/delivery/provider";
import { gatewayPricingSource, runPricing } from "@/server/pricing/run";
import { enforceRateLimit } from "@/server/rate-limit";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { systemGateway } from "@/server/trusted/gateway";
import type { PublicDeps, RequestMeta } from "./deps";

/**
 * Pricing for the storefront and the AI assistant (ADR 0001, hardening H5).
 * - The organization is only the server-resolved tenant.
 * - Input is strict: items/times/address/codes. Any other key (an organization id, a price,
 *   adjustments, totals) is rejected.
 * - Only published products; rate-limited per tenant + client; a saved snapshot is audited.
 * The assistant must present exactly this output (and only as final when manualReviewRequired
 * is false).
 */
export async function priceForTenant(
  tenant: ResolvedTenant,
  raw: unknown,
  meta: RequestMeta,
  opts: { save?: boolean } = {},
  deps: PublicDeps = defaultDeps(),
) {
  await deps.rateLimit("publicQuery", `${tenant.organizationId}:${meta.ip}`);
  const request = priceRequestSchema.parse(raw);
  const run = await runPricing(
    {
      source: gatewayPricingSource(deps.gateway, tenant.organizationId),
      gateway: deps.gateway,
      provider: deps.provider,
      actor: { type: meta.actor ?? "public" },
    },
    tenant.organizationId,
    request,
    { channel: "public", save: opts.save ?? false },
  );
  if (run.calculationId) {
    await deps.gateway.recordAudit(tenant.organizationId, {
      actor: meta.actor ?? "public",
      action: "pricing.calculated",
      entityType: "pricing_calculation",
      entityId: run.calculationId,
      metadata: { totalCents: run.output.summary.total, items: request.items.length },
      ipAddress: meta.ip,
      userAgent: meta.userAgent ?? null,
      requestId: meta.requestId ?? null,
    });
  }
  return run;
}

function defaultDeps(): PublicDeps {
  return { gateway: systemGateway(), rateLimit: enforceRateLimit, provider: getDistanceProvider() };
}
