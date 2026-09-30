"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { type ItemPrefill, QUOTE_ITEM_ROWS } from "@/domain/storefront/quote-prefill";

interface Row {
  key: number;
  variantId: string;
  quantity: number;
}

const clamp = (n: number) => Math.min(1000, Math.max(1, Number.isFinite(n) ? Math.trunc(n) : 1));

/**
 * Item rows for the storefront quote form: product + quantity only. Posts `variant{i}` /
 * `quantity{i}` like the server's form reader expects; prices are never entered or shown here.
 */
export function ItemPicker({
  options,
  initial,
}: {
  options: { variantId: string; label: string }[];
  initial: ItemPrefill[];
}) {
  const baseId = useId();
  const [rows, setRows] = useState<Row[]>(() =>
    (initial.length ? initial : [{ variantId: "", quantity: 1 }]).map((r, i) => ({ key: i, ...r })),
  );
  const [nextKey, setNextKey] = useState(rows.length);
  const update = (key: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };
  const add = () => {
    setRows((rs) => [...rs, { key: nextKey, variantId: "", quantity: 1 }]);
    setNextKey((k) => k + 1);
  };
  const remove = (key: number) => {
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));
  };

  return (
    <div className="grid gap-3">
      <ul className="grid gap-3">
        {rows.map((row, i) => {
          const id = `${baseId}-${String(row.key)}`;
          return (
            <li
              key={row.key}
              className="grid gap-2 rounded-2xl border bg-card p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"
            >
              <label className="sr-only" htmlFor={`${id}-v`}>
                Item {i + 1}
              </label>
              <NativeSelect
                id={`${id}-v`}
                name={`variant${String(i)}`}
                value={row.variantId}
                required={i === 0}
                onChange={(e) => {
                  update(row.key, { variantId: e.target.value });
                }}
                className="h-11"
              >
                <option value="">Choose a rental…</option>
                {options.map((o) => (
                  <option key={o.variantId} value={o.variantId}>
                    {o.label}
                  </option>
                ))}
              </NativeSelect>
              <div
                className="flex items-center gap-1"
                role="group"
                aria-label={`Quantity for item ${String(i + 1)}`}
              >
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11"
                  aria-label="Decrease quantity"
                  disabled={row.quantity <= 1}
                  onClick={() => {
                    update(row.key, { quantity: clamp(row.quantity - 1) });
                  }}
                >
                  −
                </Button>
                <label className="sr-only" htmlFor={`${id}-q`}>
                  Quantity
                </label>
                <input
                  id={`${id}-q`}
                  name={`quantity${String(i)}`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={1000}
                  value={row.quantity}
                  onChange={(e) => {
                    update(row.key, { quantity: clamp(e.target.valueAsNumber) });
                  }}
                  className="h-11 w-16 rounded-md border border-input bg-background text-center tabular-nums"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11"
                  aria-label="Increase quantity"
                  disabled={row.quantity >= 1000}
                  onClick={() => {
                    update(row.key, { quantity: clamp(row.quantity + 1) });
                  }}
                >
                  +
                </Button>
              </div>
              {rows.length > 1 ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 justify-self-start"
                  onClick={() => {
                    remove(row.key);
                  }}
                >
                  Remove<span className="sr-only"> item {i + 1}</span>
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {rows.length < QUOTE_ITEM_ROWS ? (
        <Button type="button" variant="outline" className="h-11 justify-self-start" onClick={add}>
          + Add another rental
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          Need more than {QUOTE_ITEM_ROWS} different rentals? Add them in the notes and we&apos;ll
          include them.
        </p>
      )}
    </div>
  );
}
