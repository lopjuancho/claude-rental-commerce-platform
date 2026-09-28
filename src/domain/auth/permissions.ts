/**
 * Mirrors public.org_role and the permission names seeded in public.role_permissions.
 * The database is the source of truth for which role holds which permission; this module only
 * provides type-safe names. An integration test asserts the two stay in sync.
 */
export const ROLES = ["owner", "admin", "office", "staff"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "org.read",
  "org.delete",
  "catalog.write",
  "availability.write",
  "customers.read",
  "customers.write",
  "events.write",
  "quotes.write",
  "conversations.read",
  "pricing.write",
  "settings.write",
  "members.manage",
  "members.grant_owner",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);
export const isPermission = (value: unknown): value is Permission =>
  PERMISSIONS.includes(value as Permission);

/** Roles a member holding `grantorPermissions` may assign. Owner requires members.grant_owner. */
export function assignableRoles(grantorPermissions: ReadonlySet<Permission>): Role[] {
  if (!grantorPermissions.has("members.manage")) return [];
  return ROLES.filter((role) => role !== "owner" || grantorPermissions.has("members.grant_owner"));
}
