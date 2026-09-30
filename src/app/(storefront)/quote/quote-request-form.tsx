"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { ContactFields, EventFields, MessageField } from "@/components/quote-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { QuotePrefill } from "@/domain/storefront/quote-prefill";
import { submitQuoteAction } from "./actions";
import { useFollowRedirect } from "./follow-redirect";
import { ItemPicker } from "./item-picker";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section
      aria-labelledby={`step-${String(n)}`}
      className="grid gap-4 rounded-3xl border bg-card p-5 sm:p-6"
    >
      <h2 id={`step-${String(n)}`} className="flex items-center gap-3 text-lg font-bold">
        <span
          aria-hidden="true"
          className="grid size-8 place-items-center rounded-full bg-primary text-sm text-primary-foreground"
        >
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function QuoteRequestForm({
  options,
  timeZone,
  prefill,
  minDate,
}: {
  options: { variantId: string; label: string }[];
  timeZone: string;
  prefill: QuotePrefill;
  minDate: string;
}) {
  const [state, action, pending] = useActionState(submitQuoteAction, idleState);
  useFollowRedirect(state);
  const busy = pending || Boolean(state.redirectTo);
  return (
    <form action={action} className="grid gap-5" aria-busy={busy}>
      <Step n={1} title="What would you like to rent?">
        <ItemPicker options={options} initial={prefill.items} />
      </Step>
      <Step n={2} title="When and where is your event?">
        <EventFields
          timeZone={timeZone}
          defaults={prefill.event}
          minDate={minDate}
          {...(prefill.delivery ? { delivery: prefill.delivery } : {})}
        />
      </Step>
      <Step n={3} title="How can we reach you?">
        <p className="-mt-2 text-sm text-muted-foreground">An email or phone number is required.</p>
        <ContactFields />
        <FormField id="discountCode" label="Promo code (optional)">
          <Input id="discountCode" name="discountCode" maxLength={40} autoComplete="off" />
        </FormField>
        <MessageField />
      </Step>
      <FormMessage state={state} />
      <Button
        type="submit"
        size="lg"
        disabled={busy}
        className="h-12 w-full rounded-full text-base font-bold"
      >
        {busy ? "Checking availability & pricing…" : "Get my quote"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Getting a quote does not reserve anything. You can request a booking on the next page; that
        holds the items for a few minutes while our team confirms.
      </p>
    </form>
  );
}
