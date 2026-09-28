"use client";

import { useActionState } from "react";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { commitImportAction, savePresetAction, validateImportAction } from "../actions";

export function MappingForm(props: {
  batchId: string;
  headers: string[];
  fields: { key: string; label: string; required: boolean }[];
  mapping: Record<string, string>;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(validateImportAction, idleState);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="batchId" value={props.batchId} />
      <div className="grid gap-3 sm:grid-cols-2">
        {props.fields.map((f) => (
          <label key={f.key} className="grid gap-1 text-sm">
            <span className="font-medium">
              {f.label}
              {f.required ? " *" : ""}
            </span>
            <NativeSelect
              name={`map.${f.key}`}
              defaultValue={props.mapping[f.key] ?? ""}
              disabled={props.disabled}
            >
              <option value="">— not imported —</option>
              {props.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </NativeSelect>
          </label>
        ))}
      </div>
      <FormMessage state={state} />
      {!props.disabled ? (
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? "Checking rows…" : "Validate and preview"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function CommitForm({ batchId, canCommit }: { batchId: string; canCommit: boolean }) {
  const [state, action, pending] = useActionState(commitImportAction, idleState);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending || !canCommit}>
          {pending ? "Importing…" : "Import into catalog"}
        </Button>
      </div>
    </form>
  );
}

export function PresetForm({ batchId }: { batchId: string }) {
  const [state, action, pending] = useActionState(savePresetAction, idleState);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="batchId" value={batchId} />
      <label className="grid gap-1 text-sm">
        <span>Save this mapping as</span>
        <Input name="name" placeholder="e.g. ERS inventory export" maxLength={120} required />
      </label>
      <Button type="submit" variant="outline" disabled={pending}>
        Save mapping
      </Button>
      <FormMessage state={state} />
    </form>
  );
}
