"use client";

import { useActionState } from "react";
import { FormField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { MEDIA_RIGHTS } from "@/domain/catalog/vocabulary";
import { updateMediaAction, uploadMediaAction } from "../actions";

interface Media {
  id: string;
  url: string | null;
  kind: string;
  alt_text: string | null;
  is_primary: boolean;
  rights_status: string;
  rights_notes: string | null;
  original_filename: string | null;
}

const RIGHTS_LABELS: Record<string, string> = {
  owned: "Our own photo",
  licensed: "Licensed for our use",
  supplier_permitted: "Supplier allows reuse",
  unverified: "Rights not verified (hidden from storefront)",
};

export function MediaPanel({
  productId,
  media,
  canWrite,
}: {
  productId: string;
  media: Media[];
  canWrite: boolean;
}) {
  const [state, action, pending] = useActionState(uploadMediaAction, idleState);
  return (
    <div className="grid gap-5">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {media.map((m) => (
          <li key={m.id} className="grid gap-2 rounded-md border p-2">
            {m.url && m.kind === "image" ? (
              // Signed, short-lived URL to a private bucket: next/image optimisation is not used here.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={m.url}
                alt={m.alt_text ?? ""}
                className="aspect-[4/3] w-full rounded object-cover"
              />
            ) : (
              <div className="grid aspect-[4/3] place-items-center rounded bg-muted text-xs text-muted-foreground">
                {m.kind}
              </div>
            )}
            <p className="truncate text-xs text-muted-foreground">
              {m.original_filename}
              {m.is_primary ? " · primary" : ""}
            </p>
            {m.rights_status === "unverified" ? (
              <p className="text-xs font-medium text-destructive">
                Rights not verified: not shown publicly.
              </p>
            ) : null}
            {canWrite ? (
              <form action={updateMediaAction} className="grid gap-2">
                <input type="hidden" name="productId" value={productId} />
                <input type="hidden" name="mediaId" value={m.id} />
                <label className="sr-only" htmlFor={`alt-${m.id}`}>
                  Alt text
                </label>
                <Input
                  id={`alt-${m.id}`}
                  name="altText"
                  defaultValue={m.alt_text ?? ""}
                  placeholder="Describe the photo"
                />
                <label className="sr-only" htmlFor={`rights-${m.id}`}>
                  Usage rights
                </label>
                <NativeSelect
                  id={`rights-${m.id}`}
                  name="rightsStatus"
                  defaultValue={m.rights_status}
                >
                  {MEDIA_RIGHTS.map((r) => (
                    <option key={r} value={r}>
                      {RIGHTS_LABELS[r]}
                    </option>
                  ))}
                </NativeSelect>
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" type="submit" name="intent" value="rights">
                    Save
                  </Button>
                  {!m.is_primary ? (
                    <Button size="sm" variant="ghost" type="submit" name="intent" value="primary">
                      Make primary
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" type="submit" name="intent" value="delete">
                    Delete
                  </Button>
                </div>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form action={action} className="grid gap-3 rounded-md border p-3">
          <input type="hidden" name="productId" value={productId} />
          <FormField
            id="file"
            label="Photo or video"
            hint="JPEG, PNG, WebP, AVIF or MP4, up to 10 MB."
          >
            <Input
              id="file"
              name="file"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif,video/mp4"
              required
            />
          </FormField>
          <FormField id="altText" label="Description (alt text)">
            <Input id="altText" name="altText" maxLength={300} />
          </FormField>
          <FormField
            id="rightsStatus"
            label="Usage rights"
            hint="Only upload media you own or are licensed to use. Unverified media is never published."
          >
            <NativeSelect id="rightsStatus" name="rightsStatus" defaultValue="unverified">
              {MEDIA_RIGHTS.map((r) => (
                <option key={r} value={r}>
                  {RIGHTS_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField
            id="rightsNotes"
            label="Rights notes (optional)"
            hint="e.g. photographer, license, supplier permission."
          >
            <Input id="rightsNotes" name="rightsNotes" maxLength={1000} />
          </FormField>
          <FormMessage state={state} />
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
