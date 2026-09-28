import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPeriod, parseTstzRange } from "@/lib/ranges";
import { requireStaff } from "@/server/auth/context";
import {
  getOrganizationTimezone,
  listOpenFlags,
  listUpcomingReservations,
  listVariantOptions,
} from "@/server/availability/service";
import { reservationAction, resolveFlagAction } from "./actions";
import { BookForm, CheckForm } from "./availability-forms";

export const metadata: Metadata = { title: "Availability" };

export default async function AvailabilityPage() {
  const ctx = await requireStaff("org.read");
  const canWrite = ctx.permissions.has("availability.write");
  const [options, allocations, flags, timeZone] = await Promise.all([
    listVariantOptions(),
    listUpcomingReservations(),
    listOpenFlags(),
    getOrganizationTimezone(),
  ]);

  // Group allocations by reservation for display.
  const reservations = new Map<
    string,
    { status: string; holdExpiresAt: string | null; lines: { label: string; period: string }[] }
  >();
  for (const a of allocations) {
    const range = parseTstzRange(a.rental_period);
    const name = a.product_variants.is_default
      ? a.product_variants.products.name
      : `${a.product_variants.products.name} — ${a.product_variants.name}`;
    const entry = reservations.get(a.reservation_id) ?? {
      status: a.status,
      holdExpiresAt: a.hold_expires_at,
      lines: [],
    };
    entry.lines.push({
      label: `${name}${a.inventory_units ? ` (${a.inventory_units.label})` : ` × ${a.quantity}`}`,
      period: range ? formatPeriod(range, timeZone) : "",
    });
    reservations.set(a.reservation_id, entry);
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-semibold">Availability</h1>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/availability/blocks">Blocks</Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/availability/weather">Weather</Link>
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">Times are in {timeZone}.</p>

      {flags.length > 0 ? (
        <Card className="border-amber-300">
          <CardHeader>
            <CardTitle>Bookings needing review ({flags.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {flags.map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1">{f.message}</span>
                  {canWrite ? (
                    <form action={resolveFlagAction}>
                      <input type="hidden" name="flagId" value={f.id} />
                      <Button size="sm" variant="outline" type="submit">
                        Mark reviewed
                      </Button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Check availability</CardTitle>
        </CardHeader>
        <CardContent>
          {options.length > 0 ? (
            <CheckForm options={options} />
          ) : (
            <p className="text-sm text-muted-foreground">Add products first.</p>
          )}
        </CardContent>
      </Card>

      {canWrite && options.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Manual booking or hold</CardTitle>
          </CardHeader>
          <CardContent>
            <BookForm options={options} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Upcoming (60 days)</CardTitle>
        </CardHeader>
        <CardContent>
          {reservations.size === 0 ? (
            <p className="text-sm text-muted-foreground">No upcoming reservations.</p>
          ) : null}
          <ul className="divide-y">
            {[...reservations.entries()].map(([id, r]) => (
              <li
                key={id}
                className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center"
              >
                <div>
                  {r.lines.map((l) => (
                    <p key={l.label + l.period}>
                      <span className="font-medium">{l.label}</span> · {l.period}
                    </p>
                  ))}
                  <p className="text-xs text-muted-foreground">
                    {r.status === "held"
                      ? `Hold · expires ${r.holdExpiresAt ? new Date(r.holdExpiresAt).toLocaleTimeString("en-US", { timeZone, hour: "numeric", minute: "2-digit" }) : ""}`
                      : "Confirmed"}
                  </p>
                </div>
                {canWrite ? (
                  <form action={reservationAction} className="flex gap-1">
                    <input type="hidden" name="reservationId" value={id} />
                    {r.status === "held" ? (
                      <Button size="sm" type="submit" name="intent" value="confirm">
                        Confirm
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" type="submit" name="intent" value="release">
                      {r.status === "held" ? "Release" : "Cancel"}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
