import { describe, expect, it } from "vitest";
import { peakUsage, pooledAvailable, type Usage } from "@/domain/availability/capacity";
import { interval, intersect, occupiedPeriod, overlaps } from "@/domain/availability/interval";
import { localRentalPeriod, localToInstant } from "@/domain/availability/local-time";
import { engineErrorFromSqlState } from "@/domain/availability/reasons";

const h = (hour: number) => Date.UTC(2027, 5, 19, hour);
const iv = (a: number, b: number) => ({ start: h(a), end: h(b) });

describe("intervals (half-open)", () => {
  it("back-to-back intervals do not overlap", () => {
    expect(overlaps(iv(10, 14), iv(14, 18))).toBe(false);
    expect(overlaps(iv(12, 18), iv(15, 20))).toBe(true);
    expect(intersect(iv(10, 14), iv(14, 18))).toBeNull();
  });
  it("rejects empty or reversed intervals", () => {
    expect(() => interval("2027-06-19T14:00Z", "2027-06-19T14:00Z")).toThrow();
    expect(() => interval("2027-06-19T14:00Z", "2027-06-19T12:00Z")).toThrow();
    expect(() => interval("nope", "2027-06-19T12:00Z")).toThrow();
  });
  it("occupied period adds setup and pickup buffers", () => {
    expect(occupiedPeriod(iv(12, 18), 60, 60)).toEqual(iv(11, 19));
    expect(() => occupiedPeriod(iv(12, 18), -1, 0)).toThrow();
  });
});

describe("peakUsage", () => {
  it("counts the maximum simultaneous quantity, not the sum", () => {
    const usages: Usage[] = [
      { period: iv(10, 14), quantity: 60 },
      { period: iv(15, 19), quantity: 60 },
    ];
    expect(peakUsage(iv(12, 16), usages)).toBe(60);
    expect(pooledAvailable(100, iv(12, 16), usages)).toBe(40);
  });
  it("treats touching usages as sequential", () => {
    expect(
      peakUsage(iv(0, 24), [
        { period: iv(10, 14), quantity: 5 },
        { period: iv(14, 18), quantity: 5 },
      ]),
    ).toBe(5);
  });
  it("ignores usages outside the window", () => {
    expect(peakUsage(iv(12, 13), [{ period: iv(14, 18), quantity: 9 }])).toBe(0);
  });
  it("matches brute force on random inputs", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let trial = 0; trial < 500; trial++) {
      const usages: Usage[] = Array.from({ length: rand(8) }, () => {
        const a = rand(24);
        return { period: iv(a, a + 1 + rand(6)), quantity: 1 + rand(5) };
      });
      const w0 = rand(24);
      const window = iv(w0, w0 + 1 + rand(8));
      let brute = 0;
      for (let t = window.start; t < window.end; t += 60_000 * 30) {
        const level = usages
          .filter((u) => u.period.start <= t && t < u.period.end)
          .reduce((s, u) => s + u.quantity, 0);
        brute = Math.max(brute, level);
      }
      expect(peakUsage(window, usages)).toBe(brute);
    }
  });
});

describe("local time → instant (America/Chicago)", () => {
  const tz = "America/Chicago";
  it("summer (CDT, UTC−5)", () => {
    expect(localToInstant("2027-06-19", "12:00", tz).toISOString()).toBe(
      "2027-06-19T17:00:00.000Z",
    );
  });
  it("winter (CST, UTC−6)", () => {
    expect(localToInstant("2027-01-16", "12:00", tz).toISOString()).toBe(
      "2027-01-16T18:00:00.000Z",
    );
  });
  it("overnight rental ends the next day and spans the fall-back change correctly", () => {
    const p = localRentalPeriod({
      date: "2026-10-31",
      startTime: "18:00",
      endTime: "10:00",
      timeZone: tz,
    });
    expect(p.start.toISOString()).toBe("2026-10-31T23:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-11-01T16:00:00.000Z");
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(17);
  });
  it("explicit multi-day end date", () => {
    const p = localRentalPeriod({
      date: "2027-06-18",
      startTime: "17:00",
      endDate: "2027-06-20",
      endTime: "12:00",
      timeZone: tz,
    });
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(43);
  });
  it("rejects malformed input", () => {
    expect(() => localToInstant("2027-02-30", "12:00", tz)).toThrow();
    expect(() => localToInstant("2027-06-19", "25:00", tz)).toThrow();
    expect(() =>
      localRentalPeriod({
        date: "2027-06-19",
        startTime: "12:00",
        endDate: "2027-06-18",
        endTime: "13:00",
        timeZone: tz,
      }),
    ).toThrow();
  });
});

describe("engine error mapping", () => {
  it("maps RA SQLSTATEs and ignores others", () => {
    expect(engineErrorFromSqlState("RA001")).toBe("INSUFFICIENT_AVAILABILITY");
    expect(engineErrorFromSqlState("RA004")).toBe("HOLD_EXPIRED");
    expect(engineErrorFromSqlState("23505")).toBeNull();
    expect(engineErrorFromSqlState(undefined)).toBeNull();
  });
});
