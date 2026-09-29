import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { DomainError } from "@/domain/errors";
import { getServerEnv } from "@/server/env";
import { InMemoryRateLimiter } from "./memory";
import { RATE_LIMIT_POLICIES, type RateLimiter, type RateLimitPolicy } from "./types";

/** Shape of a Cloudflare Workers Rate Limiting binding (see wrangler.jsonc `ratelimits`). */
interface CloudflareRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const BINDINGS: Record<RateLimitPolicy, string> = {
  auth: "AUTH_RATE_LIMITER",
  publicWrite: "PUBLIC_WRITE_RATE_LIMITER",
  publicQuery: "PUBLIC_QUERY_RATE_LIMITER",
  assistant: "ASSISTANT_RATE_LIMITER",
};

const memoryLimiters = new Map<RateLimitPolicy, InMemoryRateLimiter>();

function cloudflareLimiter(policy: RateLimitPolicy): RateLimiter | null {
  try {
    const env = getCloudflareContext().env as unknown as Record<string, unknown>;
    const binding = env[BINDINGS[policy]] as CloudflareRateLimitBinding | undefined;
    return binding ? { limit: (key) => binding.limit({ key }) } : null;
  } catch {
    return null; // not running on Workers (next dev / tests)
  }
}

export function getRateLimiter(policy: RateLimitPolicy): RateLimiter {
  const cf = cloudflareLimiter(policy);
  if (cf) return cf;
  if (getServerEnv().APP_ENV !== "development") {
    // Fail closed rather than silently running without limits in staging/production.
    throw new Error(`Rate limit binding ${BINDINGS[policy]} is not configured`);
  }
  let limiter = memoryLimiters.get(policy);
  if (!limiter) {
    const { limit, windowSeconds } = RATE_LIMIT_POLICIES[policy];
    limiter = new InMemoryRateLimiter(limit, windowSeconds * 1000);
    memoryLimiters.set(policy, limiter);
  }
  return limiter;
}

/** Throws RATE_LIMITED when the key has exhausted the policy's budget. */
export async function enforceRateLimit(policy: RateLimitPolicy, key: string): Promise<void> {
  const { success } = await getRateLimiter(policy).limit(`${policy}:${key}`);
  if (!success) throw new DomainError("RATE_LIMITED");
}
