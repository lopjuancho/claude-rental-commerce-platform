import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getServerEnv } from "@/server/env";
import type { Database } from "@/types/database";
import { ACTIVE_ORG_COOKIE, isOrgId, ORG_TARGETS_HEADER, requestOrgTarget } from "./org-target";

/**
 * User context (ARCHITECTURE.md §6.2): publishable key + the signed-in user's session from
 * cookies. Every query is subject to RLS. This is the default client for staff operations.
 * Mutations declare their target organization (the active one) so the database gates only it.
 */
export async function createUserClient() {
  // Read cookies first: it marks the route dynamic, so staff pages are never prerendered.
  const cookieStore = await cookies();
  const env = getServerEnv();
  const cookieOrg = cookieStore.get(ACTIVE_ORG_COOKIE)?.value;
  const target = requestOrgTarget().organizationId ?? (isOrgId(cookieOrg) ? cookieOrg : null);
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      ...(target ? { global: { headers: { [ORG_TARGETS_HEADER]: target } } } : {}),
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          try {
            for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
          } catch {
            // Server Components cannot set cookies; the proxy refreshes the session instead.
          }
        },
      },
    },
  );
}

export type UserClient = Awaited<ReturnType<typeof createUserClient>>;
