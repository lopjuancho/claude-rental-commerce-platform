import type { Metadata, Route } from "next";
import Link from "next/link";
import { displayName } from "@/domain/customers/contact";
import { requireStaff } from "@/server/auth/context";
import { listCustomers } from "@/server/customers/service";
import { NewCustomerForm } from "./customer-forms";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const ctx = await requireStaff("customers.read");
  const { q } = await searchParams;
  const customers = await listCustomers(q);
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <form className="flex gap-2">
          <label htmlFor="q" className="sr-only">
            Search
          </label>
          <input
            id="q"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Name, email or phone"
            className="h-9 rounded-md border px-3 text-sm"
          />
        </form>
      </div>
      <ul className="divide-y rounded-lg border">
        {customers.map((c) => (
          <li key={c.id} className="flex flex-wrap justify-between gap-2 p-3 text-sm">
            <Link className="font-medium underline" href={`/admin/customers/${c.id}` as Route}>
              {displayName(c)}
            </Link>
            <span className="text-muted-foreground">
              {[c.email, c.phone_e164].filter(Boolean).join(" · ")} · {c.source}
            </span>
          </li>
        ))}
        {customers.length === 0 ? (
          <li className="p-3 text-sm text-muted-foreground">No customers.</li>
        ) : null}
      </ul>
      {ctx.permissions.has("customers.write") ? (
        <section className="grid gap-2">
          <h2 className="font-semibold">New customer</h2>
          <NewCustomerForm />
        </section>
      ) : null}
    </div>
  );
}
