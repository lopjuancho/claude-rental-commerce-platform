/**
 * Initial values for the storefront quote form (ADR 0016). Prefill is a convenience only: the
 * submitted form is validated and priced by the server exactly like a blank one.
 */

/** Item rows the storefront quote form offers (the request schema allows up to 20). */
export const QUOTE_ITEM_ROWS = 10;

export interface ItemPrefill {
  variantId: string;
  quantity: number;
}

export interface EventPrefill {
  date: string;
  startTime: string;
  endTime: string;
  endDate?: string;
}

export interface QuotePrefill {
  items: ItemPrefill[];
  event: EventPrefill | null;
  /** The earlier quote's fulfilment (no event address = customer pickup). */
  delivery?: "delivery" | "pickup";
}

/** An instant as the organization's local calendar date (YYYY-MM-DD) and 24-hour time (HH:MM). */
export function localDateTime(
  iso: string,
  timeZone: string,
): { date: string; time: string } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Today's date where the organization is (the earliest selectable event date). */
export function localToday(timeZone: string, now = new Date()): string {
  return localDateTime(now.toISOString(), timeZone)?.date ?? now.toISOString().slice(0, 10);
}

/** Merge repeated variants and keep only variants still offered, capped to the form's rows. */
export function normalizeItems(items: ItemPrefill[], offered: ReadonlySet<string>): ItemPrefill[] {
  const merged = new Map<string, number>();
  for (const i of items) {
    if (!offered.has(i.variantId) || !Number.isInteger(i.quantity) || i.quantity < 1) continue;
    merged.set(i.variantId, Math.min(1000, (merged.get(i.variantId) ?? 0) + i.quantity));
  }
  return [...merged]
    .slice(0, QUOTE_ITEM_ROWS)
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}

/**
 * Prefill from an earlier quote's server view: its items and its event's current local times.
 * The address is not split back into fields; the customer confirms it again.
 */
export function prefillFromQuote(
  view: {
    items: { variantId?: string | null; quantity: number }[];
    event: { startsAt: string | null; endsAt: string | null; address?: string | null } | null;
  },
  timeZone: string,
  offered: ReadonlySet<string>,
): QuotePrefill {
  const items = normalizeItems(
    view.items.flatMap((i) =>
      i.variantId ? [{ variantId: i.variantId, quantity: i.quantity }] : [],
    ),
    offered,
  );
  const start = view.event?.startsAt ? localDateTime(view.event.startsAt, timeZone) : null;
  const end = view.event?.endsAt ? localDateTime(view.event.endsAt, timeZone) : null;
  const event =
    start && end
      ? {
          date: start.date,
          startTime: start.time,
          endTime: end.time,
          ...(end.date !== start.date ? { endDate: end.date } : {}),
        }
      : null;
  return {
    items,
    event,
    ...(view.event ? { delivery: view.event.address ? "delivery" : "pickup" } : {}),
  };
}
