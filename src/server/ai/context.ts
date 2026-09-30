import { z } from "zod";
import type { AssistantBlock } from "@/domain/assistant/blocks";
import type { PublicClient } from "@/server/db/public";
import type { PublicDeps, RequestMeta } from "@/server/public/deps";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";

/**
 * Per-turn context handed to every tool (ADR 0017 §2). The tenant and request meta come from the
 * server (host, IP, cookies) — tool arguments can never reach or replace them.
 */

const stagedItem = z.strictObject({
  variantId: z.uuid(),
  productSlug: z.string().max(120),
  productName: z.string().max(200),
  variantName: z.string().max(120).nullable(),
  quantity: z.int().min(1).max(1000),
});
export type StagedItem = z.infer<typeof stagedItem>;

/**
 * What a conversation remembers between turns (stored server-side, validated on load). Contact
 * details stay only as long as the conversation (they are needed to re-quote); the quote is held
 * by its token HASH — the raw token is never stored.
 */
export const assistantStateSchema = z.strictObject({
  /** As the customer gave them (already validated by contactInputSchema; re-validated on submit). */
  contact: z
    .strictObject({
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
      email: z.string().max(254).optional(),
      phone: z.string().max(40).optional(),
      emailOptIn: z.boolean().optional(),
      smsOptIn: z.boolean().optional(),
    })
    .optional(),
  event: z
    .strictObject({
      input: z.record(z.string(), z.unknown()),
      fulfillment: z.enum(["delivery", "pickup"]),
    })
    .optional(),
  items: z.array(stagedItem).max(10).default([]),
  quote: z
    .strictObject({
      tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
      quoteNumber: z.string().max(40),
      quoteId: z.uuid().optional(),
    })
    .optional(),
});
export type AssistantState = z.infer<typeof assistantStateSchema>;

export const emptyState = (): AssistantState => ({ items: [] });

/** Loads stored state; anything malformed starts over rather than being trusted. */
export function parseState(raw: unknown): AssistantState {
  const parsed = assistantStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyState();
}

export interface ToolContext {
  tenant: ResolvedTenant;
  meta: RequestMeta & { actor: "ai" };
  state: AssistantState;
  deps: PublicDeps;
  /** Anonymous catalog client (tests pass one bound to their PostgREST). */
  db?: PublicClient;
  now: () => Date;
}

// UI blocks are shared with the chat component (types only).
export type { AssistantBlock, ProductCardData } from "@/domain/assistant/blocks";

export type ToolStatus =
  "ok" | "manual_review" | "rejected_validation" | "rejected_policy" | "error";

/** What a tool returns: JSON for the model, cards for the customer. */
export interface ToolOutcome {
  status: ToolStatus;
  result: Record<string, unknown>;
  blocks: AssistantBlock[];
  errorCode?: string;
}

/** A refusal the model should explain to the customer (not a system failure). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: "rejected_validation" | "rejected_policy" = "rejected_policy",
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }
}
