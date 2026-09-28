"use client";

import { useActionState } from "react";
import { CheckboxField, FormField, TriStateField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { type WeatherRuleValue, WeatherRulesEditor } from "@/components/weather-rules-editor";
import { saveCategoryAction } from "./actions";

export interface CategoryFormValues {
  id?: string;
  name?: string;
  slug?: string;
  parentId?: string | null;
  sortOrder?: number;
  isPublished?: boolean;
  setupBufferMinutes?: number | null;
  teardownBufferMinutes?: number | null;
  includedDurationMinutes?: number | null;
  overnightAllowed?: boolean | null;
  weatherRules?: WeatherRuleValue[];
}

export function CategoryForm({
  values = {},
  parents,
}: {
  values?: CategoryFormValues;
  parents: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(saveCategoryAction, idleState);
  const p = values.id ?? "new";
  return (
    <form action={action} className="grid gap-4">
      {values.id ? <input type="hidden" name="id" value={values.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={`${p}-name`} label="Name">
          <Input id={`${p}-name`} name="name" defaultValue={values.name} required maxLength={120} />
        </FormField>
        <FormField id={`${p}-slug`} label="URL slug" hint="Leave blank to generate from the name.">
          <Input id={`${p}-slug`} name="slug" defaultValue={values.slug} maxLength={120} />
        </FormField>
        <FormField id={`${p}-parent`} label="Parent category">
          <NativeSelect id={`${p}-parent`} name="parentId" defaultValue={values.parentId ?? ""}>
            <option value="">None</option>
            {parents
              .filter((c) => c.id !== values.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </NativeSelect>
        </FormField>
        <FormField id={`${p}-sort`} label="Sort order">
          <Input
            id={`${p}-sort`}
            name="sortOrder"
            type="number"
            defaultValue={values.sortOrder ?? 0}
          />
        </FormField>
      </div>
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Rental rules for this category (optional overrides)
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <FormField id={`${p}-hours`} label="Included hours" hint="e.g. 4 for water slides">
            <Input
              id={`${p}-hours`}
              name="includedHours"
              type="number"
              step="0.25"
              min="0.25"
              defaultValue={
                values.includedDurationMinutes != null ? values.includedDurationMinutes / 60 : ""
              }
            />
          </FormField>
          <FormField id={`${p}-setup`} label="Setup buffer (min)">
            <Input
              id={`${p}-setup`}
              name="setupBufferMinutes"
              type="number"
              min="0"
              max="1440"
              defaultValue={values.setupBufferMinutes ?? ""}
            />
          </FormField>
          <FormField id={`${p}-teardown`} label="Pickup buffer (min)">
            <Input
              id={`${p}-teardown`}
              name="teardownBufferMinutes"
              type="number"
              min="0"
              max="1440"
              defaultValue={values.teardownBufferMinutes ?? ""}
            />
          </FormField>
          <TriStateField
            id={`${p}-overnight`}
            name="overnightAllowed"
            label="Overnight allowed"
            value={values.overnightAllowed}
          />
        </div>
        <div className="mt-4 grid gap-2">
          <span className="text-sm font-semibold">Weather sensitivity</span>
          <WeatherRulesEditor rules={values.weatherRules ?? []} inheritLabel="Business default" />
        </div>
      </details>
      <CheckboxField
        name="isPublished"
        label="Show on the storefront"
        defaultChecked={values.isPublished ?? true}
      />
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : values.id ? "Save" : "Create category"}
        </Button>
      </div>
    </form>
  );
}
