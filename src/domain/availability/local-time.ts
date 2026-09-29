/**
 * Local wall-clock date/time in an IANA time zone → absolute instant, without dependencies.
 * Events are described in the organization's local time ("Saturday 12–6pm in Memphis") but stored
 * as timestamptz.
 *
 * A local time can map to zero instants (the spring-forward gap, e.g. 02:30 on the second Sunday
 * of March in America/Chicago), one, or two (the fall-back overlap, e.g. 01:30 on the first Sunday
 * of November). Nothing here silently picks one (hardening H4):
 *   - nonexistent → LocalTimeError("NONEXISTENT")
 *   - ambiguous   → resolved only by an explicit `fold` ("earlier" = first occurrence, daylight
 *                   time; "later" = second occurrence, standard time), otherwise
 *                   LocalTimeError("AMBIGUOUS").
 * The chosen offset is returned so it can be shown and is part of the stored instant.
 * Mirrors app.local_to_instant() in SQL (parity-tested).
 */
export type Fold = "earlier" | "later";

export class LocalTimeError extends RangeError {
  constructor(
    readonly reason: "INVALID" | "NONEXISTENT" | "AMBIGUOUS",
    message: string,
  ) {
    super(message);
    this.name = "LocalTimeError";
  }
}

function offsetMinutes(timeZone: string, instant: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return Math.round((asUtc - instant) / 60_000);
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = 86_400_000;

function wallClockAsUtc(date: string, time: string): number {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new LocalTimeError("INVALID", "Expected YYYY-MM-DD and HH:MM");
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  if (new Date(wall).getUTCDate() !== Number(d[3])) {
    throw new LocalTimeError("INVALID", "Invalid calendar date");
  }
  return wall;
}

/** Every instant whose local wall-clock time in `timeZone` is exactly date + time (0, 1 or 2). */
export function localTimeCandidates(date: string, time: string, timeZone: string): number[] {
  const wall = wallClockAsUtc(date, time);
  // Offsets in force a day either side of the transition bracket every possibility.
  const offsets = new Set([
    offsetMinutes(timeZone, wall - DAY),
    offsetMinutes(timeZone, wall + DAY),
    offsetMinutes(timeZone, wall),
  ]);
  const found = new Set<number>();
  for (const off of offsets) {
    const instant = wall - off * 60_000;
    if (offsetMinutes(timeZone, instant) === off) found.add(instant);
  }
  return [...found].sort((a, b) => a - b);
}

export interface ResolvedLocalTime {
  instant: Date;
  /** UTC offset in minutes at that instant, e.g. -300 for CDT, -360 for CST. */
  offsetMinutes: number;
  ambiguous: boolean;
}

export function resolveLocalTime(
  date: string,
  time: string,
  timeZone: string,
  fold?: Fold | null,
): ResolvedLocalTime {
  const candidates = localTimeCandidates(date, time, timeZone);
  const [first, second] = candidates;
  if (first === undefined) {
    throw new LocalTimeError(
      "NONEXISTENT",
      `${date} ${time} does not exist in ${timeZone} (clocks move forward). Choose another time.`,
    );
  }
  let instant = first;
  if (second !== undefined) {
    if (!fold) {
      throw new LocalTimeError(
        "AMBIGUOUS",
        `${date} ${time} happens twice in ${timeZone} (clocks move back). Choose the first or second occurrence.`,
      );
    }
    instant = fold === "earlier" ? first : second;
  }
  return {
    instant: new Date(instant),
    offsetMinutes: offsetMinutes(timeZone, instant),
    ambiguous: second !== undefined,
  };
}

/** Local "YYYY-MM-DD" + "HH:MM" in `timeZone` → Date (see resolveLocalTime for DST rules). */
export function localToInstant(
  date: string,
  time: string,
  timeZone: string,
  fold?: Fold | null,
): Date {
  return resolveLocalTime(date, time, timeZone, fold).instant;
}

/** "+05:00"-style offset for display and ISO strings. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * A rental described in local time. If the end time is not after the start time on the same day,
 * the rental ends the next day (overnight), unless an explicit end date is given. `fold` applies
 * to whichever endpoint is ambiguous (fall-back night); nonexistent times are always rejected.
 */
export function localRentalPeriod(input: {
  date: string;
  startTime: string;
  endTime: string;
  endDate?: string;
  timeZone: string;
  fold?: Fold | null;
}): {
  start: Date;
  end: Date;
} {
  const start = localToInstant(input.date, input.startTime, input.timeZone, input.fold);
  let endDate = input.endDate ?? input.date;
  if (!input.endDate && input.endTime <= input.startTime) {
    const next = new Date(
      Date.UTC(
        Number(input.date.slice(0, 4)),
        Number(input.date.slice(5, 7)) - 1,
        Number(input.date.slice(8, 10)) + 1,
      ),
    );
    endDate = next.toISOString().slice(0, 10);
  }
  const end = localToInstant(endDate, input.endTime, input.timeZone, input.fold);
  if (end <= start) throw new LocalTimeError("INVALID", "The rental must end after it starts");
  return { start, end };
}
