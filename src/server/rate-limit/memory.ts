import type { RateLimiter, RateLimitResult } from "./types";

/**
 * Fixed-window limiter for development and tests. Per-process only: NOT suitable for production,
 * where each Worker isolate would have its own counters.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limitPerWindow: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  limit(key: string): Promise<RateLimitResult> {
    const t = this.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= t) {
      this.windows.set(key, { count: 1, resetAt: t + this.windowMs });
      this.sweep(t);
      return Promise.resolve({ success: true });
    }
    current.count += 1;
    return Promise.resolve({ success: current.count <= this.limitPerWindow });
  }

  private sweep(t: number) {
    if (this.windows.size < 10_000) return;
    for (const [key, w] of this.windows) if (w.resetAt <= t) this.windows.delete(key);
  }
}
