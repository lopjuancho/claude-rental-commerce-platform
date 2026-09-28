/**
 * Converts a local wall-clock date/time in an IANA time zone into an absolute instant, without
 * dependencies. Events are described in the organization's local time ("Saturday 12–6pm in
 * Memphis") but stored as timestamptz.
 */
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

/**
 * Local "YYYY-MM-DD" + "HH:MM" in `timeZone` → Date. Nonexistent times (spring-forward gap) resolve
 * forward; ambiguous times (fall-back) resolve to the first occurrence.
 */
export function localToInstant(date: string, time: string, timeZone: string): Date {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new RangeError("Expected YYYY-MM-DD and HH:MM");
  const wallAsUtc = Date.UTC(
    Number(d[1]),
    Number(d[2]) - 1,
    Number(d[3]),
    Number(t[1]),
    Number(t[2]),
  );
  if (new Date(wallAsUtc).getUTCDate() !== Number(d[3]))
    throw new RangeError("Invalid calendar date");
  // Two passes handle instants near a DST transition.
  let instant = wallAsUtc - offsetMinutes(timeZone, wallAsUtc) * 60_000;
  instant = wallAsUtc - offsetMinutes(timeZone, instant) * 60_000;
  return new Date(instant);
}

/**
 * A rental described in local time. If the end time is not after the start time on the same day,
 * the rental ends the next day (overnight), unless an explicit end date is given.
 */
export function localRentalPeriod(input: {
  date: string;
  startTime: string;
  endTime: string;
  endDate?: string;
  timeZone: string;
}): {
  start: Date;
  end: Date;
} {
  const start = localToInstant(input.date, input.startTime, input.timeZone);
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
  const end = localToInstant(endDate, input.endTime, input.timeZone);
  if (end <= start) throw new RangeError("The rental must end after it starts");
  return { start, end };
}
