import { CheckboxField, FormField } from "@/components/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

/** Item rows: product + quantity. Prices are computed by the server, never entered here. */
export function ItemFields({
  options,
  rows = 6,
}: {
  options: { variantId: string; label: string }[];
  rows?: number;
}) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-semibold">Items</legend>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[1fr_5rem] items-center gap-2">
          <label className="sr-only" htmlFor={`variant${i}`}>
            Item {i + 1}
          </label>
          <NativeSelect id={`variant${i}`} name={`variant${i}`} defaultValue="">
            <option value="">{i === 0 ? "Choose an item…" : "—"}</option>
            {options.map((o) => (
              <option key={o.variantId} value={o.variantId}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
          <label className="sr-only" htmlFor={`quantity${i}`}>
            Quantity for item {i + 1}
          </label>
          <Input
            id={`quantity${i}`}
            name={`quantity${i}`}
            type="number"
            min={1}
            max={1000}
            defaultValue={1}
          />
        </div>
      ))}
    </fieldset>
  );
}

/** Event date/time (organization's local time) and address. */
export function EventFields({ timeZone }: { timeZone: string }) {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-semibold">Event (times in {timeZone})</legend>
      <div className="grid gap-3 sm:grid-cols-4">
        <FormField id="date" label="Date">
          <Input id="date" name="date" type="date" required />
        </FormField>
        <FormField id="startTime" label="Start">
          <Input id="startTime" name="startTime" type="time" defaultValue="12:00" required />
        </FormField>
        <FormField id="endTime" label="End" hint="Earlier than the start = next day">
          <Input id="endTime" name="endTime" type="time" defaultValue="16:00" required />
        </FormField>
        <FormField id="endDate" label="End date (multi-day)">
          <Input id="endDate" name="endDate" type="date" />
        </FormField>
      </div>
      <FormField
        id="fold"
        label="If the time happens twice (the night clocks move back)"
        hint="Only matters on that one night a year."
      >
        <NativeSelect id="fold" name="fold" defaultValue="">
          <option value="">Ask me</option>
          <option value="earlier">First occurrence (daylight time)</option>
          <option value="later">Second occurrence (standard time)</option>
        </NativeSelect>
      </FormField>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_4rem_6rem]">
        <FormField id="line1" label="Event address">
          <Input id="line1" name="line1" autoComplete="street-address" />
        </FormField>
        <FormField id="city" label="City">
          <Input id="city" name="city" autoComplete="address-level2" />
        </FormField>
        <FormField id="state" label="State">
          <Input id="state" name="state" maxLength={2} autoComplete="address-level1" />
        </FormField>
        <FormField id="postalCode" label="ZIP">
          <Input id="postalCode" name="postalCode" inputMode="numeric" autoComplete="postal-code" />
        </FormField>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" name="delivery" value="delivery" defaultChecked /> Deliver to the
          event
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="delivery" value="pickup" /> I will pick up
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <FormField id="guestCount" label="Guests">
          <Input id="guestCount" name="guestCount" type="number" min={0} />
        </FormField>
        <FormField id="eventNotes" label="Event notes">
          <Input id="eventNotes" name="eventNotes" maxLength={4000} />
        </FormField>
      </div>
    </fieldset>
  );
}

export function ContactFields() {
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-1 text-sm font-semibold">Contact</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField id="firstName" label="First name">
          <Input id="firstName" name="firstName" autoComplete="given-name" />
        </FormField>
        <FormField id="lastName" label="Last name">
          <Input id="lastName" name="lastName" autoComplete="family-name" />
        </FormField>
        <FormField id="email" label="Email">
          <Input id="email" name="email" type="email" autoComplete="email" />
        </FormField>
        <FormField id="phone" label="Phone">
          <Input id="phone" name="phone" type="tel" autoComplete="tel" />
        </FormField>
      </div>
      <CheckboxField name="emailOptIn" label="Email me about my booking" />
      <CheckboxField name="smsOptIn" label="Text me about my booking" />
    </fieldset>
  );
}

export function MessageField({ label = "Anything we should know?" }: { label?: string }) {
  return (
    <FormField id="message" label={label}>
      <Textarea id="message" name="message" maxLength={2000} rows={3} />
    </FormField>
  );
}
