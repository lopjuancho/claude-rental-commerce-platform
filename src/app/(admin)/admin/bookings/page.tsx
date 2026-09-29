import type { Metadata, Route } from "next";
import Link from "next/link";
import { displayName } from "@/domain/customers/contact";
import { formatCents } from "@/domain/money";
import { requireStaff } from "@/server/auth/context";
import { listBookingRequests } from "@/server/bookings/service";
import { BookingDecision } from "../quotes/quote-controls";

export const metadata: Metadata = { title: "Booking requests" };

export default async function BookingsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const ctx = await requireStaff("org.read");
  const { status = "pending" } = await searchParams;
  const requests = await listBookingRequests(status);
  const canWrite = ctx.permissions.has("quotes.write");
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Booking requests</h1>
      <nav className="flex gap-3 text-sm">
        {["pending", "confirmed", "declined", "cancelled"].map((s) => (
          <Link
            key={s}
            href={`/admin/bookings?status=${s}` as Route}
            className={status === s ? "font-semibold" : "underline"}
          >
            {s}
          </Link>
        ))}
      </nav>
      <p className="text-sm text-muted-foreground">
        Confirming re-checks availability. An expired hold is re-reserved only if the items are
        still free; a price needing review must be approved on the quote first.
      </p>
      <ul className="grid gap-3">
        {requests.map((r) => {
          const hold = r.reservations;
          return (
            <li key={r.id} className="grid gap-2 rounded-lg border p-3 text-sm">
              <p className="font-medium">
                <Link className="underline" href={`/admin/quotes/${r.quote_id}` as Route}>
                  {r.quotes.quote_number}
                </Link>{" "}
                · {r.customers ? displayName(r.customers) : "—"} ·{" "}
                {r.quotes.total_cents == null
                  ? "—"
                  : formatCents(r.quotes.total_cents, r.quotes.currency ?? "USD")}
                {r.quotes.manual_review_required && !r.quotes.review_approved_at
                  ? " · price needs review"
                  : ""}
              </p>
              <p className="text-muted-foreground">
                {r.events?.starts_at ? new Date(r.events.starts_at).toLocaleString() : ""} ·{" "}
                {r.source} ·{" "}
                {r.status === "pending"
                  ? r.holdActive && hold?.hold_expires_at
                    ? `held until ${new Date(hold.hold_expires_at).toLocaleTimeString()}`
                    : "hold expired"
                  : r.status}
              </p>
              {r.customer_message ? <p className="italic">“{r.customer_message}”</p> : null}
              {r.status === "pending" && canWrite ? (
                <BookingDecision id={r.id} quoteId={r.quote_id} />
              ) : null}
            </li>
          );
        })}
        {requests.length === 0 ? (
          <li className="text-sm text-muted-foreground">Nothing here.</li>
        ) : null}
      </ul>
    </div>
  );
}
