import { z } from "zod";
import type { AssistantBlock } from "@/domain/assistant/blocks";
import { addEvidence, type Evidence, evidenceSchema } from "@/domain/assistant/evidence";
import type { PublicClient } from "@/server/db/public";
import type { PublicDeps, RequestMeta } from "@/server/public/deps";
import type { ResolvedTenant } from "@/server/tenancy/resolve-tenant";
import type { Deadline } from "./deadline";
import type { Sealer } from "./seal";

/**
 * Per-turn context handed to every tool (ADR 0017 §2). The tenant and request meta come from the
 * server (host, IP, cookies) — tool arguments can never reach or replace them.
 */

export const MAX_STAGED_ITEMS = 10;
export const MAX_ITEM_QUANTITY = 1000;

const stagedItem = z.strictObject({
  variantId: z.uuid(),
  productSlug: z.string().max(120),
  productName: z.string().max(200),
  variantName: z.string().max(120).nullable(),
  quantity: z.int().min(1).max(MAX_ITEM_QUANTITY),
});
export type StagedItem = z.infer<typeof stagedItem>;

const contactSchema = z.strictObject({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  email: z.string().max(254).optional(),
  phone: z.string().max(40).optional(),
  emailOptIn: z.boolean().optional(),
  smsOptIn: z.boolean().optional(),
});
const eventSchema = z.strictObject({
  input: z.record(z.string(), z.unknown()),
  fulfillment: z.enum(["delivery", "pickup"]),
});
const hash = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What a quote was built from (hashes of the staged contact, event and items). The quote is the
 * CURRENT quote only while the staged details still hash the same (see quoteRelation).
 * `null` = not part of this chat's staging (a quote adopted from the quote page).
 */
export const quoteBasisSchema = z.strictObject({
  contact: hash.nullable(),
  event: hash.nullable(),
  items: hash.nullable(),
});
export type QuoteBasis = z.infer<typeof quoteBasisSchema>;

const activeQuoteSchema = z.strictObject({
  tokenHash: hash,
  quoteNumber: z.string().max(40),
  quoteId: z.uuid().optional(),
  origin: z.enum(["assistant", "page"]),
  basis: quoteBasisSchema,
  /** False when a recovered quote's database contents did not match the recorded input. */
  verified: z.boolean().default(true),
  /**
   * The quote's link token SEALED to this browser session (seal.ts) — never in clear — so the
   * existing quote can be shown again with its link. Absent when this chat never had the token.
   */
  sealedLink: z.string().max(400).optional(),
});
export type ActiveQuote = z.infer<typeof activeQuoteSchema>;

/**
 * What a conversation remembers between turns (stored server-side, validated on load). Contact
 * details stay only as long as the conversation (they are needed to re-quote); the quote is held
 * by its token HASH — the raw token is never stored.
 */
export const assistantStateSchema = z.strictObject({
  /** As the customer gave them (already validated by contactInputSchema; re-validated on submit). */
  contact: contactSchema.optional(),
  event: eventSchema.optional(),
  items: z.array(stagedItem).max(MAX_STAGED_ITEMS).default([]),
  quote: activeQuoteSchema.optional(),
  /** Typed facts from tool results (grounding), oldest first. */
  evidence: z.array(evidenceSchema).max(40).default([]),
  /** Product names seen in tool results (recognising subjects in replies). */
  knownProducts: z.array(z.string().max(200)).max(60).default([]),
});
export type AssistantState = z.infer<typeof assistantStateSchema>;

export const emptyState = (): AssistantState => ({ items: [], evidence: [], knownProducts: [] });

/** Loads stored state; anything malformed starts over rather than being trusted. */
export function parseState(raw: unknown): AssistantState {
  const parsed = assistantStateSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyState();
}

export function rememberProducts(state: AssistantState, names: string[]) {
  const set = [...state.knownProducts.filter((n) => !names.includes(n)), ...names];
  state.knownProducts = set.slice(-60);
}

export function recordEvidence(state: AssistantState, evidence: Evidence[]) {
  state.evidence = addEvidence(state.evidence, evidence);
}

// ── committed mutations (the journal's references, ADR 0017 §11) ───────────

export const mutationRefSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("quote"),
    tokenHash: hash,
    quoteNumber: z.string().max(40),
    quoteId: z.uuid().optional(),
    basis: quoteBasisSchema,
    /** The staged details the quote was built from (restored if a failed turn lost them). */
    staged: z.strictObject({
      contact: contactSchema.optional(),
      event: eventSchema.optional(),
      items: z.array(stagedItem).max(MAX_STAGED_ITEMS),
    }),
    replaces: z.string().max(40).nullable(),
    verified: z.boolean().default(true),
    /** The link token sealed to the session (only when this chat chose it; see ActiveQuote). */
    sealedLink: z.string().max(400).optional(),
  }),
  z.strictObject({
    type: z.literal("booking"),
    tokenHash: hash,
    quoteNumber: z.string().max(40),
    holdExpiresAt: z.string().max(40),
  }),
]);
export type MutationRef = z.infer<typeof mutationRefSchema>;

/** Applies a committed mutation to the state (idempotent; oldest first). */
export function applyMutationRef(state: AssistantState, ref: MutationRef) {
  if (ref.type === "quote") {
    state.contact = ref.staged.contact;
    state.event = ref.staged.event;
    state.items = ref.staged.items;
    state.quote = {
      tokenHash: ref.tokenHash,
      quoteNumber: ref.quoteNumber,
      ...(ref.quoteId ? { quoteId: ref.quoteId } : {}),
      origin: "assistant",
      basis: ref.basis,
      verified: ref.verified,
      ...(ref.sealedLink ? { sealedLink: ref.sealedLink } : {}),
    };
  }
  // A booking request changes nothing in the staging: its status is read from the quote.
}

// ── tool context ────────────────────────────────────────────────────────────

/** A committed mutation's result, as stored in the journal and replayed. */
export interface Committed {
  ref: MutationRef;
  outcome: ToolOutcome;
}

export interface MutationSpec {
  toolName: string;
  /** The semantic identity of the mutation (hashed with the conversation id). */
  key: unknown;
  /**
   * The mutation's complete input (basis, staged snapshot, sealed link token…), recorded by the
   * FIRST attempt and immutable: later attempts receive the recorded one, never their own.
   */
  pending: Record<string, unknown>;
  /** To open sealed values in stored outcomes when they are replayed. */
  sealer: Sealer;
  /**
   * An earlier attempt started this mutation without recording its outcome: return what exists
   * under the business key (authoritatively, from the database), or null if nothing does.
   */
  recover: (pending: Record<string, unknown>, businessKey: string) => Promise<Committed | null>;
  /**
   * For time-sensitive outcomes (a booking hold): the CURRENT outcome to show when a committed
   * entry is replayed, instead of the stored one.
   */
  refresh?: (pending: Record<string, unknown>) => Promise<ToolOutcome>;
  /** Performs the business write with the recorded input, under the business idempotency key. */
  perform: (pending: Record<string, unknown>, businessKey: string) => Promise<Committed>;
}

export interface MutationJournal {
  run(spec: MutationSpec): Promise<{ replayed: boolean; outcome: ToolOutcome }>;
  /** Identity of the customer request (stable across retries of the same message). */
  readonly requestId: string;
}

export interface ToolContext {
  tenant: ResolvedTenant;
  meta: RequestMeta & { actor: "ai" };
  state: AssistantState;
  deps: PublicDeps;
  /** Anonymous catalog client (tests pass one bound to their PostgREST). */
  db?: PublicClient;
  now: () => Date;
  deadline: Deadline;
  journal: MutationJournal;
  /** Seals quote link tokens to this browser session (never stored in clear). */
  sealer: Sealer;
  /** The quote the customer is viewing (validated this turn), if different from the active one. */
  pageQuote?: { tokenHash: string; quoteNumber: string } | null;
  /** How many times each request-scoped mutation ran in this turn (see requestScopedKey). */
  ordinals?: Map<string, number>;
  /**
   * The customer's message of this turn and the assistant's previous reply: request_booking
   * places a real hold only when the customer asked for it (domain/assistant/booking-intent.ts).
   * Always set by runTurn.
   */
  customerTurn?: { message: string; previousAssistant: string | null };
  /** Per-turn reads shared by the tools of one turn (storefront shell, products by slug). */
  memo?: Map<string, Promise<unknown>>;
}

// UI blocks are shared with the chat component (types only).
export type { AssistantBlock, ProductCardData } from "@/domain/assistant/blocks";

export type ToolStatus =
  "ok" | "manual_review" | "rejected_validation" | "rejected_policy" | "error";

/** What a tool returns: JSON for the model, cards for the customer, typed facts for grounding. */
export interface ToolOutcome {
  status: ToolStatus;
  result: Record<string, unknown>;
  blocks: AssistantBlock[];
  evidence?: Evidence[];
  errorCode?: string;
}

/**
 * A key for a mutation whose meaning depends on WHEN it is asked ("add one more castle"): the
 * customer request (stable across retries of the same message) plus the occurrence within it, so a
 * retry replays the same calls instead of adding again, while a new message is a new request.
 */
export function requestScopedKey(ctx: ToolContext, kind: string, what: unknown): unknown {
  const ordinals = (ctx.ordinals ??= new Map<string, number>());
  const base = JSON.stringify([kind, what]);
  const n = (ordinals.get(base) ?? 0) + 1;
  ordinals.set(base, n);
  return { kind, request: ctx.journal.requestId, what, occurrence: n };
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
