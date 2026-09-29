import "server-only";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import { systemGateway, type TrustedGateway } from "@/server/trusted/gateway";
import type { UserClient } from "@/server/db/user";
import type { Json } from "@/types/database";

export interface AuditEvent {
  action: `${string}.${string}`;
  entityType: string;
  entityId?: string;
  metadata?: Json;
  requestId?: string;
}

/**
 * Semantic audit event by a signed-in staff member. The database stamps the actor from the JWT
 * and rejects organizations the caller does not belong to.
 */
export async function recordStaffAuditEvent(
  client: UserClient,
  organizationId: string,
  event: AuditEvent,
) {
  const { error } = await client.rpc("record_audit_event", {
    p_organization_id: organizationId,
    p_action: event.action,
    p_entity_type: event.entityType,
    ...(event.entityId === undefined ? {} : { p_entity_id: event.entityId }),
    ...(event.metadata === undefined ? {} : { p_metadata: event.metadata }),
    ...(event.requestId === undefined ? {} : { p_request_id: event.requestId }),
  });
  if (error) throw new Error("Audit write failed", { cause: error });
}

/**
 * Audit event for anonymous/public or AI-initiated writes (ADR 0001). The organization always
 * comes from a server-resolved tenant, never from input.
 */
export async function recordPublicAuditEvent(
  tenant: ResolvedTenant,
  actor: "public" | "ai" | "system",
  event: AuditEvent & { ipAddress?: string; userAgent?: string },
  gateway: TrustedGateway = systemGateway(),
) {
  await gateway.recordAudit(tenant.organizationId, {
    actor,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    ...(event.metadata === undefined ? {} : { metadata: event.metadata }),
    requestId: event.requestId ?? null,
    ipAddress: event.ipAddress ?? null,
    userAgent: event.userAgent ?? null,
  });
}
