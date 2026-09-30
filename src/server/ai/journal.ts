import "server-only";
import { isDomainError } from "@/domain/errors";
import type { AiConversationStore, AiTurnRef } from "@/server/trusted/gateway";
import type { Json } from "@/types/database";
import {
  applyMutationRef,
  type AssistantBlock,
  type AssistantState,
  type Committed,
  type MutationJournal,
  type MutationRef,
  type MutationSpec,
  mutationRefSchema,
  ToolError,
  type ToolOutcome,
} from "./context";
import { type Deadline, DeadlineError } from "./deadline";

/**
 * The durable mutation protocol (ADR 0017 §11):
 *  1. no mutation starts after the turn's deadline, or when the turn no longer owns the
 *     conversation (the database checks the lease);
 *  2. the mutation is claimed in the journal under a SEMANTIC key — conversation + what is
 *     created — so a retried, repeated or re-planned request maps to the same row, whatever turn
 *     or tool-call id the model uses the second time;
 *  3. a committed claim is replayed, never repeated; an unrecorded earlier attempt is resolved
 *     from what it stored before running (e.g. the quote token hash) before anything runs again;
 *  4. the outcome is committed right after the service returns — before the model is called again —
 *     and its reference applied to the conversation state.
 */

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic JSON (sorted keys) so equal values give equal keys. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Refusals the services raise BEFORE writing anything: the mutation definitely did not happen. */
function definitelyNotApplied(e: unknown): boolean {
  if (e instanceof ToolError || e instanceof DeadlineError) return true;
  return isDomainError(e) && e.code !== "INTERNAL";
}

/** The outcome as stored/replayed: quote link tokens are removed (never stored). */
export function storableOutcome(outcome: ToolOutcome): ToolOutcome {
  return {
    ...outcome,
    blocks: outcome.blocks.map((b): AssistantBlock =>
      b.type === "quote" ? { ...b, url: null } : b,
    ),
  };
}

function replayedOutcome(stored: unknown): ToolOutcome {
  const o = stored as Partial<ToolOutcome> | null;
  if (!o || typeof o !== "object" || !o.result || !Array.isArray(o.blocks)) {
    return { status: "ok", result: { replayed: true }, blocks: [] };
  }
  return { ...(o as ToolOutcome), result: { ...o.result, replayed: true } };
}

export interface DurableJournalOptions {
  store: AiConversationStore;
  organizationId: string;
  conversationId: string;
  turn: AiTurnRef;
  state: AssistantState;
  deadline: Deadline;
  toolCallId: () => string;
  /** Every reference applied by this turn (committed, recovered or replayed), in order. */
  onApplied: (ref: MutationRef) => void;
  onCommitted: (seq: number) => void;
  onError: (where: string, e: unknown) => void;
}

export function durableJournal(o: DurableJournalOptions): MutationJournal {
  const apply = (ref: MutationRef) => {
    applyMutationRef(o.state, ref);
    o.onApplied(ref);
  };
  return {
    requestId: o.turn.turnId,
    async run(spec: MutationSpec) {
      if (o.deadline.expired()) {
        throw new ToolError(
          "TURN_DEADLINE",
          "There was not enough time left to do that safely; nothing was changed. Ask the customer to send the message again.",
        );
      }
      const key = await sha256Hex(`${o.conversationId}|${spec.toolName}|${canonical(spec.key)}`);
      let claim;
      try {
        claim = await o.store.beginMutation(o.organizationId, o.turn, {
          key,
          toolName: spec.toolName,
          toolCallId: o.toolCallId(),
          pending: spec.pending,
        });
      } catch (e) {
        o.onError("journal:begin", e);
        throw new ToolError(
          "TURN_LOST",
          "This message can no longer make changes (another message took over). Nothing was changed.",
        );
      }
      if (claim.outcome === "replay") {
        const ref = mutationRefSchema.safeParse(claim.ref);
        if (ref.success) apply(ref.data);
        return { replayed: true, outcome: replayedOutcome(claim.result) };
      }
      if (claim.outcome === "in_progress") {
        throw new ToolError("IN_PROGRESS", "That change is already being made.");
      }
      if (claim.outcome === "unknown") {
        const recovered = await spec.recover(claim.pending as Record<string, string> | null);
        if (recovered) {
          await commit(claim.mutationId, recovered);
          apply(recovered.ref);
          return { replayed: true, outcome: recovered.outcome };
        }
      }
      let committed: Committed;
      try {
        committed = await spec.perform();
      } catch (e) {
        if (definitelyNotApplied(e)) {
          await o.store
            .failMutation(o.organizationId, claim.mutationId, errorCode(e))
            .catch((err: unknown) => {
              o.onError("journal:fail", err);
            });
        }
        // Otherwise the row stays 'started': the next attempt resolves it through `recover`.
        throw e;
      }
      await commit(claim.mutationId, committed);
      apply(committed.ref);
      return { replayed: false, outcome: committed.outcome };
    },
  };

  async function commit(mutationId: string, c: Committed) {
    const ref = c.ref as unknown as Json;
    const result = storableOutcome(c.outcome) as unknown as Json;
    // Must be recorded even after the deadline; one retry, then the state (persisted when the turn
    // ends) and the 'started' row's pending data still let the next attempt find it.
    for (let i = 0; i < 2; i++) {
      try {
        o.onCommitted(await o.store.commitMutation(o.organizationId, mutationId, ref, result));
        return;
      } catch (e) {
        o.onError("journal:commit", e);
      }
    }
  }
}

function errorCode(e: unknown): string {
  if (e instanceof ToolError) return e.code;
  if (e instanceof DeadlineError) return "TURN_DEADLINE";
  return isDomainError(e) ? e.code : "ERROR";
}

/**
 * Without a conversation (tool tests): runs mutations directly and applies their references.
 * Production turns always use durableJournal.
 */
export function directJournal(state: AssistantState): MutationJournal {
  return {
    requestId: crypto.randomUUID(),
    async run(spec) {
      const c = await spec.perform();
      applyMutationRef(state, c.ref);
      return { replayed: false, outcome: c.outcome };
    },
  };
}
