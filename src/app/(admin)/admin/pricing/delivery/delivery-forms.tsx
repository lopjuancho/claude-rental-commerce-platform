"use client";

import { useActionState } from "react";
import { CheckboxField, FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { saveAreaAction, saveDeliveryAction } from "../actions";

export interface DeliveryValues {
  depotLine1: string | null;
  depotCity: string | null;
  depotState: string | null;
  depotPostalCode: string | null;
  freeMiles: number | null;
  perMileRateCents: number | null;
  maximumMiles: number | null;
  rounding: string;
  basis: string;
}

export function DeliverySettingsForm({
  values,
  disabled,
}: {
  values: DeliveryValues;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(saveDeliveryAction, idleState);
  return (
    <form action={action} className="grid gap-3">
      <fieldset disabled={disabled} className="grid gap-3">
        <legend className="text-sm font-semibold">Depot (where deliveries start)</legend>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_4rem_6rem]">
          <FormField id="depotLine1" label="Street">
            <Input id="depotLine1" name="depotLine1" defaultValue={values.depotLine1 ?? ""} />
          </FormField>
          <FormField id="depotCity" label="City">
            <Input id="depotCity" name="depotCity" defaultValue={values.depotCity ?? ""} />
          </FormField>
          <FormField id="depotState" label="State">
            <Input
              id="depotState"
              name="depotState"
              maxLength={2}
              defaultValue={values.depotState ?? ""}
            />
          </FormField>
          <FormField id="depotPostalCode" label="ZIP">
            <Input
              id="depotPostalCode"
              name="depotPostalCode"
              defaultValue={values.depotPostalCode ?? ""}
            />
          </FormField>
        </div>
        <legend className="mt-2 text-sm font-semibold">Mileage pricing (road distance)</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField id="freeMiles" label="Free miles">
            <Input
              id="freeMiles"
              name="freeMiles"
              inputMode="decimal"
              defaultValue={values.freeMiles ?? ""}
            />
          </FormField>
          <FormField id="perMileRate" label="Rate per mile after that ($)">
            <Input
              id="perMileRate"
              name="perMileRate"
              inputMode="decimal"
              defaultValue={
                values.perMileRateCents == null ? "" : (values.perMileRateCents / 100).toFixed(2)
              }
            />
          </FormField>
          <FormField id="maximumMiles" label="Maximum distance (mi)" hint="Blank = no maximum">
            <Input
              id="maximumMiles"
              name="maximumMiles"
              inputMode="decimal"
              defaultValue={values.maximumMiles ?? ""}
            />
          </FormField>
          <FormField id="rounding" label="Billable miles">
            <NativeSelect id="rounding" name="rounding" defaultValue={values.rounding}>
              <option value="ceil_whole_mile">Round up to the next whole mile</option>
              <option value="round_whole_mile">Round to the nearest whole mile</option>
              <option value="none">Exact (to 0.01 mi)</option>
            </NativeSelect>
          </FormField>
          <FormField id="basis" label="Distance measured">
            <NativeSelect id="basis" name="basis" defaultValue={values.basis}>
              <option value="one_way">One way (depot → event)</option>
              <option value="round_trip">Round trip</option>
            </NativeSelect>
          </FormField>
        </div>
      </fieldset>
      <FormMessage state={state} />
      {!disabled ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save delivery settings"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export interface AreaValues {
  id?: string;
  name?: string;
  pricing?: string;
  flatFeeCents?: number | null;
  priority?: number;
  active?: boolean;
  postalCodes?: string[];
  cities?: string[];
}

export function ServiceAreaForm({ values = {} }: { values?: AreaValues }) {
  const [state, action, pending] = useActionState(saveAreaAction, idleState);
  const k = values.id ?? "new";
  return (
    <form action={action} className="grid gap-3">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField id={`${k}-name`} label="Name">
          <Input id={`${k}-name`} name="name" defaultValue={values.name} required />
        </FormField>
        <FormField id={`${k}-pricing`} label="Pricing in this area">
          <NativeSelect
            id={`${k}-pricing`}
            name="pricing"
            defaultValue={values.pricing ?? "mileage"}
          >
            <option value="mileage">Mileage (road distance)</option>
            <option value="flat">Flat fee</option>
            <option value="manual_review">Staff quote (manual review)</option>
          </NativeSelect>
        </FormField>
        <FormField id={`${k}-fee`} label="Flat fee ($)" hint="Only for flat-fee areas">
          <Input
            id={`${k}-fee`}
            name="flatFee"
            inputMode="decimal"
            defaultValue={values.flatFeeCents == null ? "" : (values.flatFeeCents / 100).toFixed(2)}
          />
        </FormField>
      </div>
      <FormField id={`${k}-zips`} label="ZIP codes" hint="Separated by spaces or commas">
        <Textarea
          id={`${k}-zips`}
          name="postalCodes"
          rows={2}
          defaultValue={(values.postalCodes ?? []).join(", ")}
        />
      </FormField>
      <FormField id={`${k}-cities`} label="Cities" hint='One per line, as "City, ST"'>
        <Textarea
          id={`${k}-cities`}
          name="cities"
          rows={2}
          defaultValue={(values.cities ?? []).join("\n")}
        />
      </FormField>
      <div className="flex flex-wrap items-end gap-4">
        <FormField id={`${k}-prio`} label="Priority">
          <Input
            id={`${k}-prio`}
            name="priority"
            type="number"
            defaultValue={values.priority ?? 0}
            className="w-24"
          />
        </FormField>
        <CheckboxField name="active" label="Active" defaultChecked={values.active ?? true} />
      </div>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : values.id ? "Save area" : "Add area"}
        </Button>
      </div>
    </form>
  );
}
