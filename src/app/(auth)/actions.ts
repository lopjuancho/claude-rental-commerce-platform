"use server";

import type { Route } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { FormState } from "@/components/form-message";
import { safeRedirectPath } from "@/domain/http/redirect";
import { toFormError } from "@/server/actions";
import { ACTIVE_ORG_COOKIE } from "@/server/auth/context";
import { acceptInvitation } from "@/server/auth/invitations";
import { createUserClient } from "@/server/db/user";
import { getServerEnv } from "@/server/env";
import { enforceRateLimit } from "@/server/rate-limit";
import { getClientIp } from "@/server/request";

const credentials = z.object({
  email: z
    .email("Enter a valid email address.")
    .max(254)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(1, "Enter your password.").max(200),
});

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let next: string;
  try {
    const input = credentials.parse({
      email: formData.get("email"),
      password: formData.get("password"),
    });
    next = safeRedirectPath(formData.get("next"));
    await enforceRateLimit("auth", `${await getClientIp()}:${input.email}`);

    const supabase = await createUserClient();
    const { error } = await supabase.auth.signInWithPassword(input);
    // One generic message: never reveal whether the account exists.
    if (error) return { status: "error", message: "Invalid email or password." };
  } catch (error) {
    return toFormError(error);
  }
  redirect(next as Route);
}

const signUpInput = credentials.extend({
  password: z.string().min(10, "Use at least 10 characters.").max(200),
  fullName: z.string().trim().min(1, "Enter your name.").max(200),
});

/**
 * Account creation for invited staff. Accounts grant no access by themselves: access comes only
 * from accepting an invitation (organization self-service signup is not part of Phase 1).
 */
export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  let next: string;
  try {
    const input = signUpInput.parse({
      email: formData.get("email"),
      password: formData.get("password"),
      fullName: formData.get("fullName"),
    });
    next = safeRedirectPath(formData.get("next"));
    await enforceRateLimit("auth", `${await getClientIp()}:signup`);

    const origin = getServerEnv().APP_ORIGIN;
    const supabase = await createUserClient();
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: { full_name: input.fullName },
        ...(origin
          ? { emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}` }
          : {}),
      },
    });
    if (error)
      return {
        status: "error",
        message: "Could not create the account. Check the details and try again.",
      };
    if (!data.session) {
      return {
        status: "success",
        message: "Check your email to confirm your account, then return to your invitation link.",
      };
    }
  } catch (error) {
    return toFormError(error);
  }
  redirect(next as Route);
}

export async function acceptInvitationAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const token = z.string().min(32).max(200).parse(formData.get("token"));
    await enforceRateLimit("auth", `${await getClientIp()}:invite`);
    const organizationId = await acceptInvitation(token);
    (await cookies()).set(ACTIVE_ORG_COOKIE, organizationId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  } catch (error) {
    return toFormError(error);
  }
  redirect("/admin");
}

export async function signOutAction(): Promise<void> {
  const supabase = await createUserClient();
  await supabase.auth.signOut();
  (await cookies()).delete(ACTIVE_ORG_COOKIE);
  redirect("/sign-in");
}
