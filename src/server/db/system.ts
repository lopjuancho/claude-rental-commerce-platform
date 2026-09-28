import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/server/env";
import type { Database } from "@/types/database";

/**
 * System context — service-role key, BYPASSES RLS (ADR 0001).
 *
 * Only allow-listed modules may import this (enforced by ESLint `no-restricted-imports`).
 * Every caller must scope each query to an organization id obtained from server-side tenant
 * resolution (`ResolvedTenant`) or a verified staff context — never from request input.
 */
export function createSystemClient() {
  const env = getServerEnv();
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export type SystemClient = ReturnType<typeof createSystemClient>;
