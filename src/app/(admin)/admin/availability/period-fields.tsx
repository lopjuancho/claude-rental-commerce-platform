import { FormField } from "@/components/form-field";
import { Input } from "@/components/ui/input";

/**
 * Daylight-saving choice for a time that happens twice (the night clocks move back). Blank means
 * such a time is rejected with an explanation; times that do not exist are always rejected.
 */
export function FoldField({ id }: { id: string }) {
  return (
    <FormField id={id} label="If the time happens twice (clocks move back)">
      <select
        id={id}
        name="fold"
        defaultValue=""
        className="h-9 rounded-md border bg-background px-2 text-sm"
      >
        <option value="">Ask me (reject)</option>
        <option value="earlier">First occurrence (daylight time)</option>
        <option value="later">Second occurrence (standard time)</option>
      </select>
    </FormField>
  );
}

/** Local date/time inputs (organization time zone). End before start = ends next day. */
export function PeriodFields({
  prefix,
  defaultStart = "12:00",
  defaultEnd = "18:00",
}: {
  prefix: string;
  defaultStart?: string;
  defaultEnd?: string;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-5">
      <FormField id={`${prefix}-date`} label="Date">
        <Input id={`${prefix}-date`} name="date" type="date" required />
      </FormField>
      <FormField id={`${prefix}-start`} label="Start">
        <Input
          id={`${prefix}-start`}
          name="startTime"
          type="time"
          defaultValue={defaultStart}
          required
        />
      </FormField>
      <FormField id={`${prefix}-end`} label="End">
        <Input id={`${prefix}-end`} name="endTime" type="time" defaultValue={defaultEnd} required />
      </FormField>
      <FormField id={`${prefix}-enddate`} label="End date (multi-day)">
        <Input id={`${prefix}-enddate`} name="endDate" type="date" />
      </FormField>
      <FoldField id={`${prefix}-fold`} />
    </div>
  );
}
