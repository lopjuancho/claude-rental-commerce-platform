"use client";

import { useActionState, useEffect, useState } from "react";
import { FormMessage, idleState } from "@/components/form-message";
import { MessageField } from "@/components/quote-fields";
import { Button } from "@/components/ui/button";
import { cancelBookingAction, renewHoldAction, requestBookingAction } from "../../quote/actions";
import { useFollowRedirect } from "../../quote/follow-redirect";

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  const ms = Math.max(0, Date.parse(until) - now);
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return (
    <span aria-live="polite" className="font-mono font-semibold">
      {ms === 0 ? "expired" : `${m}:${String(s).padStart(2, "0")}`}
    </span>
  );
}

export function RequestBooking({ token }: { token: string }) {
  const [state, action, pending] = useActionState(requestBookingAction, idleState);
  useFollowRedirect(state);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="token" value={token} />
      <MessageField label="Message for our team (optional)" />
      <FormMessage state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Checking availability…" : "Request this booking"}
      </Button>
      <p className="text-xs text-muted-foreground">
        We hold the items for you for a few minutes while our team reviews your request. Nothing is
        charged.
      </p>
    </form>
  );
}

export function HoldStatus({ token, until }: { token: string; until: string }) {
  const [renewState, renew, renewing] = useActionState(renewHoldAction, idleState);
  const [cancelState, cancel, cancelling] = useActionState(cancelBookingAction, idleState);
  useFollowRedirect(renewState);
  useFollowRedirect(cancelState);
  return (
    <div className="grid gap-3 rounded-lg border p-4">
      <p>
        Your items are held for <Countdown until={until} />. Our team will confirm your booking.
      </p>
      <div className="flex flex-wrap gap-2">
        <form action={renew}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" variant="outline" disabled={renewing}>
            Keep holding
          </Button>
        </form>
        <form action={cancel}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit" variant="ghost" disabled={cancelling}>
            Cancel request
          </Button>
        </form>
      </div>
      <FormMessage state={renewState} />
      <FormMessage state={cancelState} />
    </div>
  );
}
