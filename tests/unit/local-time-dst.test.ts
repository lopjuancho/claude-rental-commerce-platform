import { describe, expect, it } from "vitest";
import {
  LocalTimeError,
  formatOffset,
  localRentalPeriod,
  localTimeCandidates,
  localToInstant,
  resolveLocalTime,
} from "@/domain/availability/local-time";

/**
 * Hardening H4: nonexistent local times are rejected, ambiguous ones need an explicit choice.
 * America/Chicago 2027: spring forward Sun Mar 14 02:00 → 03:00; fall back Sun Nov 7 02:00 → 01:00.
 */
const tz = "America/Chicago";
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof LocalTimeError ? e.reason : "other";
  }
  return "none";
};

describe("spring forward (2027-03-14, America/Chicago)", () => {
  it("02:00–02:59 do not exist and are rejected, never shifted", () => {
    for (const t of ["02:00", "02:30", "02:59"]) {
      expect(localTimeCandidates("2027-03-14", t, tz)).toEqual([]);
      expect(reason(() => localToInstant("2027-03-14", t, tz))).toBe("NONEXISTENT");
      // A fold choice does not make a nonexistent time valid.
      expect(reason(() => localToInstant("2027-03-14", t, tz, "earlier"))).toBe("NONEXISTENT");
    }
  });

  it("the times either side resolve normally (CST before, CDT after)", () => {
    expect(resolveLocalTime("2027-03-14", "01:59", tz)).toMatchObject({
      offsetMinutes: -360,
      ambiguous: false,
    });
    expect(localToInstant("2027-03-14", "01:59", tz).toISOString()).toBe(
      "2027-03-14T07:59:00.000Z",
    );
    expect(localToInstant("2027-03-14", "03:00", tz).toISOString()).toBe(
      "2027-03-14T08:00:00.000Z",
    );
  });

  it("a rental starting or ending in the gap is rejected", () => {
    expect(
      reason(() =>
        localRentalPeriod({
          date: "2027-03-13",
          startTime: "20:00",
          endTime: "02:30",
          timeZone: tz,
        }),
      ),
    ).toBe("NONEXISTENT");
  });

  it("an overnight rental across the gap is 1 hour shorter on the clock", () => {
    const p = localRentalPeriod({
      date: "2027-03-13",
      startTime: "20:00",
      endTime: "08:00",
      timeZone: tz,
    });
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(11);
  });
});

describe("fall back (2027-11-07, America/Chicago)", () => {
  it("01:00–01:59 happen twice: two candidates one hour apart", () => {
    expect(
      localTimeCandidates("2027-11-07", "01:30", tz).map((t) => new Date(t).toISOString()),
    ).toEqual([
      "2027-11-07T06:30:00.000Z", // CDT (UTC−5), first occurrence
      "2027-11-07T07:30:00.000Z", // CST (UTC−6), second occurrence
    ]);
  });

  it("without a choice the time is rejected (no silent pick)", () => {
    expect(reason(() => localToInstant("2027-11-07", "01:30", tz))).toBe("AMBIGUOUS");
    expect(
      reason(() =>
        localRentalPeriod({
          date: "2027-11-06",
          startTime: "20:00",
          endTime: "01:30",
          timeZone: tz,
        }),
      ),
    ).toBe("AMBIGUOUS");
  });

  it("an explicit choice is deterministic and carries its offset", () => {
    const earlier = resolveLocalTime("2027-11-07", "01:30", tz, "earlier");
    const later = resolveLocalTime("2027-11-07", "01:30", tz, "later");
    expect(earlier).toMatchObject({ offsetMinutes: -300, ambiguous: true });
    expect(later).toMatchObject({ offsetMinutes: -360, ambiguous: true });
    expect(earlier.instant.toISOString()).toBe("2027-11-07T06:30:00.000Z");
    expect(later.instant.toISOString()).toBe("2027-11-07T07:30:00.000Z");
    expect(formatOffset(earlier.offsetMinutes)).toBe("-05:00");
    expect(formatOffset(later.offsetMinutes)).toBe("-06:00");
  });

  it("unambiguous times on the same day ignore the choice", () => {
    expect(localToInstant("2027-11-07", "00:59", tz, "later").toISOString()).toBe(
      "2027-11-07T05:59:00.000Z",
    );
    expect(localToInstant("2027-11-07", "02:00", tz, "earlier").toISOString()).toBe(
      "2027-11-07T08:00:00.000Z",
    );
  });

  it("an overnight rental across the change is 1 hour longer on the clock", () => {
    const p = localRentalPeriod({
      date: "2027-11-06",
      startTime: "20:00",
      endTime: "08:00",
      timeZone: tz,
    });
    expect((p.end.getTime() - p.start.getTime()) / 3_600_000).toBe(13);
  });
});

describe("other zones and ordinary days", () => {
  it("zones without DST have exactly one candidate", () => {
    expect(localTimeCandidates("2027-03-14", "02:30", "America/Phoenix")).toHaveLength(1);
    expect(localTimeCandidates("2027-11-07", "01:30", "UTC")).toHaveLength(1);
  });
  it("every minute of an ordinary day has exactly one candidate", () => {
    for (let m = 0; m < 1440; m += 7) {
      const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      expect(localTimeCandidates("2027-06-19", t, tz)).toHaveLength(1);
    }
  });
});
