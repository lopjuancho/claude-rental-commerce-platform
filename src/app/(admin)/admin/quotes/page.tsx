import type { Metadata, Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { displayName } from "@/domain/customers/contact";
import { formatCents } from "@/domain/money";
import { QUOTE_STATUS_LABELS, QUOTE_STATUSES } from "@/domain/quotes/state-machine";
import { requireStaff } from "@/server/auth/context";
import { listQuotes } from "@/server/quotes/service";

export const metadata: Metadata = { title: "Quotes" };

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireStaff("org.read");
  const { status } = await searchParams;
  const quotes = await listQuotes(status);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <div className="flex gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/bookings">Booking requests</Link>
          </Button>
          {ctx.permissions.has("quotes.write") ? (
            <Button asChild size="sm">
              <Link href="/admin/quotes/new">New quote</Link>
            </Button>
          ) : null}
        </div>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm">
        <Link href="/admin/quotes" className={!status ? "font-semibold" : "underline"}>
          All
        </Link>
        {QUOTE_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/admin/quotes?status=${s}` as Route}
            className={status === s ? "font-semibold" : "underline"}
          >
            {QUOTE_STATUS_LABELS[s]}
          </Link>
        ))}
      </nav>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">Quote</th>
            <th>Customer</th>
            <th>Event</th>
            <th>Status</th>
            <th className="text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((q) => (
            <tr key={q.id} className="border-t">
              <td className="py-2">
                <Link className="underline" href={`/admin/quotes/${q.id}` as Route}>
                  {q.quote_number}
                </Link>
              </td>
              <td>{q.customers ? displayName(q.customers) : "—"}</td>
              <td>
                {q.events?.starts_at ? new Date(q.events.starts_at).toLocaleDateString() : "—"}
              </td>
              <td>
                {QUOTE_STATUS_LABELS[q.status]}
                {q.manual_review_required && !q.review_approved_at ? " · needs review" : ""}
              </td>
              <td className="text-right tabular-nums">
                {q.total_cents === null ? "—" : formatCents(q.total_cents, q.currency ?? "USD")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {quotes.length === 0 ? <p className="text-sm text-muted-foreground">No quotes.</p> : null}
    </div>
  );
}
