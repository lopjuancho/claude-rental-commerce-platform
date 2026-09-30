import "server-only";
import { type PostalAddress, postalAddressSchema } from "@/domain/delivery/address";
import { quoteDelivery } from "@/domain/delivery/quote";
import { areaContextSchema, deliveryConfig, pricingContextSchema } from "@/domain/pricing/context";
import type { DeliveryResult } from "@/domain/pricing/types";
import { fromEngineError } from "@/server/availability/errors";
import { getDistanceProvider } from "@/server/delivery/provider";
import { gatewayCache } from "@/server/pricing/run";
import { enforceRateLimit } from "@/server/rate-limit";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { GatewayError, systemGateway } from "@/server/trusted/gateway";
import type { PublicDeps, RequestMeta } from "./deps";

/**
 * Does the tenant deliver to this address, and for how much? Exactly the M4 delivery decision
 * (`quoteDelivery`: service areas decide where, mileage settings how much, anything uncertain is
 * manual review) with the organization's own configuration — used by the assistant before a
 * full price. The organization is only the server-resolved tenant.
 */
export async function checkPublicServiceArea(
  tenant: ResolvedTenant,
  raw: unknown,
  meta: RequestMeta,
  deps: PublicDeps = defaultDeps(),
): Promise<{ address: PostalAddress; delivery: DeliveryResult; currency: string }> {
  await deps.rateLimit("publicQuery", `${tenant.organizationId}:${meta.ip}`);
  const address = postalAddressSchema.strict().parse(raw);
  const org = tenant.organizationId;
  try {
    const context = pricingContextSchema.parse(await deps.gateway.pricingContext(org, []));
    const area = areaContextSchema.parse(
      await deps.gateway.deliveryAreaContext(org, address.city, address.state, address.postalCode),
    );
    const delivery = await quoteDelivery({
      destination: address,
      config: deliveryConfig(context),
      area,
      provider: deps.provider,
      cache: gatewayCache(deps.gateway, org),
      currency: context.organization.currency,
    });
    return { address, delivery, currency: context.organization.currency };
  } catch (e) {
    if (e instanceof GatewayError) throw fromEngineError(e.db, "Delivery");
    throw e;
  }
}

function defaultDeps(): PublicDeps {
  return { gateway: systemGateway(), rateLimit: enforceRateLimit, provider: getDistanceProvider() };
}
