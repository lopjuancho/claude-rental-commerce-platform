import "server-only";
import { humanize } from "@/domain/storefront/catalog";
import type { PublicClient } from "@/server/db/public";
import type { PublicDeps, RequestMeta } from "@/server/public/deps";
import { getPublicQuote } from "@/server/public/quotes";
import { loadProductBySlug, loadShell } from "@/server/public/storefront";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import type { AiConversationStore, AiStoredMessage, AiTurnUpdate } from "@/server/trusted/gateway";
import { AI_LIMITS, PROMPT_VERSION } from "./config";
import { type AssistantBlock, type AssistantState, parseState, type ToolContext } from "./context";
import { checkGrounding, cleanReply, redactArguments, SAFE_FALLBACK, systemPrompt } from "./policy";
import type { LlmMessage, LlmProvider, LlmToolSpec } from "./provider";
import { TOOL_DESCRIPTIONS, TOOL_NAMES, toolJsonSchema } from "./schemas";
import { hashSessionToken } from "./session";
import { logAssistantError, recordToolAction } from "./telemetry";
import { executeTool } from "./tools";

/**
 * One assistant turn (ADR 0017): load the tenant-scoped conversation, let the model call the fixed
 * tool set within budgets, check the reply against tool results, persist, and return text plus
 * server-built cards. The model never receives or supplies an organization id or a quote token.
 */

export type PageContext =
  | { kind: "product"; slug: string }
  | { kind: "category"; slug: string }
  | { kind: "quote"; token: string }
  | { kind: "other" };

export interface TurnInput {
  tenant: ResolvedTenant;
  sessionToken: string;
  message: string;
  page?: PageContext | undefined;
  meta: RequestMeta;
  correlationId: string | null;
}

export interface TurnDeps {
  provider: LlmProvider;
  store: AiConversationStore;
  publicDeps: PublicDeps;
  maxOutputTokens: number;
  db?: PublicClient;
  now?: () => Date;
  execute?: typeof executeTool;
  limits?: Partial<typeof AI_LIMITS>;
}

export interface TurnResult {
  status: "ok" | "error";
  reply: string;
  blocks: AssistantBlock[];
  errorCode?: string;
}

export const TOOL_SPECS: LlmToolSpec[] = TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  parameters: toolJsonSchema(name),
}));

const UNAVAILABLE =
  "The assistant is unavailable right now. You can keep browsing or try again in a moment.";

function today(timeZone: string, now: Date): string {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now);
  return `${date} (${weekday})`;
}

/** Stored messages → provider messages, starting at a user message and within the char budget. */
export function historyToMessages(rows: AiStoredMessage[], maxChars: number): LlmMessage[] {
  const out: LlmMessage[] = [];
  let chars = 0;
  for (const row of [...rows].reverse()) {
    chars += (row.content ?? "").length + JSON.stringify(row.structured ?? "").length;
    if (chars > maxChars) break;
    out.unshift(toMessage(row));
  }
  const firstUser = out.findIndex((m) => m.role === "user");
  return firstUser === -1 ? [] : out.slice(firstUser);
}

function toMessage(row: AiStoredMessage): LlmMessage {
  const s = (row.structured ?? {}) as Record<string, unknown>;
  if (row.role === "user") return { role: "user", content: row.content ?? "" };
  if (row.role === "tool") {
    return {
      role: "tool",
      toolCallId: typeof s.toolCallId === "string" ? s.toolCallId : "",
      name: typeof s.name === "string" ? s.name : "",
      content: row.content ?? "",
    };
  }
  const calls = Array.isArray(s.toolCalls)
    ? (s.toolCalls as { id: string; name: string; arguments: string }[])
    : [];
  return { role: "assistant", content: row.content, ...(calls.length ? { toolCalls: calls } : {}) };
}

/** Page context resolved on the server; only names and statuses reach the model. */
async function pageNote(
  input: TurnInput,
  state: AssistantState,
  deps: TurnDeps,
): Promise<string | null> {
  const page = input.page;
  if (!page || page.kind === "other") return null;
  if (page.kind === "product") {
    const p = await loadProductBySlug(input.tenant, page.slug, deps.db);
    return p ? `The customer is on the page for "${p.name}" (slug: ${p.slug}).` : null;
  }
  if (page.kind === "category") {
    const shell = await loadShell(input.tenant, deps.db);
    const c = shell.categories.find((x) => x.slug === page.slug);
    return c ? `The customer is browsing the "${c.name}" category.` : null;
  }
  // Quote page: the token proves access; it never enters the prompt.
  const view = await getPublicQuote(input.tenant, page.token, deps.publicDeps);
  if (!view) return null;
  if (!state.quote) {
    state.quote = { tokenHash: await hashQuoteToken(page.token), quoteNumber: view.quoteNumber };
  }
  return `The customer is viewing their quote ${view.quoteNumber} (status: ${humanize(view.status)}; items: ${view.items
    .map((i) => `${String(i.quantity)} × ${i.name}`)
    .join(", ")}). Use request_booking only if they ask.`;
}

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const limits = { ...AI_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const execute = deps.execute ?? executeTool;
  const org = input.tenant.organizationId;
  const message = input.message.trim();
  if (!message || message.length > limits.maxMessageChars) {
    return {
      status: "error",
      errorCode: "INVALID_MESSAGE",
      reply: `Please send a message of up to ${String(limits.maxMessageChars)} characters.`,
      blocks: [],
    };
  }

  const conversation = await deps.store.open(org, await hashSessionToken(input.sessionToken));
  if (conversation.messageCount >= limits.maxConversationMessages) {
    return {
      status: "error",
      errorCode: "CONVERSATION_FULL",
      reply: "This conversation is full. Start a new chat to continue.",
      blocks: [],
    };
  }
  const state = parseState(conversation.state);
  const history = historyToMessages(
    await deps.store.history(org, conversation.id, limits.maxHistoryMessages),
    limits.maxHistoryChars,
  );

  const ctx: ToolContext = {
    tenant: input.tenant,
    meta: {
      ...input.meta,
      actor: "ai",
      ...(input.correlationId ? { requestId: input.correlationId } : {}),
    },
    state,
    deps: deps.publicDeps,
    ...(deps.db ? { db: deps.db } : {}),
    now,
  };

  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, limits.turnTimeoutMs);
  const blocks: AssistantBlock[] = [];
  const stored: AiTurnUpdate["messages"] = [{ role: "user", content: message }];
  const turnToolResults: string[] = [];
  let tokens = 0;
  let toolCalls = 0;
  let reply: string | null = null;

  try {
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: systemPrompt({
          businessName: input.tenant.name,
          timeZone: input.tenant.timezone,
          today: today(input.tenant.timezone, now()),
          pageNote: await pageNote(input, state, deps).catch(() => null),
        }),
      },
      ...history,
      { role: "user", content: message },
    ];

    for (let step = 0; step < limits.maxModelSteps; step++) {
      const res = await deps.provider.complete({
        messages,
        tools: TOOL_SPECS,
        maxOutputTokens: deps.maxOutputTokens,
        signal: abort.signal,
      });
      tokens += res.usage.inputTokens + res.usage.outputTokens;
      if (res.toolCalls.length === 0) {
        reply = res.text ?? "";
        break;
      }
      const calls = res.toolCalls.map((c) => ({
        ...c,
        id: c.id.slice(0, 64) || `call_${String(toolCalls)}`,
      }));
      messages.push({ role: "assistant", content: res.text, toolCalls: calls });
      stored.push({
        role: "assistant",
        content: res.text,
        structured: {
          toolCalls: calls.map((c) => ({
            id: c.id,
            name: c.name,
            arguments: redactArguments(c.name, c.arguments),
          })),
        },
      });
      for (const c of calls) {
        const started = Date.now();
        const outcome =
          toolCalls >= limits.maxToolCallsPerTurn
            ? {
                status: "rejected_policy" as const,
                errorCode: "TOOL_BUDGET",
                result: {
                  error: "TOOL_BUDGET",
                  message: "Too many steps for one message. Answer with what you have.",
                },
                blocks: [],
              }
            : await execute(c.name, c.arguments, ctx, (e) => {
                logAssistantError(input.correlationId, `tool:${c.name}`, e);
              });
        toolCalls++;
        const content = JSON.stringify(outcome.result).slice(0, 8000);
        turnToolResults.push(content);
        blocks.push(...outcome.blocks);
        messages.push({ role: "tool", toolCallId: c.id, name: c.name, content });
        stored.push({
          role: "tool",
          content,
          structured: { toolCallId: c.id, name: c.name, status: outcome.status },
        });
        await recordToolAction(deps.store, org, {
          conversationId: conversation.id,
          toolName: c.name,
          status: outcome.status,
          errorCode: outcome.errorCode,
          durationMs: Date.now() - started,
          correlationId: input.correlationId,
          model: deps.provider.model,
        });
      }
    }
  } catch (e) {
    logAssistantError(input.correlationId, "provider", e);
    // Nothing is persisted for a failed turn (the customer can simply retry). Mutations a tool
    // already made are real and audited by their services; their cards are still returned.
    return { status: "error", errorCode: "AI_UNAVAILABLE", reply: UNAVAILABLE, blocks };
  } finally {
    clearTimeout(timer);
  }

  let text = cleanReply(reply ?? "");
  if (!text) text = "I couldn't finish that just now. Please try again or rephrase.";
  const evidence = [
    ...history.flatMap((m) => (m.role === "tool" ? [m.content] : [])),
    ...turnToolResults,
  ];
  const grounding = checkGrounding(text, evidence);
  if (!grounding.ok) {
    await recordToolAction(deps.store, org, {
      conversationId: conversation.id,
      toolName: "reply_guardrail",
      status: "guardrail_violation",
      errorCode: grounding.violations[0]?.slice(0, 60),
      durationMs: 0,
      correlationId: input.correlationId,
      model: deps.provider.model,
    });
    text = SAFE_FALLBACK;
  }
  stored.push({ role: "assistant", content: text });

  try {
    await deps.store.append(org, conversation.id, conversation.stateVersion, {
      state: state as unknown as AiTurnUpdate["state"],
      quoteId: state.quote?.quoteId ?? null,
      messages: stored,
      toolCalls,
      tokens,
      promptVersion: PROMPT_VERSION,
    });
  } catch (e) {
    logAssistantError(input.correlationId, "persist", e);
    return {
      status: "error",
      errorCode: "CONFLICT",
      reply: "Another message was being handled at the same time. Please send yours again.",
      blocks,
    };
  }
  return { status: "ok", reply: text, blocks };
}
