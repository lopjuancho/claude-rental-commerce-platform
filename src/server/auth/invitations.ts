import "server-only";
import { z } from "zod";
import type { Role } from "@/domain/auth/permissions";
import { assignableRoles, ROLES } from "@/domain/auth/permissions";
import { DomainError } from "@/domain/errors";
import { requireStaff } from "@/server/auth/context";
import { createUserClient } from "@/server/db/user";

export const INVITATION_TTL_DAYS = 7;

export const createInvitationInput = z.object({
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  role: z.enum(ROLES),
});

/** 256-bit random token, base64url. Only its SHA-256 hash is stored. Uses Web Crypto (Workers-safe). */
export function generateInvitationToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates an invitation in the active organization. Authorization is enforced twice: here
 * (members.manage, owner-only for owner invitations) and by RLS + the invitation trigger.
 * Returns the raw token exactly once so the caller can build the invitation link.
 */
export async function createInvitation(
  input: unknown,
): Promise<{ token: string; role: Role; email: string }> {
  const ctx = await requireStaff("members.manage");
  const { email, role } = createInvitationInput.parse(input);
  if (!assignableRoles(ctx.permissions).includes(role)) throw new DomainError("FORBIDDEN");

  const token = generateInvitationToken();
  const supabase = await createUserClient();
  const { error } = await supabase.from("organization_invitations").insert({
    organization_id: ctx.organizationId,
    email,
    role,
    token_hash: await hashInvitationToken(token),
    invited_by: ctx.user.id,
    expires_at: new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000).toISOString(),
  });
  if (error)
    throw new DomainError(
      error.code === "42501" ? "FORBIDDEN" : "INTERNAL",
      "Could not create invitation",
      { cause: error },
    );
  return { token, role, email };
}

/** Accepts an invitation for the signed-in user. Returns the organization joined. */
export async function acceptInvitation(token: string): Promise<string> {
  const supabase = await createUserClient();
  const { data, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error) {
    if (error.code === "42501") throw new DomainError("UNAUTHENTICATED");
    if (error.code === "23505") throw new DomainError("CONFLICT", "Already a member");
    throw new DomainError("INVALID_INPUT", "This invitation is invalid or has expired");
  }
  return data;
}
