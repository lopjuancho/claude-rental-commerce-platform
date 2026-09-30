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
import type { Sealer } from "./seal";

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

/**
 * The outcome as stored for replay: a quote link is never stored in clear — its token is sealed to
 * the customer's session (see seal.ts) and reopened only when the same session replays it.
 */
export async function storableOutcome(outcome: ToolOutcome, sealer: Sealer): Promise<ToolOutcome> {
  return {
    ...outcome,
    blocks: await Promise.all(outcome.blocks.map((b) => sealBlock(b, sealer))),
  };
}

export async function sealBlock(b: AssistantBlock, sealer: Sealer): Promise<AssistantBlock> {
  if (b.type !== "quote" || !b.url) return b;
  return { ...b, url: null, sealedLink: await sealer.seal(b.url) };
}

export async function openBlock(b: AssistantBlock, sealer: Sealer): Promise<AssistantBlock> {
  if (b.type !== "quote" || !b.sealedLink) return b;
  const url = await sealer.open(b.sealedLink);
  const { sealedLink: _sealed, ...rest } = b;
  return { ...rest, url: url && /^\/q\/[A-Za-z0-9_-]{43}$/.test(url) ? url : null };
}

async function replayedOutcome(
  stored: unknown,
  _state: AssistantState,
  spec: MutationSpec,
): Promise<ToolOutcome> {
  const o = stored as Partial<ToolOutcome> | null;
  if (!o || typeof o !== "object" || !o.result || !Array.isArray(o.blocks)) {
    return { status: "ok", result: { replayed: true }, blocks: [] };
  }
  return {
    ...(o as ToolOutcome),
    result: { ...o.result, replayed: true },
    blocks: await Promise.all(o.blocks.map((b) => openBlock(b, spec.sealer))),
  };
}

export interface DurableJournalOptions {
  store: AiConversationStore;
  organizationId: string;
  conversationId: string;
  turn: AiTurnRef;
  state: AssistantState;
  deadline: Deadline;
  toolCallId: () => string;
  sealer: Sealer;
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
  const tooLate = () =>
    new ToolError(
      "TURN_DEADLINE",
      "There was not enough time left to do that safely; nothing was changed. Ask the customer to send the message again.",
    );
  return {
    requestId: o.turn.turnId,
    async run(spec: MutationSpec) {
      if (o.deadline.expired()) throw tooLate();
      // The journal key is also the BUSINESS idempotency key: the write itself (quote, booking
      // request) is unique per key, so an old worker finishing late cannot create a second object.
      const key = await sha256Hex(`${o.conversationId}|${spec.toolName}|${canonical(spec.key)}`);
      let claim;
      try {
        claim = await o.store.beginMutation(o.organizationId, o.turn, {
          key,
          toolName: spec.toolName,
          toolCallId: o.toolCallId(),
          pending: spec.pending as Json,
        });
      } catch (e) {
        o.onError("journal:begin", e);
        throw new ToolError(
          "TURN_LOST",
          "This message can no longer make changes (another message took over). Nothing was changed.",
        );
      }
      if (claim.outcome === "replay") {
        // Reconciling an already committed mutation is allowed after the deadline.
        const ref = mutationRefSchema.safeParse(claim.ref);
        if (ref.success) apply(ref.data);
        return { replayed: true, outcome: await replayedOutcome(claim.result, o.state, spec) };
      }
      if (claim.outcome === "in_progress") {
        throw new ToolError("IN_PROGRESS", "That change is already being made.");
      }
      // The pending record is written once by the FIRST attempt and never replaced: an earlier
      // attempt is resolved — and the mutation re-run — with its original input, never this
      // attempt's (possibly different) view of the conversation.
      const pending = (claim.pending ?? spec.pending) as Record<string, unknown>;
      if (claim.outcome === "unknown") {
        const recovered = await spec.recover(pending, key);
        if (recovered) {
          await commit(claim.mutationId, recovered);
          apply(recovered.ref);
          return { replayed: true, outcome: recovered.outcome };
        }
      }
      // A NEW business write never starts after the deadline (checked again after the claim and
      // any recovery lookup, immediately before the write).
      if (o.deadline.expired()) {
        await o.store
          .failMutation(o.organizationId, claim.mutationId, "TURN_DEADLINE")
          .catch((err: unknown) => {
            o.onError("journal:fail", err);
          });
        throw tooLate();
      }
      let committed: Committed;
      try {
        committed = await spec.perform(pending, key);
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
    const result = (await storableOutcome(c.outcome, o.sealer)) as unknown as Json;
    // Must be recorded even after the deadline; one retry, then the state (persisted when the turn
    // ends) and the business key still let the next attempt find it.
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
  const requestId = crypto.randomUUID();
  return {
    requestId,
    async run(spec) {
      const key = await sha256Hex(`direct|${requestId}|${spec.toolName}|${canonical(spec.key)}`);
      const c = await spec.perform(spec.pending, key);
      applyMutationRef(state, c.ref);
      return { replayed: false, outcome: c.outcome };
    },
  };
}
