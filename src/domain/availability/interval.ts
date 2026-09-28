/**
 * Half-open time intervals [start, end) in epoch milliseconds. Half-open means a booking ending
 * at 14:00 and another starting at 14:00 do not overlap. Mirrors PostgreSQL tstzrange '[)'.
 */
export interface Interval {
  start: number;
  end: number;
}

export function interval(start: Date | string | number, end: Date | string | number): Interval {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) throw new RangeError("Invalid date");
  if (e <= s) throw new RangeError("Interval end must be after start");
  return { start: s, end: e };
}

export const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

export function intersect(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

/** The period inventory is out of the warehouse: rental widened by setup and pickup buffers. */
export function occupiedPeriod(
  rental: Interval,
  setupBufferMinutes: number,
  teardownBufferMinutes: number,
): Interval {
  if (setupBufferMinutes < 0 || teardownBufferMinutes < 0)
    throw new RangeError("Buffers cannot be negative");
  return {
    start: rental.start - setupBufferMinutes * 60_000,
    end: rental.end + teardownBufferMinutes * 60_000,
  };
}
