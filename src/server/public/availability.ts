import "server-only";
import { z } from "zod";
import { isAvailabilityReason, type AvailabilityReason } from "@/domain/availability/reasons";
import { DomainError } from "@/domain/errors";
import { fromEngineError } from "@/server/availability/errors";
import { createPublicClient } from "@/server/db/public";
import { enforceRateLimit } from "@/server/rate-limit";
import type { RequestMeta } from "./deps";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

export interface PublicAvailability {
  available: boolean;
  /** True when this request would take the last one or two units (no exact counts, D14). */
  limited: boolean;
  reasons: AvailabilityReason[];
}

const input = z.strictObject({
  variantId: z.uuid(),
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  quantity: z.int().min(1).max(1000).default(1),
});

/**
 * Storefront / assistant availability check. The organization comes only from the server-resolved
 * tenant (ADR 0001); the database answers only for published products of active organizations.
 * Uses the anon client (no service role); rate-limited per tenant + client.
 */
export async function checkPublicAvailability(
  tenant: ResolvedTenant,
  raw: unknown,
  meta: RequestMeta,
  rateLimit: typeof enforceRateLimit = enforceRateLimit,
): Promise<PublicAvailability> {
  await rateLimit("publicQuery", `${tenant.organizationId}:${meta.ip}`);
  const req = input.parse(raw);
  const { data, error } = await createPublicClient().rpc("check_public_availability", {
    p_organization_id: tenant.organizationId,
    p_variant_id: req.variantId,
    p_start: req.start,
    p_end: req.end,
    p_quantity: req.quantity,
  });
  if (error) throw fromEngineError(error, "Product");
  const row = data[0];
  if (!row) throw new DomainError("INTERNAL");
  return {
    available: row.available,
    limited: row.limited,
    reasons: row.reasons.filter(isAvailabilityReason),
  };
}
