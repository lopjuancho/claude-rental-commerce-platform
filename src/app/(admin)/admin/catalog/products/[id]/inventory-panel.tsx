"use client";

import { useActionState, useState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { addUnitAction, setInventoryAction, setUnitStatusAction } from "../actions";

interface Unit {
  id: string;
  label: string;
  serial_number: string | null;
  status: string;
}

export function InventoryPanel(props: {
  productId: string;
  variantId: string;
  trackingMode: "serialized" | "pooled";
  pooledQuantity: number | null;
  units: Unit[];
  canWrite: boolean;
}) {
  const [mode, setMode] = useState(props.trackingMode);
  const [modeState, modeAction, modePending] = useActionState(setInventoryAction, idleState);
  const [unitState, unitAction, unitPending] = useActionState(addUnitAction, idleState);
  const active = props.units.filter((u) => u.status === "active");

  return (
    <div className="grid gap-5">
      <form action={modeAction} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <input type="hidden" name="productId" value={props.productId} />
        <input type="hidden" name="variantId" value={props.variantId} />
        <FormField
          id="trackingMode"
          label="Inventory type"
          hint="Individual units for inflatables; a quantity for chairs and tables."
        >
          <NativeSelect
            id="trackingMode"
            name="trackingMode"
            value={mode}
            disabled={!props.canWrite}
            onChange={(e) => {
              setMode(e.target.value === "pooled" ? "pooled" : "serialized");
            }}
          >
            <option value="serialized">Individual units</option>
            <option value="pooled">Quantity (identical items)</option>
          </NativeSelect>
        </FormField>
        {mode === "pooled" ? (
          <FormField id="pooledQuantity" label="Quantity owned">
            <Input
              id="pooledQuantity"
              name="pooledQuantity"
              type="number"
              min="0"
              defaultValue={props.pooledQuantity ?? 0}
              disabled={!props.canWrite}
            />
          </FormField>
        ) : (
          <p className="text-sm text-muted-foreground">
            {active.length} active unit{active.length === 1 ? "" : "s"}
          </p>
        )}
        {props.canWrite ? (
          <Button type="submit" variant="outline" disabled={modePending}>
            Save
          </Button>
        ) : null}
        <div className="sm:col-span-3">
          <FormMessage state={modeState} />
        </div>
      </form>

      {props.trackingMode === "serialized" ? (
        <div className="grid gap-3">
          <ul className="divide-y rounded-md border">
            {props.units.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No units yet.</li>
            ) : null}
            {props.units.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1">
                  {u.label}
                  {u.serial_number ? (
                    <span className="text-muted-foreground"> · {u.serial_number}</span>
                  ) : null}
                </span>
                <span className="text-xs capitalize text-muted-foreground">{u.status}</span>
                {props.canWrite ? (
                  <form action={setUnitStatusAction}>
                    <input type="hidden" name="productId" value={props.productId} />
                    <input type="hidden" name="unitId" value={u.id} />
                    <input
                      type="hidden"
                      name="status"
                      value={u.status === "active" ? "retired" : "active"}
                    />
                    <Button size="sm" variant="ghost" type="submit">
                      {u.status === "active" ? "Retire" : "Reactivate"}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {props.canWrite ? (
            <form
              action={unitAction}
              className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <input type="hidden" name="productId" value={props.productId} />
              <input type="hidden" name="variantId" value={props.variantId} />
              <FormField id="unitLabel" label="Unit label">
                <Input
                  id="unitLabel"
                  name="label"
                  defaultValue={`Unit ${props.units.length + 1}`}
                  required
                />
              </FormField>
              <FormField id="serialNumber" label="Serial number (optional)">
                <Input id="serialNumber" name="serialNumber" />
              </FormField>
              <Button type="submit" disabled={unitPending}>
                Add unit
              </Button>
              <div className="sm:col-span-3">
                <FormMessage state={unitState} />
              </div>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
