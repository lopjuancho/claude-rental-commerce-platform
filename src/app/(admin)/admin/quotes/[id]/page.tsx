import type { Metadata, Route } from "next";
import Link from "next/link";
import { displayName } from "@/domain/customers/contact";
import { formatCents } from "@/domain/money";
import { explainReviewReason } from "@/domain/pricing/reasons";
import { canRequestBooking, QUOTE_STATUS_LABELS } from "@/domain/quotes/state-machine";
import { requireStaff } from "@/server/auth/context";
import { getQuote } from "@/server/quotes/service";
import { BookingDecision, QuoteControls } from "../quote-controls";

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

export const metadata: Metadata = { title: "Quote" };

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaff("org.read");
  const q = await getQuote((await params).id);
  const money = (c: number | null) => (c === null ? "—" : formatCents(c, q.currency ?? "USD"));
  const canWrite = ctx.permissions.has("quotes.write");
  const pending = q.bookingRequests.find((b) => b.status === "pending");
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {q.quote_number} · {QUOTE_STATUS_LABELS[q.status]}
        </h1>
        <Link className="text-sm underline" href={`/admin/quotes/${q.id}/print` as Route}>
          Print view
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        {q.customer ? (
          <Link className="underline" href={`/admin/customers/${q.customer.id}` as Route}>
            {displayName(q.customer)}
          </Link>
        ) : (
          "No customer"
        )}
        {q.event?.starts_at ? ` · ${new Date(q.event.starts_at).toLocaleString()}` : ""}
        {q.event?.address_line1
          ? ` · ${q.event.address_line1}, ${q.event.city ?? ""}`
          : " · pickup"}
        {` · source: ${q.source}`}
      </p>

      {q.pricing ? (
        <section className="grid gap-2">
          <h2 className="font-semibold">Price (engine snapshot {q.pricing.engineVersion})</h2>
          <table className="w-full text-sm">
            <tbody>
              {keyed(q.pricing.lines).map((l) => (
                <tr key={l.key} className="border-b">
                  <td className="py-1">{l.label}</td>
                  <td className="py-1 text-muted-foreground">
                    {l.taxable === null ? "" : l.taxable ? "taxable" : "not taxable"}
                  </td>
                  <td className="py-1 text-right tabular-nums">{money(l.amountCents)}</td>
                </tr>
              ))}
              {keyed(q.pricing.taxLines).map((t) => (
                <tr key={t.key}>
                  <td className="py-1">{t.name}</td>
                  <td />
                  <td className="py-1 text-right tabular-nums">{money(t.amountCents)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2">Total</td>
                <td />
                <td className="py-2 text-right tabular-nums">{money(q.total_cents)}</td>
              </tr>
            </tbody>
          </table>
          {q.manual_review_required ? (
            <div className="rounded-md border p-3 text-sm">
              <p className="font-medium">
                {q.review_approved_at
                  ? `Review approved: ${q.review_note ?? ""}`
                  : "Needs review before sending or confirming:"}
              </p>
              <ul className="list-disc pl-5">
                {(q.review_reasons ?? []).map((r) => (
                  <li key={r}>{explainReviewReason(r)}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}

      {canWrite ? (
        <QuoteControls
          id={q.id}
          status={q.status}
          manualReviewRequired={q.manual_review_required}
          reviewApprovedAt={q.review_approved_at}
          canHold={canRequestBooking(q.status) && !pending}
        />
      ) : null}

      <section className="grid gap-2">
        <h2 className="font-semibold">Booking requests</h2>
        {q.bookingRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None. A draft quote does not hold inventory.
          </p>
        ) : (
          <ul className="grid gap-3">
            {q.bookingRequests.map((b) => (
              <li key={b.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                <p>
                  {b.status} · {b.source} · {new Date(b.created_at).toLocaleString()}
                  {b.reservations?.status === "held" && b.reservations.hold_expires_at
                    ? ` · hold until ${new Date(b.reservations.hold_expires_at).toLocaleTimeString()}`
                    : ""}
                </p>
                {b.customer_message ? <p className="italic">“{b.customer_message}”</p> : null}
                {b.status === "pending" && canWrite ? (
                  <BookingDecision id={b.id} quoteId={q.id} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {q.internal_notes ? <p className="text-sm">Internal notes: {q.internal_notes}</p> : null}
    </div>
  );
}
