"use client";

import { useActionState } from "react";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { acceptInvitationAction } from "../actions";

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitationAction, idleState);
  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
    </form>
  );
}
