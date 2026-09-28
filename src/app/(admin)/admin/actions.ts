"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { toFormError } from "@/server/actions";
import { ACTIVE_ORG_COOKIE, getMemberships, requireStaff } from "@/server/auth/context";
import { createInvitation } from "@/server/auth/invitations";
import { createUserClient } from "@/server/db/user";
import { getServerEnv } from "@/server/env";

/** Switches the active organization. Only organizations the user is an active member of are accepted. */
export async function switchOrganizationAction(formData: FormData): Promise<void> {
  const organizationId = z.uuid().parse(formData.get("organizationId"));
  const memberships = await getMemberships();
  if (!memberships.some((m) => m.organizationId === organizationId)) redirect("/admin");
  (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  redirect("/admin");
}

export interface InviteState extends FormState {
  inviteUrl?: string;
}

export async function inviteMemberAction(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  try {
    // Audited by the organization_invitations trigger (actor = current user).
    const { token, email } = await createInvitation({
      email: formData.get("email"),
      role: formData.get("role"),
    });
    revalidatePath("/admin/members");
    const origin = getServerEnv().APP_ORIGIN ?? "";
    return {
      status: "success",
      message: `Invitation created for ${email}. Share this link with them — it is shown only once and expires in 7 days.`,
      inviteUrl: `${origin}/invite?token=${encodeURIComponent(token)}`,
    };
  } catch (error) {
    return toFormError(error);
  }
}

export async function revokeInvitationAction(formData: FormData): Promise<void> {
  const ctx = await requireStaff("members.manage");
  const id = z.uuid().parse(formData.get("invitationId"));
  const supabase = await createUserClient();
  // RLS restricts this to the caller's organization; the explicit filter documents intent.
  await supabase
    .from("organization_invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .is("accepted_at", null);
  revalidatePath("/admin/members");
}
