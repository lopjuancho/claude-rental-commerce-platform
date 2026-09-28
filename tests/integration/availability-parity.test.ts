import { describe, expect, it } from "vitest";
import { peakUsage, type Usage } from "@/domain/availability/capacity";
import { admin } from "./support/db";

/** The TypeScript mirror and the SQL engine must agree exactly on peak usage. */
describe("peak usage parity: src/domain/availability vs app.peak_usage", () => {
  it("agrees on 200 random cases", async () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const base = Date.UTC(2027, 5, 19);
    const at = (min: number) => base + min * 60_000;
    for (let trial = 0; trial < 200; trial++) {
      const usages: Usage[] = Array.from({ length: rand(10) }, () => {
        const a = rand(1440);
        return { period: { start: at(a), end: at(a + 15 + rand(600)) }, quantity: 1 + rand(20) };
      });
      const w = rand(1440);
      const window = { start: at(w), end: at(w + 30 + rand(600)) };
      const iso = (ms: number) => new Date(ms).toISOString();
      const { rows } = await admin<{ peak: number }>(
        "select app.peak_usage(tstzrange($1, $2), $3::tstzrange[], $4::int[]) as peak",
        [
          iso(window.start),
          iso(window.end),
          usages.map((u) => `[${iso(u.period.start)},${iso(u.period.end)})`),
          usages.map((u) => u.quantity),
        ],
      );
      expect(rows[0]!.peak).toBe(peakUsage(window, usages));
    }
  });
});
