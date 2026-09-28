import type * as React from "react";
import { Label } from "@/components/ui/label";

export function FormField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CheckboxField({
  name,
  label,
  defaultChecked,
}: {
  name: string;
  label: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="size-4 rounded border-input accent-[var(--brand)]"
      />
      {label}
    </label>
  );
}

/** Yes / No / Inherit for override-chain fields (null = inherit, ADR 0003). */
export function TriStateField({
  id,
  name,
  label,
  value,
  inheritLabel = "Inherit",
}: {
  id: string;
  name: string;
  label: string;
  value: boolean | null | undefined;
  inheritLabel?: string;
}) {
  const current = value === true ? "yes" : value === false ? "no" : "";
  return (
    <FormField id={id} label={label}>
      <select
        id={id}
        name={name}
        defaultValue={current}
        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      >
        <option value="">{inheritLabel}</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </FormField>
  );
}
