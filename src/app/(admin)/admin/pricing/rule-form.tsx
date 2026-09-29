"use client";

import { useActionState, useState } from "react";
import { CheckboxField, FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { saveRuleAction } from "./actions";

export const RULE_TYPE_LABELS: Record<string, string> = {
  extra_hour: "Extra time beyond the included duration",
  overnight: "Overnight (single rental across midnight)",
  additional_day: "Additional day (multi-day rentals)",
  attendant_fee: "Attendant / operator labor",
  fee: "Fee",
  discount_percent: "Discount (percentage)",
  discount_fixed: "Discount (fixed amount)",
  minimum_charge: "Minimum rental charge",
};

export interface RuleValues {
  id?: string;
  name?: string;
  type?: string;
  scope?: string; // "organization" | "category:<id>" | "product:<id>"
  params?: Record<string, unknown>;
  priority?: number;
  discountCode?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  active?: boolean;
}

const dollars = (cents: unknown) => (typeof cents === "number" ? (cents / 100).toFixed(2) : "");
const percent = (bps: unknown) => (typeof bps === "number" ? String(bps / 100) : "");

export function RuleForm({
  values = {},
  scopes,
}: {
  values?: RuleValues;
  scopes: { value: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(saveRuleAction, idleState);
  const [type, setType] = useState(values.type ?? "extra_hour");
  const p = values.params ?? {};
  const [mode, setMode] = useState("percent_of_base_bps" in p ? "percent" : "amount");
  const k = values.id ?? "new";
  const showAmount =
    ["extra_hour", "attendant_fee", "fee", "discount_fixed", "minimum_charge"].includes(type) ||
    (["overnight", "additional_day"].includes(type) && mode === "amount");
  const showPercent =
    type === "discount_percent" ||
    (["overnight", "additional_day"].includes(type) && mode === "percent");

  return (
    <form action={action} className="grid gap-3">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id={`${k}-name`} label="Name">
          <Input id={`${k}-name`} name="name" defaultValue={values.name} required maxLength={120} />
        </FormField>
        <FormField id={`${k}-type`} label="Type">
          <NativeSelect
            id={`${k}-type`}
            name="type"
            value={type}
            onChange={(e) => {
              setType(e.target.value);
            }}
          >
            {Object.entries(RULE_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField
          id={`${k}-scope`}
          label="Applies to"
          hint="Most specific wins: product → category → whole business."
        >
          <NativeSelect
            id={`${k}-scope`}
            name="scope"
            defaultValue={values.scope ?? "organization"}
          >
            {scopes.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        {["overnight", "additional_day"].includes(type) ? (
          <FormField id={`${k}-mode`} label="Charge as">
            <NativeSelect
              id={`${k}-mode`}
              name="mode"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
              }}
            >
              <option value="percent">Percentage of the base price</option>
              <option value="amount">Fixed amount</option>
            </NativeSelect>
          </FormField>
        ) : null}
        {showAmount ? (
          <FormField
            id={`${k}-amount`}
            label={
              type === "extra_hour"
                ? "Amount per increment ($)"
                : type === "attendant_fee"
                  ? "Amount per attendant ($)"
                  : "Amount ($)"
            }
          >
            <Input
              id={`${k}-amount`}
              name="amount"
              inputMode="decimal"
              defaultValue={dollars(p.amount_cents)}
              required
            />
          </FormField>
        ) : null}
        {showPercent ? (
          <FormField id={`${k}-percent`} label="Percent (%)">
            <Input
              id={`${k}-percent`}
              name="percent"
              inputMode="decimal"
              defaultValue={percent(p.percent_of_base_bps ?? p.percent_bps)}
              required
            />
          </FormField>
        ) : null}
        {type === "extra_hour" ? (
          <FormField
            id={`${k}-inc`}
            label="Increment (minutes)"
            hint="60 = charge per started hour"
          >
            <Input
              id={`${k}-inc`}
              name="incrementMinutes"
              type="number"
              min="1"
              max="1440"
              defaultValue={typeof p.increment_minutes === "number" ? p.increment_minutes : 60}
            />
          </FormField>
        ) : null}
        {type === "attendant_fee" || type === "fee" ? (
          <FormField id={`${k}-per`} label="Charged per">
            <NativeSelect
              id={`${k}-per`}
              name="per"
              defaultValue={typeof p.per === "string" ? p.per : type === "fee" ? "order" : "event"}
            >
              {type === "fee" ? (
                <>
                  <option value="order">Order</option>
                  <option value="unit">Unit rented</option>
                </>
              ) : (
                <>
                  <option value="event">Event</option>
                  <option value="hour">Hour</option>
                </>
              )}
            </NativeSelect>
          </FormField>
        ) : null}
        {type === "fee" ? (
          <FormField id={`${k}-label`} label="Label shown on quotes">
            <Input
              id={`${k}-label`}
              name="label"
              defaultValue={typeof p.label === "string" ? p.label : ""}
              maxLength={120}
            />
          </FormField>
        ) : null}
        {type === "discount_percent" ? (
          <FormField id={`${k}-minq`} label="Minimum quantity (optional)">
            <Input
              id={`${k}-minq`}
              name="minQuantity"
              type="number"
              min="1"
              defaultValue={typeof p.min_quantity === "number" ? p.min_quantity : ""}
            />
          </FormField>
        ) : null}
        {type.startsWith("discount") ? (
          <FormField
            id={`${k}-code`}
            label="Discount code (optional)"
            hint="Blank = applied automatically"
          >
            <Input
              id={`${k}-code`}
              name="discountCode"
              defaultValue={values.discountCode ?? ""}
              maxLength={40}
            />
          </FormField>
        ) : null}
        <FormField id={`${k}-from`} label="Valid from (event date)">
          <Input
            id={`${k}-from`}
            name="validFrom"
            type="date"
            defaultValue={values.validFrom ?? ""}
          />
        </FormField>
        <FormField id={`${k}-to`} label="Valid to (event date)">
          <Input id={`${k}-to`} name="validTo" type="date" defaultValue={values.validTo ?? ""} />
        </FormField>
        <FormField id={`${k}-prio`} label="Priority" hint="Breaks ties at the same level">
          <Input
            id={`${k}-prio`}
            name="priority"
            type="number"
            defaultValue={values.priority ?? 0}
          />
        </FormField>
      </div>
      <CheckboxField name="active" label="Active" defaultChecked={values.active ?? true} />
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : values.id ? "Save rule" : "Add rule"}
        </Button>
      </div>
    </form>
  );
}
