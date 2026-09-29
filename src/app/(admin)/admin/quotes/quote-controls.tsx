"use client";

import { useActionState } from "react";
import { CheckboxField } from "@/components/form-field";
import { FormMessage, idleState } from "@/components/form-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type QuoteStatus, QUOTE_TRANSITIONS, reviewBlocks } from "@/domain/quotes/state-machine";
import { bookingAction, quoteAction, type QuoteActionState } from "./actions";

const LABELS: Record<string, string> = {
  send: "Mark as sent",
  declined: "Mark declined",
  cancelled: "Cancel quote",
  draft: "Revise (back to draft)",
};

/** Buttons shown follow the state machine; the database enforces it regardless. */
export function QuoteControls({
  id,
  status,
  manualReviewRequired,
  reviewApprovedAt,
  canHold,
}: {
  id: string;
  status: QuoteStatus;
  manualReviewRequired: boolean | null;
  reviewApprovedAt: string | null;
  canHold: boolean;
}) {
  const [state, action, pending] = useActionState<QuoteActionState, FormData>(
    quoteAction,
    idleState,
  );
  const ops = QUOTE_TRANSITIONS[status]
    // 'accepted' only via "Confirm booking" on the booking request (the database enforces it).
    .filter((s) => s !== "viewed" && s !== "expired" && s !== "accepted")
    .map((s) => (s === "sent" ? "send" : s));
  const blocked = reviewBlocks({ manualReviewRequired, reviewApprovedAt });
  const btn = (op: string, label: string, variant: "default" | "outline" = "outline") => (
    <form key={op} action={action}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      <Button type="submit" size="sm" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
  return (
    <div className="grid gap-3">
      {blocked ? (
        <form
          action={action}
          className="flex flex-wrap items-end gap-2 rounded-md border border-amber-300 bg-amber-50 p-3"
        >
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="op" value="approve" />
          <label className="grid gap-1 text-sm">
            Price needs review. What did you check?
            <Input
              name="note"
              required
              minLength={3}
              maxLength={1000}
              placeholder="e.g. Tax verified manually"
            />
          </label>
          <Button type="submit" size="sm" disabled={pending}>
            Approve price
          </Button>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {status === "draft" ? btn("reprice", "Re-price with current rates") : null}
        {ops.map((op) => btn(op, LABELS[op] ?? op, op === "send" ? "default" : "outline"))}
        {btn("link", "Create customer link")}
        {canHold ? btn("hold", "Hold items (booking request)") : null}
      </div>
      {state.link ? (
        <p className="break-all text-sm">
          Customer link (shown once): <code>{state.link.url ?? state.link.path}</code>
        </p>
      ) : null}
      <FormMessage state={state} />
    </div>
  );
}

export function BookingDecision({ id, quoteId }: { id: string; quoteId: string }) {
  const [state, action, pending] = useActionState(bookingAction, idleState);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="quoteId" value={quoteId} />
          <input type="hidden" name="op" value="confirm" />
          <Button type="submit" size="sm" disabled={pending}>
            Confirm booking
          </Button>
          <CheckboxField name="ignoreWeather" label="Confirm despite a weather block" />
        </form>
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="quoteId" value={quoteId} />
          <input type="hidden" name="op" value="decline" />
          <Input name="note" placeholder="Reason (optional)" className="h-8 w-48" />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            Decline
          </Button>
        </form>
      </div>
      <FormMessage state={state} />
    </div>
  );
}
