"use client";

import { useActionState } from "react";
import { CheckboxField, FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { bookAction, type CheckState, checkAction } from "./actions";
import { PeriodFields } from "./period-fields";

interface VariantOption {
  variantId: string;
  label: string;
}

function VariantPicker({ id, options }: { id: string; options: VariantOption[] }) {
  return (
    <FormField id={id} label="Item">
      <NativeSelect id={id} name="variantId" required>
        {options.map((o) => (
          <option key={o.variantId} value={o.variantId}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
}

export function CheckForm({ options }: { options: VariantOption[] }) {
  const [state, action, pending] = useActionState<CheckState, FormData>(checkAction, {
    status: "idle",
  });
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <VariantPicker id="check-variant" options={options} />
        <FormField id="check-qty" label="Quantity">
          <Input id="check-qty" name="quantity" type="number" min="1" defaultValue={1} />
        </FormField>
      </div>
      <PeriodFields prefix="check" />
      <CheckboxField name="overrideLeadTime" label="Ignore the booking lead time (staff)" />
      <div>
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Checking…" : "Check availability"}
        </Button>
      </div>
      {state.result ? (
        <div
          className={
            state.result.available
              ? "rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm dark:bg-emerald-950"
              : "rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          }
        >
          <p className="font-medium">
            {state.result.available ? "Available" : "Not available"} ·{" "}
            {state.result.availableQuantity} of {state.result.capacity} free
          </p>
          {state.result.reasons.map((r) => (
            <p key={r} className="text-muted-foreground">
              {r}
            </p>
          ))}
        </div>
      ) : (
        <FormMessage state={state} />
      )}
    </form>
  );
}

export function BookForm({ options }: { options: VariantOption[] }) {
  const [state, action, pending] = useActionState(bookAction, idleState);
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_10rem]">
        <VariantPicker id="book-variant" options={options} />
        <FormField id="book-qty" label="Quantity">
          <Input id="book-qty" name="quantity" type="number" min="1" defaultValue={1} />
        </FormField>
        <FormField id="book-status" label="Type">
          <NativeSelect id="book-status" name="status" defaultValue="confirmed">
            <option value="confirmed">Confirmed booking</option>
            <option value="held">Temporary hold</option>
          </NativeSelect>
        </FormField>
      </div>
      <PeriodFields prefix="book" />
      <FormField id="book-notes" label="Notes">
        <Input id="book-notes" name="notes" maxLength={2000} />
      </FormField>
      <CheckboxField name="overrideLeadTime" label="Same-day / inside lead time (staff override)" />
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Reserving…" : "Reserve"}
        </Button>
      </div>
    </form>
  );
}
