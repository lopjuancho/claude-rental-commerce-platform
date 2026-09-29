"use client";

import { useActionState } from "react";
import { CheckboxField, FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { ContactFields, EventFields, ItemFields } from "@/components/quote-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { createQuoteAction } from "../actions";

export function NewQuoteForm({
  options,
  customers,
  defaultCustomer,
  timeZone,
}: {
  options: { variantId: string; label: string }[];
  customers: { id: string; label: string }[];
  defaultCustomer: string | undefined;
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(createQuoteAction, idleState);
  return (
    <form action={action} className="grid gap-6">
      <FormField
        id="customerId"
        label="Customer"
        hint="Or leave empty and enter a new customer below."
      >
        <NativeSelect id="customerId" name="customerId" defaultValue={defaultCustomer ?? ""}>
          <option value="">New customer…</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">New customer details</summary>
        <div className="mt-3">
          <ContactFields />
        </div>
      </details>
      <ItemFields options={options} />
      <EventFields timeZone={timeZone} />
      <FormField id="codes" label="Discount codes">
        <Input id="codes" name="codes" />
      </FormField>
      <fieldset className="grid gap-3 rounded-lg border p-3">
        <legend className="text-sm font-semibold">Manual adjustment (optional, audited)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id="adjustment" label="Amount ($)">
            <Input id="adjustment" name="adjustment" inputMode="decimal" />
          </FormField>
          <FormField id="adjustmentLabel" label="Label">
            <Input id="adjustmentLabel" name="adjustmentLabel" />
          </FormField>
          <FormField id="adjustmentReason" label="Reason (required)">
            <Input id="adjustmentReason" name="adjustmentReason" maxLength={500} />
          </FormField>
        </div>
        <CheckboxField name="adjustmentCredit" label="Adjustment is a credit" />
      </fieldset>
      <FormField id="customerNotes" label="Notes for the customer">
        <Textarea id="customerNotes" name="customerNotes" rows={2} />
      </FormField>
      <FormField id="internalNotes" label="Internal notes">
        <Textarea id="internalNotes" name="internalNotes" rows={2} />
      </FormField>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        {pending ? "Pricing…" : "Create draft quote"}
      </Button>
    </form>
  );
}
