"use client";

import { useActionState, useState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { createBlockAction } from "../actions";
import { PeriodFields } from "../period-fields";

export interface BlockTarget {
  value: string; // "organization" | "product:<id>" | "unit:<id>" | "variant:<id>"
  label: string;
  pooled?: boolean;
}

export function BlockForm({ targets }: { targets: BlockTarget[] }) {
  const [state, action, pending] = useActionState(createBlockAction, idleState);
  const [target, setTarget] = useState("organization");
  const pooled = targets.find((t) => t.value === target)?.pooled ?? false;
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <FormField id="block-target" label="What to block">
          <NativeSelect
            id="block-target"
            name="target"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
            }}
          >
            {targets.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="block-reason" label="Reason">
          <NativeSelect id="block-reason" name="reason" defaultValue="maintenance">
            <option value="blackout">Blackout / closed</option>
            <option value="maintenance">Maintenance</option>
            <option value="repair">Repair</option>
            <option value="private_use">Private use</option>
            <option value="staff_hold">Staff hold</option>
            <option value="other">Other</option>
          </NativeSelect>
        </FormField>
      </div>
      {pooled ? (
        <FormField
          id="block-qty"
          label="How many are unavailable"
          hint="Leave blank to block all of them."
        >
          <Input id="block-qty" name="quantity" type="number" min="1" />
        </FormField>
      ) : null}
      <PeriodFields prefix="block" defaultStart="00:00" defaultEnd="23:59" />
      <FormField id="block-notes" label="Notes">
        <Input id="block-notes" name="notes" maxLength={1000} />
      </FormField>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Add block"}
        </Button>
      </div>
    </form>
  );
}
