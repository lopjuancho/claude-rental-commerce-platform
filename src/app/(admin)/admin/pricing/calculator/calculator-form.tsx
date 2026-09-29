"use client";

import { useActionState } from "react";
import { CheckboxField, FormField } from "@/components/form-field";
import { FormMessage } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { formatCents } from "@/domain/money";
import { explainReviewReason } from "@/domain/pricing/reasons";
import { type CalcState, calculateAction } from "../actions";

export function CalculatorForm({
  options,
  canSave,
}: {
  options: { variantId: string; label: string }[];
  canSave: boolean;
}) {
  const [state, action, pending] = useActionState<CalcState, FormData>(calculateAction, {
    status: "idle",
  });
  const r = state.result;
  const money = (c: number) => formatCents(c, r?.currency ?? "USD");
  return (
    <div className="grid gap-6">
      <form action={action} className="grid gap-4">
        <div className="grid gap-2">
          <span className="text-sm font-semibold">Items</span>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_5rem] items-center gap-2 sm:grid-cols-[1fr_5rem_6rem]"
            >
              <label className="sr-only" htmlFor={`v${i}`}>
                Item {i + 1}
              </label>
              <NativeSelect
                id={`v${i}`}
                name={`variant${i}`}
                defaultValue={i === 0 ? (options[0]?.variantId ?? "") : ""}
              >
                <option value="">{i === 0 ? "Choose an item" : "—"}</option>
                {options.map((o) => (
                  <option key={o.variantId} value={o.variantId}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
              <label className="sr-only" htmlFor={`q${i}`}>
                Quantity
              </label>
              <Input id={`q${i}`} name={`quantity${i}`} type="number" min="1" defaultValue={1} />
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" name={`addon${i}`} className="size-4" />
                Add-on
              </label>
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField id="date" label="Date">
            <Input id="date" name="date" type="date" required />
          </FormField>
          <FormField id="startTime" label="Start">
            <Input id="startTime" name="startTime" type="time" defaultValue="12:00" required />
          </FormField>
          <FormField id="endTime" label="End" hint="Earlier than start = overnight">
            <Input id="endTime" name="endTime" type="time" defaultValue="16:00" required />
          </FormField>
          <FormField id="endDate" label="End date (multi-day)">
            <Input id="endDate" name="endDate" type="date" />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_4rem_6rem]">
          <FormField id="line1" label="Event address" hint="Blank = customer pickup">
            <Input id="line1" name="line1" />
          </FormField>
          <FormField id="city" label="City">
            <Input id="city" name="city" />
          </FormField>
          <FormField id="state" label="State">
            <Input id="state" name="state" maxLength={2} defaultValue="TN" />
          </FormField>
          <FormField id="postalCode" label="ZIP">
            <Input id="postalCode" name="postalCode" />
          </FormField>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id="codes" label="Discount codes">
            <Input id="codes" name="codes" />
          </FormField>
          {canSave ? (
            <>
              <FormField id="adjustment" label="Manual adjustment ($)">
                <Input id="adjustment" name="adjustment" inputMode="decimal" />
              </FormField>
              <FormField id="adjustmentLabel" label="Adjustment label">
                <Input id="adjustmentLabel" name="adjustmentLabel" />
              </FormField>
            </>
          ) : null}
        </div>
        {canSave ? (
          <div className="flex flex-wrap gap-4">
            <CheckboxField name="adjustmentCredit" label="Adjustment is a credit" />
            <CheckboxField name="save" label="Save this calculation (immutable snapshot)" />
          </div>
        ) : null}
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Calculating…" : "Calculate price"}
          </Button>
        </div>
        {state.status === "error" ? <FormMessage state={state} /> : null}
      </form>

      {r ? (
        <section aria-live="polite" className="grid gap-4 rounded-xl border p-4">
          {r.manualReviewRequired ? (
            <div className="rounded-md border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
              <p className="font-semibold">
                Needs manual review. This total is provisional and must not be quoted as final.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {r.reviewReasons.map((x) => (
                  <li key={x}>{explainReviewReason(x)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              Complete price: no manual review needed.
            </p>
          )}
          <table className="w-full text-sm">
            <tbody className="divide-y">
              {r.lines.map((l, i) => (
                <tr key={`${l.kind}-${String(i)}`}>
                  <td className="py-1.5 pr-2">
                    {l.label}
                    {l.quantity > 1 && l.kind !== "discount" ? ` × ${l.quantity}` : ""}
                  </td>
                  <td className="w-24 text-xs text-muted-foreground">
                    {l.taxable === null ? "tax ?" : l.taxable ? "taxable" : "not taxable"}
                  </td>
                  <td className="w-28 text-right tabular-nums">{money(l.amountCents)}</td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-1.5">Subtotal</td>
                <td />
                <td className="text-right tabular-nums">{money(r.summary.subtotal)}</td>
              </tr>
              {r.taxLines.map((t) => (
                <tr key={t.rateId}>
                  <td className="py-1.5">
                    {t.name} ({t.rateBps / 100}% of {money(t.taxableBaseCents)})
                  </td>
                  <td />
                  <td className="text-right tabular-nums">{money(t.amountCents)}</td>
                </tr>
              ))}
              <tr className="text-base font-semibold">
                <td className="py-2">Total</td>
                <td />
                <td className="text-right tabular-nums">{money(r.summary.total)}</td>
              </tr>
            </tbody>
          </table>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Structured breakdown and applied rules
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
              {JSON.stringify(
                {
                  summary: r.summary,
                  appliedRules: r.appliedRules,
                  tax: r.tax,
                  delivery: r.delivery,
                  warnings: r.warnings,
                  engineVersion: r.engineVersion,
                },
                null,
                2,
              )}
            </pre>
          </details>
          {state.calculationId ? (
            <p className="text-xs text-muted-foreground">
              Saved as calculation {state.calculationId}. It will never change.
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
