import type { Metadata } from "next";
import { displayName } from "@/domain/customers/contact";
import { formatCents } from "@/domain/money";
import { requireStaff } from "@/server/auth/context";
import { getQuote } from "@/server/quotes/service";

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

export const metadata: Metadata = { title: "Quote (print)" };

/** Printer-friendly quote: only the engine snapshot, nothing recomputed. */
export default async function QuotePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaff("org.read");
  const q = await getQuote((await params).id);
  const org = ctx.memberships.find((m) => m.organizationId === ctx.organizationId);
  const money = (c: number | null) => (c === null ? "—" : formatCents(c, q.currency ?? "USD"));
  return (
    <article className="mx-auto grid max-w-2xl gap-4 bg-white p-8 text-black print:p-0">
      <header>
        <p className="text-lg font-semibold">{org?.organizationName}</p>
        <h1 className="text-2xl font-bold">Quote {q.quote_number}</h1>
        {q.customer ? <p>{displayName(q.customer)}</p> : null}
        {q.event?.starts_at ? (
          <p>
            {new Date(q.event.starts_at).toLocaleString()} –{" "}
            {q.event.ends_at ? new Date(q.event.ends_at).toLocaleString() : ""}
          </p>
        ) : null}
        {q.event?.address_line1 ? (
          <p>
            {q.event.address_line1}, {q.event.city}, {q.event.state} {q.event.postal_code}
          </p>
        ) : null}
      </header>
      <table className="w-full text-sm">
        <tbody>
          {keyed(q.pricing?.lines).map((l) => (
            <tr key={l.key} className="border-b">
              <td className="py-1">{l.label}</td>
              <td className="py-1 text-right">{money(l.amountCents)}</td>
            </tr>
          ))}
          {keyed(q.pricing?.taxLines).map((t) => (
            <tr key={t.key}>
              <td className="py-1">{t.name}</td>
              <td className="py-1 text-right">{money(t.amountCents)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td className="py-2">Total</td>
            <td className="py-2 text-right">{money(q.total_cents)}</td>
          </tr>
        </tbody>
      </table>
      {q.manual_review_required && !q.review_approved_at ? (
        <p className="text-sm">Estimate: the final price will be confirmed by our team.</p>
      ) : null}
      {q.customer_notes ? <p className="text-sm">{q.customer_notes}</p> : null}
      {q.expires_at ? (
        <p className="text-xs">Valid until {new Date(q.expires_at).toLocaleDateString()}.</p>
      ) : null}
    </article>
  );
}
