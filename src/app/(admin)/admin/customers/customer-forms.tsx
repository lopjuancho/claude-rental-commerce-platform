"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { ContactFields } from "@/components/quote-fields";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { createCustomerAction, updateCustomerAction } from "../quotes/actions";

export function NewCustomerForm() {
  const [state, action, pending] = useActionState(createCustomerAction, idleState);
  return (
    <form action={action} className="grid gap-3 rounded-lg border p-4">
      <ContactFields />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        Add customer
      </Button>
      <p className="text-xs text-muted-foreground">
        If a customer with the same email or phone exists, you are taken to that customer instead.
      </p>
    </form>
  );
}

export function EditCustomerForm({
  customer,
}: {
  customer: {
    id: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone_e164: string | null;
    notes: string | null;
  };
}) {
  const [state, action, pending] = useActionState(updateCustomerAction, idleState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={customer.id} />
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ["firstName", "First name", customer.first_name],
            ["lastName", "Last name", customer.last_name],
            ["email", "Email", customer.email],
            ["phone", "Phone", customer.phone_e164],
          ] as const
        ).map(([name, label, value]) => (
          <FormField key={name} id={name} label={label}>
            <input
              id={name}
              name={name}
              defaultValue={value ?? ""}
              className="h-10 rounded-md border px-3 text-sm"
            />
          </FormField>
        ))}
      </div>
      <FormField id="notes" label="Internal notes">
        <Textarea id="notes" name="notes" defaultValue={customer.notes ?? ""} rows={3} />
      </FormField>
      <FormMessage state={state} />
      <Button type="submit" disabled={pending} className="justify-self-start">
        Save
      </Button>
    </form>
  );
}
