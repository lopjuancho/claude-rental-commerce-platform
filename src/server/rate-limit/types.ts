export interface RateLimitResult {
  success: boolean;
}

/**
 * Keyed limiter. Keys must include the organization and the caller identity, e.g.
 * `assistant:${organizationId}:${ip}`, so one tenant's traffic never exhausts another's budget.
 */
export interface RateLimiter {
  limit(key: string): Promise<RateLimitResult>;
}

/** Named policies. Values are the fallback for the in-memory limiter; production limits live in wrangler.jsonc. */
export const RATE_LIMIT_POLICIES = {
  auth: { limit: 10, windowSeconds: 60 },
  publicWrite: { limit: 20, windowSeconds: 60 },
  /** Anonymous reads that cost work (pricing may call the maps provider; availability queries). */
  publicQuery: { limit: 60, windowSeconds: 60 },
  assistant: { limit: 30, windowSeconds: 60 },
} as const;

export type RateLimitPolicy = keyof typeof RATE_LIMIT_POLICIES;
