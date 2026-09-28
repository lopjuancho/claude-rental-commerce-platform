import { describe, expect, it } from "vitest";
import { formatPeriod, parseTstzRange } from "@/lib/ranges";

describe("tstzrange helpers", () => {
  it("parses PostgREST range output", () => {
    const r = parseTstzRange('["2027-06-19 17:00:00+00","2027-06-19 23:00:00+00")');
    expect(r?.start.toISOString()).toBe("2027-06-19T17:00:00.000Z");
    expect(r?.end.toISOString()).toBe("2027-06-19T23:00:00.000Z");
    expect(parseTstzRange("garbage")).toBeNull();
    expect(parseTstzRange(null)).toBeNull();
  });
  it("formats in the organization's time zone", () => {
    const r = parseTstzRange('["2027-06-19 17:00:00+00","2027-06-19 23:00:00+00")')!;
    expect(formatPeriod(r, "America/Chicago")).toBe("Sat, Jun 19, 12:00 PM – 6:00 PM");
  });
});
