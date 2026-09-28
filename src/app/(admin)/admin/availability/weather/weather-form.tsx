"use client";

import { useActionState, useState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  HAZARD_DEFAULT_UNIT,
  HAZARD_LABELS,
  THRESHOLD_UNITS,
  WEATHER_HAZARDS,
  type WeatherHazard,
} from "@/domain/weather/hazards";
import { proposeWeatherAction } from "../actions";
import { PeriodFields } from "../period-fields";

export function WeatherForm({
  categories,
  products,
}: {
  categories: { id: string; name: string }[];
  products: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(proposeWeatherAction, idleState);
  const [hazard, setHazard] = useState<WeatherHazard>("wind");
  const [scope, setScope] = useState<"all_sensitive" | "selected">("all_sensitive");
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="w-hazard" label="Hazard">
          <NativeSelect
            id="w-hazard"
            name="hazard"
            value={hazard}
            onChange={(e) => {
              setHazard(e.target.value as WeatherHazard);
            }}
          >
            {WEATHER_HAZARDS.map((h) => (
              <option key={h} value={h}>
                {HAZARD_LABELS[h]}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField id="w-scope" label="Applies to">
          <NativeSelect
            id="w-scope"
            name="scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value === "selected" ? "selected" : "all_sensitive");
            }}
          >
            <option value="all_sensitive">Every item sensitive to this hazard</option>
            <option value="selected">Only the items I choose</option>
          </NativeSelect>
        </FormField>
      </div>
      <PeriodFields prefix="weather" defaultStart="08:00" defaultEnd="20:00" />
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem_8rem]">
        <FormField id="w-reason" label="Reason">
          <Input
            id="w-reason"
            name="reason"
            required
            maxLength={500}
            placeholder="e.g. NWS wind advisory, gusts to 25 mph"
          />
        </FormField>
        <FormField id="w-value" label="Observed / forecast" hint="Optional">
          <Input id="w-value" name="observedValue" type="number" step="0.5" min="0" />
        </FormField>
        <FormField id="w-unit" label="Unit">
          <NativeSelect
            id="w-unit"
            name="observedUnit"
            defaultValue={HAZARD_DEFAULT_UNIT[hazard] ?? "mph"}
            key={hazard}
          >
            {THRESHOLD_UNITS.map((u) => (
              <option key={u} value={u}>
                {u.replaceAll("_", " ")}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      {scope === "selected" ? (
        <div className="grid gap-2 rounded-md border p-3">
          <span className="text-sm font-medium">Categories</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {categories.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="categoryIds" value={c.id} className="size-4" />
                {c.name}
              </label>
            ))}
          </div>
          <span className="text-sm font-medium">Products</span>
          <div className="flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
            {products.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="productIds" value={p.id} className="size-4" />
                {p.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Propose block"}
        </Button>
      </div>
    </form>
  );
}
