import { describe } from "vitest";

/**
 * PostgREST-boundary tests (ADR 0016 §12) call the storefront loaders exactly as the app does:
 * supabase-js with the publishable key against the real API, whose `max_rows` caps every
 * response. They need NEXT_PUBLIC_SUPABASE_URL / _PUBLISHABLE_KEY (the Supabase stack in CI; a
 * local PostgREST otherwise). In CI they must never be skipped.
 */
export const restAvailable = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
if (!restAvailable && process.env.CI) {
  throw new Error("CI must run the PostgREST-boundary storefront tests (Supabase env missing)");
}
export const describeRest = restAvailable ? describe : describe.skip;
