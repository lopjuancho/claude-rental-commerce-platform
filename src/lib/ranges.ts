/** Parses a PostgreSQL tstzrange literal such as ["2027-06-19 17:00:00+00","2027-06-19 23:00:00+00"). */
export function parseTstzRange(value: unknown): { start: Date; end: Date } | null {
  if (typeof value !== "string") return null;
  const m = /^[[(]"?([^",]+)"?,"?([^",]+)"?[\])]$/.exec(value.trim());
  if (!m?.[1] || !m[2]) return null;
  // Postgres prints offsets as "+00"; JavaScript needs "+00:00".
  const toDate = (v: string) => new Date(v.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  const start = toDate(m[1]);
  const end = toDate(m[2]);
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) ? null : { start, end };
}

/** "Sat, Jun 19, 12:00 PM – 6:00 PM" in the organization's time zone. */
export function formatPeriod(range: { start: Date; end: Date }, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const sameDay = day.format(range.start) === day.format(range.end);
  return sameDay
    ? `${day.format(range.start)}, ${time.format(range.start)} – ${time.format(range.end)}`
    : `${day.format(range.start)} ${time.format(range.start)} – ${day.format(range.end)} ${time.format(range.end)}`;
}
