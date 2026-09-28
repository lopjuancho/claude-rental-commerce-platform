import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getServerEnv } from "@/server/env";
import type { Database } from "@/types/database";

/**
 * Public context: publishable key, no session. Anonymous visitors have no table grants; this
 * client can only call the narrow functions/views explicitly granted to `anon`.
 */
export function createPublicClient() {
  const env = getServerEnv();
  return createClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  );
}

export type PublicClient = ReturnType<typeof createPublicClient>;
