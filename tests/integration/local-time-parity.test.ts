import { describe, expect, it } from "vitest";
import { LocalTimeError, localToInstant, type Fold } from "@/domain/availability/local-time";
import { admin } from "./support/db";

/**
 * Hardening H4: app.local_to_instant (SQL) and resolveLocalTime (TS) agree on every local time of
 * DST transition days — the same instant, or the same refusal — for several zones, including one
 * with a 30-minute shift.
 */
const CASES: [string, string][] = [
  ["America/Chicago", "2027-03-14"],
  ["America/Chicago", "2027-11-07"],
  ["America/New_York", "2027-03-14"],
  ["America/Denver", "2027-11-07"],
  ["Europe/London", "2027-03-28"],
  ["Europe/London", "2027-10-31"],
  ["Australia/Lord_Howe", "2027-04-04"],
  ["Australia/Lord_Howe", "2027-10-03"],
  ["America/Phoenix", "2027-03-14"],
];

function ts(date: string, time: string, zone: string, fold: Fold | null): string {
  try {
    return localToInstant(date, time, zone, fold).toISOString();
  } catch (e) {
    if (e instanceof LocalTimeError) return e.reason === "AMBIGUOUS" ? "AMBIGUOUS" : "NONEXISTENT";
    throw e;
  }
}

async function sql(date: string, time: string, zone: string, fold: Fold | null): Promise<string> {
  try {
    const r = await admin<{ t: Date }>(
      "select app.local_to_instant(($1 || ' ' || $2)::timestamp, $3, $4) as t",
      [date, time, zone, fold],
    );
    return r.rows[0]!.t.toISOString();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    if (err.code !== "RA012") throw e;
    return err.message?.includes("occurs twice") ? "AMBIGUOUS" : "NONEXISTENT";
  }
}

describe("local time → instant: TS/SQL parity on DST transition days", () => {
  it.each(CASES)("%s on %s, every 15 minutes, with and without a fold", async (zone, date) => {
    const seen = new Set<string>();
    for (let m = 0; m < 1440; m += 15) {
      const time = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      for (const fold of [null, "earlier", "later"] as const) {
        const a = ts(date, time, zone, fold);
        const b = await sql(date, time, zone, fold);
        expect({ time, fold, sql: b }).toEqual({ time, fold, sql: a });
        if (a === "AMBIGUOUS" || a === "NONEXISTENT") seen.add(a);
      }
    }
    // Every DST zone case exercises at least one edge; Phoenix (no DST) none.
    expect(seen.size > 0).toBe(zone !== "America/Phoenix");
  });

  it("SQL rejects 2:30 AM on spring-forward day and needs a fold at 1:30 AM on fall-back day", async () => {
    expect(await sql("2027-03-14", "02:30", "America/Chicago", "earlier")).toBe("NONEXISTENT");
    expect(await sql("2027-11-07", "01:30", "America/Chicago", null)).toBe("AMBIGUOUS");
    expect(await sql("2027-11-07", "01:30", "America/Chicago", "earlier")).toBe(
      "2027-11-07T06:30:00.000Z",
    );
    expect(await sql("2027-11-07", "01:30", "America/Chicago", "later")).toBe(
      "2027-11-07T07:30:00.000Z",
    );
  });
});
