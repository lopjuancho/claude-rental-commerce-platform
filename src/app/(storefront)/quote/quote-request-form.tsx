"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { ContactFields, EventFields, ItemFields, MessageField } from "@/components/quote-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitQuoteAction } from "./actions";

export function QuoteRequestForm({
  options,
  timeZone,
}: {
  options: { variantId: string; label: string }[];
  timeZone: string;
}) {
  const [state, action, pending] = useActionState(submitQuoteAction, idleState);
  return (
    <form action={action} className="grid gap-6">
      <ItemFields options={options} rows={4} />
      <EventFields timeZone={timeZone} />
      <ContactFields />
      <FormField id="discountCode" label="Promo code (optional)">
        <Input id="discountCode" name="discountCode" maxLength={40} />
      </FormField>
      <MessageField />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Pricing…" : "Get my quote"}
      </Button>
      <p className="text-xs text-muted-foreground">
        Getting a quote does not reserve anything. You can request a booking on the next page; that
        holds the items for a few minutes while our team confirms.
      </p>
    </form>
  );
}
