import { FormField } from "@/components/form-field";
import { Input } from "@/components/ui/input";

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
    <div className="grid gap-3 sm:grid-cols-4">
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
    </div>
  );
}
