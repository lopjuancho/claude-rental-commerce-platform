"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteMemberAction, type InviteState } from "../actions";

const initial: InviteState = { status: "idle" };

export function InviteForm({ roles }: { roles: string[] }) {
  const [state, action, pending] = useActionState(inviteMemberAction, initial);
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
      <div className="grid gap-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" name="email" type="email" required />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="invite-role">Role</Label>
        <select
          id="invite-role"
          name="role"
          defaultValue="staff"
          className="h-10 rounded-md border bg-background px-3 text-sm capitalize"
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Inviting…" : "Invite"}
      </Button>
      <div className="md:col-span-3">
        <FormMessage state={state} />
        {state.inviteUrl ? (
          <Input
            readOnly
            value={state.inviteUrl}
            aria-label="Invitation link"
            className="mt-2 font-mono text-xs"
          />
        ) : null}
      </div>
    </form>
  );
}
