import "server-only";
import { cache } from "react";
import { createUserClient } from "@/server/db/user";

export interface SessionUser {
  id: string;
  email: string | null;
}

/**
 * The authenticated user for this request, verified with the Supabase Auth server
 * (`getUser()` validates the token; decoded cookies alone are never trusted).
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabase = await createUserClient();
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return { id: data.user.id, email: data.user.email ?? null };
});
