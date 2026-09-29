"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { TAX_COMPONENTS } from "@/domain/pricing/types";
import { saveTaxAction } from "../actions";

const COMPONENT_LABELS: Record<string, string> = {
  rental: "Rentals",
  add_on: "Add-ons",
  delivery: "Delivery",
  labor: "Labor / attendants",
  fee: "Fees",
  discount: "Discounts reduce the taxable amount",
  adjustment: "Manual adjustments",
};

export interface TaxValues {
  id?: string;
  name?: string;
  state?: string;
  postalCodes?: string[];
  reviewPostalCodes?: string[];
  status?: string;
  priority?: number;
  rates?: { name: string; rate_bps: number }[];
  taxability?: Record<string, boolean>;
}

export function TaxForm({ values = {} }: { values?: TaxValues }) {
  const [state, action, pending] = useActionState(saveTaxAction, idleState);
  const k = values.id ?? "new";
  const rates = values.rates ?? [];
  return (
    <form action={action} className="grid gap-3">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[2fr_5rem_1fr_6rem]">
        <FormField id={`${k}-name`} label="Name">
          <Input id={`${k}-name`} name="name" defaultValue={values.name} required />
        </FormField>
        <FormField id={`${k}-state`} label="State">
          <Input
            id={`${k}-state`}
            name="state"
            maxLength={2}
            defaultValue={values.state ?? ""}
            required
          />
        </FormField>
        <FormField id={`${k}-status`} label="Status" hint="Test rates always require review">
          <NativeSelect id={`${k}-status`} name="status" defaultValue={values.status ?? "test"}>
            <option value="test">Test (not for real quotes)</option>
            <option value="active">Active (verified production rules)</option>
          </NativeSelect>
        </FormField>
        <FormField id={`${k}-prio`} label="Priority">
          <Input
            id={`${k}-prio`}
            name="priority"
            type="number"
            defaultValue={values.priority ?? 0}
          />
        </FormField>
      </div>
      <FormField
        id={`${k}-zips`}
        label="ZIP codes"
        hint="Blank = the whole state. ZIP-specific jurisdictions win over statewide ones."
      >
        <Textarea
          id={`${k}-zips`}
          name="postalCodes"
          rows={2}
          defaultValue={(values.postalCodes ?? []).join(", ")}
        />
      </FormField>
      <FormField
        id={`${k}-review`}
        label="ZIP codes needing manual review"
        hint="ZIPs that straddle a boundary"
      >
        <Input
          id={`${k}-review`}
          name="reviewPostalCodes"
          defaultValue={(values.reviewPostalCodes ?? []).join(", ")}
        />
      </FormField>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Rates (added together)</span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="grid grid-cols-[1fr_7rem] gap-2">
            <label className="sr-only" htmlFor={`${k}-rn${i}`}>
              Rate name
            </label>
            <Input
              id={`${k}-rn${i}`}
              name={`rateName${i}`}
              placeholder="e.g. State"
              defaultValue={rates[i]?.name ?? ""}
            />
            <label className="sr-only" htmlFor={`${k}-rp${i}`}>
              Rate percent
            </label>
            <Input
              id={`${k}-rp${i}`}
              name={`ratePercent${i}`}
              inputMode="decimal"
              placeholder="%"
              defaultValue={rates[i] ? String(rates[i].rate_bps / 100) : ""}
            />
          </div>
        ))}
      </div>
      <div className="grid gap-2">
        <span className="text-sm font-medium">Taxable?</span>
        <div className="grid gap-2 sm:grid-cols-2">
          {TAX_COMPONENTS.map((c) => {
            const v = values.taxability?.[c];
            return (
              <label key={c} className="grid grid-cols-[1fr_8rem] items-center gap-2 text-sm">
                {COMPONENT_LABELS[c]}
                <NativeSelect
                  name={`taxable.${c}`}
                  defaultValue={v === undefined ? "" : v ? "yes" : "no"}
                >
                  <option value="">Not set (review)</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </NativeSelect>
              </label>
            );
          })}
        </div>
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : values.id ? "Save" : "Add jurisdiction"}
        </Button>
      </div>
    </form>
  );
}
