import type { PostgrestError } from "@supabase/supabase-js";
import { type AiConversationStore, GatewayError } from "@/server/trusted/gateway";
import { rpc, SYSTEM } from "./availability";

/**
 * The production AiConversationStore contract with the same SQL functions, executed as
 * `service_role` (what supabase-js does with the service key).
 */
const asPostgrest = (e: unknown): PostgrestError => {
  const err = e as { code?: string; message?: string; detail?: string };
  return {
    name: "PostgrestError",
    code: err.code ?? "",
    message: err.message ?? "",
    details: err.detail ?? "",
    hint: "",
  } as PostgrestError;
};

async function call<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  try {
    return await rpc<T>(SYSTEM, sql, params);
  } catch (e) {
    throw new GatewayError(asPostgrest(e));
  }
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

export function pgAiStore(): AiConversationStore {
  return {
    async beginTurn(org, hash, key, lease, correlationId) {
      const [r] = await call<{
        outcome: string;
        turn_id: string | null;
        attempt: number | null;
        conversation_id: string;
        state: unknown;
        state_version: number;
        message_count: number;
        applied_mutation_seq: string | number;
        response: unknown;
      }>("select * from public.ai_turn_begin($1, $2, $3, $4, $5)", [
        org,
        hash,
        key,
        lease,
        correlationId,
      ]);
      return {
        outcome: r!.outcome as "started",
        turnId: r!.turn_id,
        attempt: r!.attempt,
        conversationId: r!.conversation_id,
        state: r!.state,
        stateVersion: r!.state_version,
        messageCount: r!.message_count,
        appliedSeq: Number(r!.applied_mutation_seq),
        response: r!.response,
      };
    },
    async history(org, id, limit) {
      const rows = await call<{
        seq: number;
        role: "user" | "assistant" | "tool";
        content: string | null;
        structured: unknown;
      }>("select * from public.ai_conversation_history($1, $2, $3)", [org, id, limit]);
      return rows.map((r) => ({ ...r, structured: r.structured as never }));
    },
    async mutationsSince(org, id, after) {
      const rows = await call<{ seq: string; tool_name: string; ref: unknown }>(
        "select * from public.ai_conversation_mutations($1, $2, $3)",
        [org, id, after],
      );
      return rows.map((r) => ({ seq: Number(r.seq), toolName: r.tool_name, ref: r.ref }));
    },
    async finishTurn(org, t, u) {
      const [r] = await call<{ v: number }>(
        "select public.ai_turn_finish($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as v",
        [
          org,
          t.turnId,
          t.attempt,
          json(u.state),
          u.quoteId,
          json(u.messages),
          u.toolCalls,
          u.tokens,
          u.promptVersion,
          u.appliedSeq,
          json(u.response),
        ],
      );
      return r!.v;
    },
    async failTurn(org, t, f) {
      await call("select public.ai_turn_fail($1, $2, $3, $4, $5, $6, $7)", [
        org,
        t.turnId,
        t.attempt,
        f.errorCode,
        json(f.state),
        f.quoteId,
        f.appliedSeq,
      ]);
    },
    async beginMutation(org, t, m) {
      const [r] = await call<{
        outcome: string;
        mutation_id: string;
        pending: unknown;
        ref: unknown;
        result: unknown;
      }>("select * from public.ai_mutation_begin($1, $2, $3, $4, $5, $6, $7)", [
        org,
        t.turnId,
        t.attempt,
        m.key,
        m.toolName,
        m.toolCallId,
        json(m.pending),
      ]);
      return {
        outcome: r!.outcome as "proceed",
        mutationId: r!.mutation_id,
        pending: r!.pending,
        ref: r!.ref,
        result: r!.result,
      };
    },
    async commitMutation(org, id, ref, result) {
      const [r] = await call<{ s: string }>(
        "select public.ai_mutation_commit($1, $2, $3, $4) as s",
        [org, id, json(ref), json(result)],
      );
      return Number(r!.s);
    },
    async failMutation(org, id, code) {
      await call("select public.ai_mutation_fail($1, $2, $3)", [org, id, code]);
    },
    async recordAction(org, a) {
      await call("select public.ai_action_record($1, $2, $3, $4, $5, $6, $7, $8)", [
        org,
        a.conversationId,
        a.toolName,
        a.status,
        a.errorCode,
        a.durationMs,
        a.correlationId,
        a.model,
      ]);
    },
  };
}
