import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TenantTheme } from "@/components/tenant-theme";
import { formatCents } from "@/domain/money";
import { getPublicQuote } from "@/server/public/quotes";
import { getRequestTenant } from "@/server/tenancy/resolve-tenant";
import { HoldStatus, RequestBooking } from "./booking-controls";

/** Stable React keys for engine lines (labels can repeat, e.g. the same item twice). */
function keyed<T extends object>(rows: readonly T[] | undefined) {
  const seen = new Map<string, number>();
  return (rows ?? []).map((row) => {
    const base = JSON.stringify(row);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { ...row, key: `${base}#${n}` };
  });
}

export const metadata: Metadata = { title: "Your quote", robots: { index: false, follow: false } };

const STATUS_TEXT: Record<string, string> = {
  draft: "Quote",
  sent: "Quote",
  viewed: "Quote",
  accepted: "Booking confirmed",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
};

/**
 * The customer's quote. Everything shown comes from the stored engine snapshot; nothing is
 * recalculated or invented here. The link token is the only credential and is scoped to the
 * host-resolved tenant.
 */
export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const tenant = await getRequestTenant();
  if (!tenant) notFound();
  const { token } = await params;
  const q = await getPublicQuote(tenant, token);
  if (!q) notFound();
  const money = (c: number) => formatCents(c, q.currency);
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: tenant.timezone,
        }).format(new Date(iso))
      : "—";

  return (
    <TenantTheme
      primaryColor={tenant.branding.primaryColor}
      secondaryColor={tenant.branding.secondaryColor}
    >
      <main className="mx-auto grid max-w-2xl gap-6 px-5 py-10">
        <header className="grid gap-1">
          <p className="text-sm font-medium uppercase tracking-wide text-accent">{tenant.name}</p>
          <h1 className="text-3xl font-bold tracking-tight">
            {STATUS_TEXT[q.status]} {q.quoteNumber}
          </h1>
          {q.event ? (
            <p className="text-muted-foreground">
              {when(q.event.startsAt)} – {when(q.event.endsAt)}
              {q.event.address ? ` · ${q.event.address}` : " · Customer pickup"}
            </p>
          ) : null}
        </header>

        {!q.priceIsFinal ? (
          <p
            role="note"
            className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            This is an estimate. Our team will confirm the final price (for example tax or delivery)
            before your booking is confirmed.
          </p>
        ) : null}

        <table className="w-full text-sm">
          <tbody>
            {keyed(q.lines).map((l) => (
              <tr key={l.key} className="border-b">
                <td className="py-2">{l.label}</td>
                <td className="py-2 text-right tabular-nums">{money(l.amountCents)}</td>
              </tr>
            ))}
            <tr>
              <td className="py-2 font-medium">Subtotal</td>
              <td className="py-2 text-right font-medium tabular-nums">{money(q.subtotalCents)}</td>
            </tr>
            {keyed(q.taxLines).map((t) => (
              <tr key={t.key}>
                <td className="py-1">{t.name}</td>
                <td className="py-1 text-right tabular-nums">{money(t.amountCents)}</td>
              </tr>
            ))}
            <tr className="border-t">
              <td className="py-2 text-base font-semibold">
                {q.priceIsFinal ? "Total" : "Estimated total"}
              </td>
              <td className="py-2 text-right text-base font-semibold tabular-nums">
                {money(q.totalCents)}
              </td>
            </tr>
          </tbody>
        </table>

        {q.expired ? <p>This quote has expired. Please request a new one.</p> : null}
        {q.booking?.status === "pending" && q.booking.holdActive && q.booking.holdExpiresAt ? (
          <HoldStatus token={token} until={q.booking.holdExpiresAt} />
        ) : null}
        {q.booking?.status === "pending" && !q.booking.holdActive ? (
          <p className="text-sm text-muted-foreground">
            Your booking request was received. The hold has ended, so our team will re-check
            availability when they confirm.
          </p>
        ) : null}
        {q.booking?.status === "confirmed" ? (
          <p>Your booking is confirmed. See you there!</p>
        ) : null}
        {q.canRequestBooking && q.booking?.status !== "pending" ? (
          <RequestBooking token={token} />
        ) : null}
        {q.expiresAt && !q.expired ? (
          <p className="text-xs text-muted-foreground">Quote valid until {when(q.expiresAt)}.</p>
        ) : null}
      </main>
    </TenantTheme>
  );
}
