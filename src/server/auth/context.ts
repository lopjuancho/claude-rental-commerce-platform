import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { isPermission, isRole, type Permission, type Role } from "@/domain/auth/permissions";
import { DomainError } from "@/domain/errors";
import { getSessionUser, type SessionUser } from "@/server/auth/session";
import { ACTIVE_ORG_COOKIE, requestOrgTarget } from "@/server/db/org-target";
import { createUserClient } from "@/server/db/user";

export { ACTIVE_ORG_COOKIE } from "@/server/db/org-target";

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
}

export interface StaffContext {
  user: SessionUser;
  organizationId: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
  memberships: Membership[];
}

/** Active memberships of the signed-in user, read through RLS. */
export const getMemberships = cache(async (): Promise<Membership[]> => {
  const user = await getSessionUser();
  if (!user) return [];
  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("organization_members")
    .select("organization_id, role, organizations!inner(name, slug)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at");
  if (error) throw new DomainError("INTERNAL", "Could not load memberships", { cause: error });
  return data.flatMap((m) =>
    isRole(m.role)
      ? [
          {
            organizationId: m.organization_id,
            organizationName: m.organizations.name,
            organizationSlug: m.organizations.slug,
            role: m.role,
          },
        ]
      : [],
  );
});

/**
 * Staff context for the active organization. The active organization comes from a cookie but is
 * only honoured if the user is currently an active member; RLS re-checks every query anyway.
 */
export const getStaffContext = cache(async (): Promise<StaffContext | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  const memberships = await getMemberships();
  if (memberships.length === 0) return null;

  const requested = (await cookies()).get(ACTIVE_ORG_COOKIE)?.value;
  const active = memberships.find((m) => m.organizationId === requested) ?? memberships[0];
  if (!active) return null;
  // Mutations in this request target the active organization (and only it).
  requestOrgTarget().organizationId = active.organizationId;

  const supabase = await createUserClient();
  const { data, error } = await supabase
    .from("role_permissions")
    .select("permission")
    .eq("role", active.role);
  if (error) throw new DomainError("INTERNAL", "Could not load permissions", { cause: error });

  return {
    user,
    organizationId: active.organizationId,
    role: active.role,
    permissions: new Set(data.map((r) => r.permission).filter(isPermission)),
    memberships,
  };
});

/** Throws UNAUTHENTICATED / FORBIDDEN. Use at the top of every staff server action. */
export async function requireStaff(permission?: Permission): Promise<StaffContext> {
  const ctx = await getStaffContext();
  if (!ctx) {
    const user = await getSessionUser();
    throw new DomainError(user ? "FORBIDDEN" : "UNAUTHENTICATED");
  }
  if (permission && !ctx.permissions.has(permission)) throw new DomainError("FORBIDDEN");
  return ctx;
}
