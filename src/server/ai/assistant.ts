import "server-only";
import type { Evidence } from "@/domain/assistant/evidence";
import { formatCents } from "@/domain/money";
import { humanize } from "@/domain/storefront/catalog";
import type { PublicClient } from "@/server/db/public";
import type { PublicDeps, RequestMeta } from "@/server/public/deps";
import { getPublicQuote } from "@/server/public/quotes";
import { loadProductBySlug, loadShell } from "@/server/public/storefront";
import { hashQuoteToken } from "@/server/quotes/token";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import type {
  AiConversationStore,
  AiStoredMessage,
  AiTurnFinish,
  AiTurnRef,
} from "@/server/trusted/gateway";
import type { Json } from "@/types/database";
import { AI_LIMITS, PROMPT_VERSION } from "./config";
import {
  applyMutationRef,
  type AssistantBlock,
  type AssistantState,
  type MutationRef,
  mutationRefSchema,
  parseState,
  recordEvidence,
  type ToolContext,
  type ToolStatus,
} from "./context";
import { Deadline, DeadlineError } from "./deadline";
import { durableJournal, openBlock, sealBlock } from "./journal";
import { type Sealer, sessionSealer } from "./seal";
import {
  checkGrounding,
  cleanReply,
  factSentences,
  MANUAL_REVIEW_TEXT,
  redactArguments,
  SAFE_FALLBACK,
  systemPrompt,
} from "./policy";
import type { LlmMessage, LlmProvider, LlmToolSpec } from "./provider";
import { strictToolJsonSchema, TOOL_DESCRIPTIONS, TOOL_NAMES } from "./schemas";
import { hashSessionToken } from "./session";
import { logAssistantError, recordToolAction } from "./telemetry";
import { adoptPageQuote, executeTool } from "./tools";

/**
 * One assistant turn (ADR 0017): claim the conversation, re-apply committed mutations, let the
 * model call the fixed tool set within budgets and ONE absolute deadline, check the reply against
 * typed evidence, persist, and return text plus server-built cards. The model never receives or
 * supplies an organization id or a quote token.
 *
 * Durability (§11): the turn owns the conversation (lease) from the first step; business mutations
 * are journaled and committed as soon as they happen; a failed turn keeps its state (with those
 * references) but not its messages, so the same request can be retried without repeating anything.
 */

export type PageContext =
  | { kind: "product"; slug: string }
  | { kind: "category"; slug: string }
  | { kind: "quote"; token: string }
  | { kind: "other" };

export interface TurnInput {
  tenant: ResolvedTenant;
  sessionToken: string;
  /** Client id of this message; a retry of the same message reuses it. */
  requestKey?: string | undefined;
  message: string;
  page?: PageContext | undefined;
  meta: RequestMeta;
  correlationId: string | null;
  /** When the request arrived (the deadline counts from here). */
  startedAt?: number;
}

export interface TurnDeps {
  provider: LlmProvider;
  store: AiConversationStore;
  publicDeps: PublicDeps;
  maxOutputTokens: number;
  db?: PublicClient;
  now?: () => Date;
  execute?: typeof executeTool;
  limits?: Partial<Record<keyof typeof AI_LIMITS, number>>;
}

export interface TurnResult {
  status: "ok" | "error";
  reply: string;
  blocks: AssistantBlock[];
  errorCode?: string;
  /** The stored reply of an already-completed request (duplicate or retried POST). */
  replayed?: boolean;
}

export const TOOL_SPECS: LlmToolSpec[] = TOOL_NAMES.map((name) => ({
  name,
  description: TOOL_DESCRIPTIONS[name],
  parameters: strictToolJsonSchema(name),
  strict: true,
}));

const UNAVAILABLE =
  "The assistant is unavailable right now. You can keep browsing or try again in a moment.";
const TIMED_OUT = "That took longer than expected, so I stopped.";
/** Persistence and telemetry may run this long past the deadline (never business mutations). */
const PERSIST_GRACE_MS = 5_000;
/** The lease outlives the deadline, so a stuck turn is taken over only after it cannot act. */
const LEASE_GRACE_SECONDS = 30;

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

/**
 * Page context resolved on the server; only names and statuses reach the model. A quote page's
 * token is validated for this tenant: with no active quote it becomes the active one; a DIFFERENT
 * quote than the active one is never selected silently (request_booking asks which one).
 */
async function pageNote(
  input: TurnInput,
  ctx: ToolContext,
  deps: TurnDeps,
): Promise<string | null> {
  const page = input.page;
  if (!page || page.kind === "other") return null;
  if (page.kind === "product") {
    const p = await loadProductBySlug(input.tenant, page.slug, deps.db);
    if (!p) return null;
    ctx.state.knownProducts = [...ctx.state.knownProducts.filter((n) => n !== p.name), p.name];
    return `The customer is on the page for "${p.name}" (slug: ${p.slug}).`;
  }
  if (page.kind === "category") {
    const shell = await loadShell(input.tenant, deps.db);
    const c = shell.categories.find((x) => x.slug === page.slug);
    return c ? `The customer is browsing the "${c.name}" category.` : null;
  }
  // Quote page: the token proves access; it never enters the prompt.
  const view = await getPublicQuote(input.tenant, page.token, deps.publicDeps);
  if (!view) return null;
  const viewed = { tokenHash: await hashQuoteToken(page.token), quoteNumber: view.quoteNumber };
  const summary = `quote ${view.quoteNumber} (status: ${humanize(view.status)}; items: ${view.items
    .map((i) => `${String(i.quantity)} × ${i.name}`)
    .join(", ")})`;
  if (!ctx.state.quote) {
    await adoptPageQuote(ctx.state, viewed);
    return `The customer is viewing their ${summary}; it is this chat's quote now. Use request_booking only if they ask.`;
  }
  if (ctx.state.quote.tokenHash === viewed.tokenHash) {
    return `The customer is viewing this chat's ${summary}. Use request_booking only if they ask.`;
  }
  ctx.pageQuote = viewed;
  return `The customer is viewing ${summary}, but this chat's quote is ${ctx.state.quote.quoteNumber}. If they ask to book, first ask which quote they mean.`;
}

function fallbackReply(evidence: Evidence[], currency: string): string {
  const facts = factSentences(evidence, (c) => formatCents(c, currency));
  return facts.length
    ? `I want to make sure I only share confirmed details. ${facts.join(" ")}`
    : SAFE_FALLBACK;
}

/** What is stored for replay: quote links only sealed to this session (never in clear). */
async function storable(result: TurnResult, sealer: Sealer): Promise<Json> {
  return {
    status: result.status,
    reply: result.reply,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    blocks: await Promise.all(result.blocks.map((b) => sealBlock(b, sealer))),
  } as unknown as Json;
}

async function replayOf(stored: unknown, sealer: Sealer): Promise<TurnResult> {
  const r = stored as Partial<TurnResult> | null;
  if (!r || typeof r.reply !== "string") {
    return { status: "error", errorCode: "REPLAY", reply: UNAVAILABLE, blocks: [], replayed: true };
  }
  return {
    status: r.status === "ok" ? "ok" : "error",
    reply: r.reply,
    // A lost response is replayed with a working quote link (unsealed for this same session).
    blocks: Array.isArray(r.blocks)
      ? await Promise.all(r.blocks.map((b) => openBlock(b, sealer)))
      : [],
    ...(r.errorCode ? { errorCode: r.errorCode } : {}),
    replayed: true,
  };
}

const randomKey = () => crypto.randomUUID().replace(/-/g, "");

export async function runTurn(input: TurnInput, deps: TurnDeps): Promise<TurnResult> {
  const limits = { ...AI_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const deadline = new Deadline((input.startedAt ?? Date.now()) + limits.turnTimeoutMs);
  try {
    return await turn(input, deps, limits, now, deadline);
  } finally {
    deadline.dispose();
  }
}

async function turn(
  input: TurnInput,
  deps: TurnDeps,
  limits: Record<keyof typeof AI_LIMITS, number>,
  now: () => Date,
  deadline: Deadline,
): Promise<TurnResult> {
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
  const grace = <T>(p: Promise<T>, what: string) => deadline.race(p, what, PERSIST_GRACE_MS);

  // 1. Claim the conversation (one writer at a time; duplicates replay or wait).
  const claim = await deadline.race(
    deps.store.beginTurn(
      org,
      await hashSessionToken(input.sessionToken),
      input.requestKey ?? randomKey(),
      Math.ceil(limits.turnTimeoutMs / 1000) + LEASE_GRACE_SECONDS,
      input.correlationId,
    ),
    "begin",
  );
  const sealer = sessionSealer(input.sessionToken, org);
  if (claim.outcome === "replay") return replayOf(claim.response, sealer);
  if (claim.outcome === "in_progress" || claim.outcome === "busy" || !claim.turnId) {
    return {
      status: "error",
      errorCode: claim.outcome === "in_progress" ? "IN_PROGRESS" : "BUSY",
      reply:
        claim.outcome === "in_progress"
          ? "I'm still working on that message. Please wait a moment."
          : "Another message in this chat is still being handled. Please wait a moment and send yours again.",
      blocks: [],
    };
  }
  const turnRef: AiTurnRef = { turnId: claim.turnId, attempt: claim.attempt ?? 1 };
  const conversationId = claim.conversationId;
  const state: AssistantState = parseState(claim.state);
  let appliedSeq = claim.appliedSeq;
  // What a failed turn keeps: the state it started from plus every mutation reference it applied
  // (committed, recovered or replayed) — never its uncommitted staging, so retrying the same
  // message cannot apply a change twice.
  let baseState = JSON.stringify(state);
  const appliedRefs: MutationRef[] = [];
  const stateAfterFailure = () => {
    const kept = parseState(JSON.parse(baseState));
    for (const ref of appliedRefs) applyMutationRef(kept, ref);
    return kept;
  };

  const fail = async (errorCode: string) => {
    const kept = stateAfterFailure();
    try {
      await grace(
        deps.store.failTurn(org, turnRef, {
          errorCode,
          state: kept as unknown as Json,
          quoteId: kept.quote?.quoteId ?? null,
          appliedSeq,
        }),
        "fail",
      );
    } catch (e) {
      logAssistantError(input.correlationId, "persist:fail", e);
    }
  };

  if (claim.messageCount >= limits.maxConversationMessages) {
    await fail("CONVERSATION_FULL");
    return {
      status: "error",
      errorCode: "CONVERSATION_FULL",
      reply: "This conversation is full. Start a new chat to continue.",
      blocks: [],
    };
  }

  const blocks: AssistantBlock[] = [];
  const turnEvidence: Evidence[] = [];
  const stored: AiTurnFinish["messages"] = [{ role: "user", content: message }];
  let tokens = 0;
  let toolCalls = 0;
  let reply: string | null = null;
  let currentCallId = "";

  const record = (
    toolName: string,
    status: ToolStatus | "guardrail_violation",
    errorCode: string | undefined,
    ms: number,
  ) =>
    grace(
      recordToolAction(deps.store, org, {
        conversationId,
        toolName,
        status,
        errorCode,
        durationMs: ms,
        correlationId: input.correlationId,
        model: deps.provider.model,
      }),
      "telemetry",
    ).catch(() => undefined);

  try {
    // 2. Committed mutations are re-applied, whatever happened to the turn that made them.
    const committedRefs = await deadline.race(
      deps.store.mutationsSince(org, conversationId, appliedSeq),
      "mutations",
    );
    for (const m of committedRefs) {
      const ref = mutationRefSchema.safeParse(m.ref);
      if (ref.success) applyMutationRef(state, ref.data);
      appliedSeq = Math.max(appliedSeq, m.seq);
    }
    baseState = JSON.stringify(state);
    const history = historyToMessages(
      await deadline.race(
        deps.store.history(org, conversationId, limits.maxHistoryMessages),
        "history",
      ),
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
      deadline,
      sealer,
      journal: durableJournal({
        sealer,
        store: deps.store,
        organizationId: org,
        conversationId,
        turn: turnRef,
        state,
        deadline,
        toolCallId: () => currentCallId,
        onApplied: (ref) => {
          appliedRefs.push(ref);
        },
        onCommitted: (seq) => {
          appliedSeq = Math.max(appliedSeq, seq);
        },
        onError: (where, e) => {
          logAssistantError(input.correlationId, where, e);
        },
      }),
    };

    const note = await deadline.race(pageNote(input, ctx, deps), "page").catch((e: unknown) => {
      if (e instanceof DeadlineError) throw e;
      return null;
    });
    const messages: LlmMessage[] = [
      {
        role: "system",
        content: systemPrompt({
          businessName: input.tenant.name,
          timeZone: input.tenant.timezone,
          today: today(input.tenant.timezone, now()),
          pageNote: note,
        }),
      },
      ...history,
      { role: "user", content: message },
    ];

    // 3. The model loop: every step checks the one deadline.
    for (let step = 0; step < limits.maxModelSteps; step++) {
      deadline.assertOpen("model");
      const res = await deadline.race(
        deps.provider.complete({
          messages,
          tools: TOOL_SPECS,
          maxOutputTokens: deps.maxOutputTokens,
          signal: deadline.signal,
        }),
        "model",
      );
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
        currentCallId = c.id;
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
        blocks.push(...outcome.blocks);
        const evidence = "evidence" in outcome ? (outcome.evidence ?? []) : [];
        turnEvidence.push(...evidence);
        recordEvidence(state, evidence);
        messages.push({ role: "tool", toolCallId: c.id, name: c.name, content });
        stored.push({
          role: "tool",
          content,
          structured: { toolCallId: c.id, name: c.name, status: outcome.status },
        });
        await record(c.name, outcome.status, outcome.errorCode, Date.now() - started);
      }
    }
  } catch (e) {
    // Provider failure or the deadline: the turn ends without a model reply. Its state — with the
    // references of anything it committed — is kept; its messages are not, so retrying the same
    // message re-runs it and the journal prevents any repeated mutation.
    const timedOut = e instanceof DeadlineError || deadline.expired();
    logAssistantError(input.correlationId, timedOut ? "deadline" : "provider", e);
    await fail(timedOut ? "TURN_TIMEOUT" : "AI_UNAVAILABLE");
    return {
      status: "error",
      errorCode: timedOut ? "TURN_TIMEOUT" : "AI_UNAVAILABLE",
      reply:
        appliedRefs.length > 0 || turnEvidence.length > 0
          ? `${timedOut ? TIMED_OUT : UNAVAILABLE} ${factSentences(turnEvidence, (c) => formatCents(c, input.tenant.currency)).join(" ")}`.trim()
          : timedOut
            ? `${TIMED_OUT} Please try again.`
            : UNAVAILABLE,
      blocks,
    };
  }

  // 4. Grounding: transactional claims in the prose need current typed evidence.
  let text = cleanReply(reply ?? "");
  if (!text) text = "I couldn't finish that just now. Please try again or rephrase.";
  const grounding = checkGrounding({
    reply: text,
    evidence: state.evidence,
    now: now(),
    knownProducts: state.knownProducts,
    businessName: input.tenant.name,
    currency: input.tenant.currency,
    exemptSentences: [MANUAL_REVIEW_TEXT],
  });
  if (!grounding.ok) {
    // Stable codes only: the offending prose (possibly names, emails, addresses) is never logged.
    logAssistantError(input.correlationId, "reply_guardrail", {
      name: "GuardrailViolation",
      code: grounding.violations[0],
    });
    await record("reply_guardrail", "guardrail_violation", grounding.violations[0], 0);
    text = fallbackReply(turnEvidence, input.tenant.currency);
  }
  stored.push({ role: "assistant", content: text });
  const result: TurnResult = { status: "ok", reply: text, blocks };

  // 5. Persist and release the conversation.
  try {
    await grace(
      deps.store.finishTurn(org, turnRef, {
        state: state as unknown as Json,
        quoteId: state.quote?.quoteId ?? null,
        messages: stored,
        toolCalls,
        tokens,
        promptVersion: PROMPT_VERSION,
        appliedSeq,
        response: await storable(result, sealer),
      }),
      "finish",
    );
  } catch (e) {
    // The conversation could not be saved: release it keeping only what is durable (the state it
    // started from + committed mutations) — and do NOT tell the customer that anything staged in
    // this turn (contact, event, items) was saved. Committed quotes/bookings stay true and shown.
    logAssistantError(input.correlationId, "persist:finish", e);
    await fail("PERSIST_FAILED");
    const committedFacts = appliedRefs.length
      ? factSentences(
          turnEvidence.filter((x) => x.kind === "quote" || x.kind === "booking"),
          (c) => formatCents(c, input.tenant.currency),
        )
      : [];
    return {
      status: "error",
      errorCode: "PERSIST_FAILED",
      reply: [
        "I couldn't save that part of our conversation. Please send your last message again.",
        ...committedFacts,
      ].join(" "),
      blocks: blocks.filter((b) => b.type === "quote" || b.type === "booking"),
    };
  }
  return result;
}
