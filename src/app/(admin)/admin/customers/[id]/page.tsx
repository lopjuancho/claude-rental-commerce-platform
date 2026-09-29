import type { Metadata, Route } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { displayName } from "@/domain/customers/contact";
import { formatCents } from "@/domain/money";
import { QUOTE_STATUS_LABELS } from "@/domain/quotes/state-machine";
import { requireStaff } from "@/server/auth/context";
import { getCustomer } from "@/server/customers/service";
import { archiveCustomerAction } from "../../quotes/actions";
import { EditCustomerForm } from "../customer-forms";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaff("customers.read");
  const c = await getCustomer((await params).id);
  const canWrite = ctx.permissions.has("customers.write");
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">{displayName(c)}</h1>
      {canWrite ? (
        <EditCustomerForm customer={c} />
      ) : (
        <p className="text-sm">{[c.email, c.phone_e164].filter(Boolean).join(" · ")}</p>
      )}
      <section className="grid gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Quotes</h2>
          {ctx.permissions.has("quotes.write") ? (
            <Button asChild size="sm">
              <Link href={`/admin/quotes/new?customer=${c.id}` as Route}>New quote</Link>
            </Button>
          ) : null}
        </div>
        <ul className="divide-y rounded-lg border text-sm">
          {c.quotes.map((q) => (
            <li key={q.id} className="flex justify-between p-3">
              <Link className="underline" href={`/admin/quotes/${q.id}` as Route}>
                {q.quote_number}
              </Link>
              <span>
                {QUOTE_STATUS_LABELS[q.status]} ·{" "}
                {q.total_cents === null
                  ? "unpriced"
                  : formatCents(q.total_cents, q.currency ?? "USD")}
              </span>
            </li>
          ))}
          {c.quotes.length === 0 ? (
            <li className="p-3 text-muted-foreground">No quotes yet.</li>
          ) : null}
        </ul>
      </section>
      {canWrite ? (
        <form action={archiveCustomerAction}>
          <input type="hidden" name="id" value={c.id} />
          <Button type="submit" variant="ghost" size="sm">
            Archive customer
          </Button>
        </form>
      ) : null}
    </div>
  );
}
