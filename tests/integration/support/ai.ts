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

export function pgAiStore(): AiConversationStore {
  return {
    async open(org, hash) {
      const [r] = await call<{
        id: string;
        state: unknown;
        state_version: number;
        message_count: number;
      }>("select * from public.ai_conversation_open($1, $2)", [org, hash]);
      return {
        id: r!.id,
        state: r!.state,
        stateVersion: r!.state_version,
        messageCount: r!.message_count,
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
    async append(org, id, expected, u) {
      const [r] = await call<{ v: number }>(
        "select public.ai_conversation_append($1, $2, $3, $4, $5, $6, $7, $8, $9) as v",
        [
          org,
          id,
          expected,
          JSON.stringify(u.state),
          u.quoteId,
          JSON.stringify(u.messages),
          u.toolCalls,
          u.tokens,
          u.promptVersion,
        ],
      );
      return r!.v;
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
