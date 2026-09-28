"use client";

import { useActionState } from "react";
import { CheckboxField, FormField, TriStateField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { type WeatherRuleValue, WeatherRulesEditor } from "@/components/weather-rules-editor";
import {
  ANCHORING_METHODS,
  EVENT_TYPES,
  PRICING_TYPES,
  SURFACES,
} from "@/domain/catalog/vocabulary";
import type { Database } from "@/types/database";
import { saveProductAction } from "./actions";

type ProductRow = Database["public"]["Tables"]["products"]["Row"];
export type ProductFormValues = Partial<ProductRow> & {
  categoryIds?: string[];
  weatherRules?: WeatherRuleValue[];
};

const hours = (minutes: number | null | undefined) => (minutes == null ? "" : String(minutes / 60));
const money = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));
const label = (s: string) => s.replaceAll("_", " ");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="grid gap-4 rounded-xl border p-4">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function CheckboxGroup({
  name,
  options,
  selected,
}: {
  name: string;
  options: readonly string[];
  selected: readonly string[];
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {options.map((o) => (
        <label key={o} className="flex items-center gap-2 text-sm capitalize">
          <input
            type="checkbox"
            name={name}
            value={o}
            defaultChecked={selected.includes(o)}
            className="size-4"
          />
          {label(o)}
        </label>
      ))}
    </div>
  );
}

export function ProductForm({
  values = {},
  categories,
  canWrite,
}: {
  values?: ProductFormValues;
  categories: { id: string; name: string }[];
  canWrite: boolean;
}) {
  const [state, action, pending] = useActionState(saveProductAction, idleState);
  const v = values;
  return (
    <form action={action} className="grid gap-5">
      {v.id ? <input type="hidden" name="id" value={v.id} /> : null}
      <fieldset disabled={!canWrite} className="grid gap-5">
        <Section title="Basics">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="name" label="Name">
              <Input id="name" name="name" defaultValue={v.name} required maxLength={200} />
            </FormField>
            <FormField id="slug" label="URL slug" hint="Leave blank to generate from the name.">
              <Input id="slug" name="slug" defaultValue={v.slug} maxLength={160} />
            </FormField>
          </div>
          <FormField
            id="shortDescription"
            label="Short description"
            hint="Shown on product cards (300 characters)."
          >
            <Input
              id="shortDescription"
              name="shortDescription"
              defaultValue={v.short_description ?? ""}
              maxLength={300}
            />
          </FormField>
          <FormField id="description" label="Description">
            <Textarea
              id="description"
              name="description"
              rows={5}
              defaultValue={v.description ?? ""}
            />
          </FormField>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Categories</span>
            {categories.length === 0 ? (
              <p className="text-sm text-muted-foreground">Create categories first.</p>
            ) : null}
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {categories.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name="categoryIds"
                    value={c.id}
                    defaultChecked={v.categoryIds?.includes(c.id)}
                    className="size-4"
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <FormField
              id="primaryCategoryId"
              label="Primary category"
              hint="Drives category-level rules such as included hours and weather sensitivity."
            >
              <NativeSelect
                id="primaryCategoryId"
                name="primaryCategoryId"
                defaultValue={v.primary_category_id ?? ""}
              >
                <option value="">First selected</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>
          <div className="flex flex-wrap gap-6">
            <CheckboxField
              name="isPublished"
              label="Published on storefront"
              defaultChecked={v.is_published ?? false}
            />
            <CheckboxField
              name="isFeatured"
              label="Featured"
              defaultChecked={v.is_featured ?? false}
            />
          </div>
        </Section>

        <Section title="Pricing">
          <div className="grid gap-4 sm:grid-cols-4">
            <FormField id="basePrice" label="Base price ($)">
              <Input
                id="basePrice"
                name="basePrice"
                inputMode="decimal"
                defaultValue={money(v.base_price_cents)}
                required
              />
            </FormField>
            <FormField id="pricingType" label="Pricing type">
              <NativeSelect
                id="pricingType"
                name="pricingType"
                defaultValue={v.pricing_type ?? "per_event"}
              >
                {PRICING_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField
              id="includedHours"
              label="Included hours"
              hint="Blank = category / business default"
            >
              <Input
                id="includedHours"
                name="includedHours"
                type="number"
                step="0.25"
                min="0.25"
                defaultValue={hours(v.included_duration_minutes)}
              />
            </FormField>
            <FormField id="minimumHours" label="Minimum rental (h)">
              <Input
                id="minimumHours"
                name="minimumHours"
                type="number"
                step="0.25"
                min="0.25"
                defaultValue={hours(v.minimum_rental_minutes)}
              />
            </FormField>
          </div>
        </Section>

        <Section title="Who and where it suits">
          <div className="flex flex-wrap gap-6">
            <CheckboxField
              name="dryAllowed"
              label="Dry use"
              defaultChecked={v.dry_allowed ?? true}
            />
            <CheckboxField
              name="wetAllowed"
              label="Wet use"
              defaultChecked={v.wet_allowed ?? false}
            />
            <CheckboxField
              name="outdoorAllowed"
              label="Outdoor"
              defaultChecked={v.outdoor_allowed ?? true}
            />
            <CheckboxField
              name="indoorAllowed"
              label="Indoor"
              defaultChecked={v.indoor_allowed ?? false}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <FormField id="minimumAge" label="Minimum age">
              <Input
                id="minimumAge"
                name="minimumAge"
                type="number"
                min="0"
                max="120"
                defaultValue={v.minimum_age ?? ""}
              />
            </FormField>
            <FormField id="maximumAge" label="Maximum age">
              <Input
                id="maximumAge"
                name="maximumAge"
                type="number"
                min="0"
                max="120"
                defaultValue={v.maximum_age ?? ""}
              />
            </FormField>
            <FormField id="recommendedCapacity" label="Riders at once">
              <Input
                id="recommendedCapacity"
                name="recommendedCapacity"
                type="number"
                min="1"
                defaultValue={v.recommended_capacity ?? ""}
              />
            </FormField>
            <FormField id="maxRiderWeightLbs" label="Max rider weight (lbs)">
              <Input
                id="maxRiderWeightLbs"
                name="maxRiderWeightLbs"
                type="number"
                min="1"
                defaultValue={v.max_rider_weight_lbs ?? ""}
              />
            </FormField>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Ideal for</span>
            <CheckboxGroup
              name="idealEventTypes"
              options={EVENT_TYPES}
              selected={v.ideal_event_types ?? []}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Suitable surfaces</span>
            <CheckboxGroup
              name="allowedSurfaces"
              options={SURFACES}
              selected={v.allowed_surfaces ?? []}
            />
          </div>
        </Section>

        <Section title="Space, power and setup">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField id="spaceLengthFt" label="Length (ft)">
              <Input
                id="spaceLengthFt"
                name="spaceLengthFt"
                inputMode="decimal"
                defaultValue={v.space_length_ft ?? ""}
              />
            </FormField>
            <FormField id="spaceWidthFt" label="Width (ft)">
              <Input
                id="spaceWidthFt"
                name="spaceWidthFt"
                inputMode="decimal"
                defaultValue={v.space_width_ft ?? ""}
              />
            </FormField>
            <FormField id="spaceHeightFt" label="Height (ft)">
              <Input
                id="spaceHeightFt"
                name="spaceHeightFt"
                inputMode="decimal"
                defaultValue={v.space_height_ft ?? ""}
              />
            </FormField>
            <FormField id="powerOutletsRequired" label="Outlets required">
              <Input
                id="powerOutletsRequired"
                name="powerOutletsRequired"
                type="number"
                min="0"
                defaultValue={v.power_outlets_required ?? ""}
              />
            </FormField>
            <FormField id="setupMinutes" label="Setup time (min)">
              <Input
                id="setupMinutes"
                name="setupMinutes"
                type="number"
                min="0"
                defaultValue={v.setup_minutes ?? ""}
              />
            </FormField>
            <FormField id="teardownMinutes" label="Teardown time (min)">
              <Input
                id="teardownMinutes"
                name="teardownMinutes"
                type="number"
                min="0"
                defaultValue={v.teardown_minutes ?? ""}
              />
            </FormField>
            <FormField id="attendantsRequired" label="Attendants required">
              <Input
                id="attendantsRequired"
                name="attendantsRequired"
                type="number"
                min="0"
                max="20"
                defaultValue={v.attendants_required ?? 0}
              />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-6">
            <CheckboxField
              name="waterRequired"
              label="Needs a water hookup"
              defaultChecked={v.water_required ?? false}
            />
            <CheckboxField
              name="operatorRequired"
              label="Needs an operator"
              defaultChecked={v.operator_required ?? false}
            />
          </div>
          <FormField id="powerNotes" label="Power notes">
            <Input
              id="powerNotes"
              name="powerNotes"
              defaultValue={v.power_notes ?? ""}
              maxLength={500}
            />
          </FormField>
          <FormField
            id="setupRequirements"
            label="Setup requirements"
            hint="Customer-facing, e.g. flat area, no slope, 3 ft clearance."
          >
            <Textarea
              id="setupRequirements"
              name="setupRequirements"
              rows={3}
              defaultValue={v.setup_requirements ?? ""}
            />
          </FormField>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Anchoring</span>
            <CheckboxGroup
              name="anchoringMethods"
              options={ANCHORING_METHODS}
              selected={v.anchoring_methods ?? []}
            />
          </div>
        </Section>

        <Section title="Operating rules (blank = inherit from category / business settings)">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField id="setupBufferMinutes" label="Setup buffer (min)">
              <Input
                id="setupBufferMinutes"
                name="setupBufferMinutes"
                type="number"
                min="0"
                max="1440"
                defaultValue={v.setup_buffer_minutes ?? ""}
              />
            </FormField>
            <FormField id="teardownBufferMinutes" label="Pickup buffer (min)">
              <Input
                id="teardownBufferMinutes"
                name="teardownBufferMinutes"
                type="number"
                min="0"
                max="1440"
                defaultValue={v.teardown_buffer_minutes ?? ""}
              />
            </FormField>
            <FormField id="leadTimeHours" label="Booking lead time (h)">
              <Input
                id="leadTimeHours"
                name="leadTimeHours"
                type="number"
                step="0.5"
                min="0"
                defaultValue={hours(v.min_booking_lead_time_minutes)}
              />
            </FormField>
            <TriStateField
              id="overnightAllowed"
              name="overnightAllowed"
              label="Overnight allowed"
              value={v.overnight_allowed}
            />
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-semibold">Weather sensitivity</span>
            <p className="text-xs text-muted-foreground">
              Leave on “Category rule” unless the manufacturer specifies something different for
              this item.
            </p>
            <WeatherRulesEditor
              rules={v.weatherRules ?? []}
              inheritLabel="Category rule"
              disabled={!canWrite}
            />
          </div>
        </Section>

        <Section title="Discovery and internal">
          <FormField id="tags" label="Tags" hint="Comma separated, e.g. castle, toddler">
            <Input id="tags" name="tags" defaultValue={(v.tags ?? []).join(", ")} />
          </FormField>
          <FormField id="sortOrder" label="Sort order">
            <Input id="sortOrder" name="sortOrder" type="number" defaultValue={v.sort_order ?? 0} />
          </FormField>
          <FormField
            id="internalNotes"
            label="Internal notes"
            hint="Never shown to customers or the AI assistant."
          >
            <Textarea
              id="internalNotes"
              name="internalNotes"
              rows={3}
              defaultValue={v.internal_notes ?? ""}
            />
          </FormField>
        </Section>
      </fieldset>
      <FormMessage state={state} />
      {canWrite ? (
        <div className="sticky bottom-0 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:border-0 md:p-0">
          <Button type="submit" disabled={pending} className="w-full md:w-auto">
            {pending ? "Saving…" : v.id ? "Save product" : "Create product"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
