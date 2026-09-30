import type { AiConversationStore } from "@/server/trusted/gateway";
import type { ToolStatus } from "./context";

/**
 * Troubleshooting telemetry (ADR 0017 §10): tenant, conversation, tool, status, error code,
 * latency, model and correlation id. Never arguments, results, customer data or secrets.
 * Telemetry failures never break a customer's turn.
 */
export async function recordToolAction(
  store: AiConversationStore,
  organizationId: string,
  entry: {
    conversationId: string;
    toolName: string;
    status: ToolStatus | "guardrail_violation";
    errorCode?: string | undefined;
    durationMs: number;
    correlationId: string | null;
    model: string;
  },
): Promise<void> {
  await store
    .recordAction(organizationId, {
      conversationId: entry.conversationId,
      toolName: /^[a-z_]{1,40}$/.test(entry.toolName) ? entry.toolName : "unknown_tool",
      status: entry.status,
      errorCode: entry.errorCode?.slice(0, 60) ?? null,
      durationMs: Math.max(0, Math.round(entry.durationMs)),
      correlationId: entry.correlationId,
      model: entry.model.slice(0, 80),
    })
    .catch((e: unknown) => {
      logAssistantError(entry.correlationId, "telemetry", e);
    });
}

/**
 * Server log for failures: correlation id, where, and the error's name/code only — no message
 * bodies (they may contain customer text), no stack in the response, never secrets.
 */
export function logAssistantError(correlationId: string | null, where: string, e: unknown): void {
  const err = e as { name?: string; code?: string; httpStatus?: number };
  console.error(
    JSON.stringify({
      event: "assistant_error",
      correlationId,
      where,
      name: err.name ?? typeof e,
      code: err.code ?? null,
      httpStatus: err.httpStatus ?? null,
    }),
  );
}
