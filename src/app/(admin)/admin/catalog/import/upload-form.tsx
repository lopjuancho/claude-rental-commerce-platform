"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { uploadImportAction } from "./actions";

export function UploadForm({ adapters }: { adapters: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(uploadImportAction, idleState);
  return (
    <form action={action} className="grid gap-4">
      <FormField
        id="file"
        label="CSV file"
        hint="Up to 5,000 rows / 5 MB. Nothing is imported until you review and confirm."
      >
        <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
      </FormField>
      <FormField id="adapterId" label="Source format">
        <NativeSelect id="adapterId" name="adapterId" defaultValue="auto">
          <option value="auto">Detect automatically</option>
          {adapters.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormMessage state={state} />
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Reading file…" : "Upload and preview"}
        </Button>
      </div>
    </form>
  );
}
