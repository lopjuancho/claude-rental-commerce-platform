import "server-only";
import { cache } from "react";

/**
 * The organization a staff request mutates (ADR 0015 §16). The staff context records the active
 * organization it resolved; the user client sends it as `x-org-targets`, so the database takes that
 * organization's gate — and only that one — before any row lock. The database ignores a declared
 * organization in which the user may not write.
 */
export const ORG_TARGETS_HEADER = "x-org-targets";
export const ACTIVE_ORG_COOKIE = "active_org";

export const requestOrgTarget = cache((): { organizationId: string | null } => ({
  organizationId: null,
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isOrgId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
