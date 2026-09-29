import type { Metadata } from "next";
import { displayName } from "@/domain/customers/contact";
import { requireStaff } from "@/server/auth/context";
import { getOrganizationTimezone, listVariantOptions } from "@/server/availability/service";
import { listCustomers } from "@/server/customers/service";
import { NewQuoteForm } from "./new-quote-form";

export const metadata: Metadata = { title: "New quote" };

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  await requireStaff("quotes.write");
  const [options, customers, timeZone, { customer }] = await Promise.all([
    listVariantOptions(),
    listCustomers(),
    getOrganizationTimezone(),
    searchParams,
  ]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">New quote</h1>
      <p className="text-sm text-muted-foreground">
        The price is calculated by the pricing engine and stored as an immutable snapshot. A draft
        does not hold inventory; request a hold from the quote page.
      </p>
      <NewQuoteForm
        options={options.map((o) => ({ variantId: o.variantId, label: o.label }))}
        customers={customers.map((c) => ({ id: c.id, label: displayName(c) }))}
        defaultCustomer={customer}
        timeZone={timeZone}
      />
    </div>
  );
}
