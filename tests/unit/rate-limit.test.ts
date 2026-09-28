import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter } from "@/server/rate-limit/memory";

describe("InMemoryRateLimiter", () => {
  it("allows up to the limit per window, then blocks, then resets", async () => {
    let now = 0;
    const limiter = new InMemoryRateLimiter(2, 1000, () => now);
    expect((await limiter.limit("k")).success).toBe(true);
    expect((await limiter.limit("k")).success).toBe(true);
    expect((await limiter.limit("k")).success).toBe(false);
    now = 1000;
    expect((await limiter.limit("k")).success).toBe(true);
  });

  it("isolates keys (one tenant cannot exhaust another's budget)", async () => {
    const limiter = new InMemoryRateLimiter(1, 1000, () => 0);
    expect((await limiter.limit("org-a:ip")).success).toBe(true);
    expect((await limiter.limit("org-a:ip")).success).toBe(false);
    expect((await limiter.limit("org-b:ip")).success).toBe(true);
  });
});
