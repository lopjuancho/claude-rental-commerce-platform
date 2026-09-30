import "server-only";
import { getServerEnv } from "@/server/env";

/**
 * Assistant configuration and budgets — the ONLY place the model and limits are set
 * (ADR 0017 §8). Env overrides: AI_PROVIDER, AI_MODEL, AI_MAX_OUTPUT_TOKENS, AI_TIMEOUT_MS.
 */
export const AI_LIMITS = {
  /** Characters of one customer message. */
  maxMessageChars: 1000,
  /** Messages of history sent to the model (older ones are dropped). */
  maxHistoryMessages: 30,
  /** Characters of history sent to the model (oldest dropped first). */
  maxHistoryChars: 24_000,
  /** Tool executions in one turn. */
  maxToolCallsPerTurn: 6,
  /** Model calls in one turn (each may request tools). */
  maxModelSteps: 5,
  /** Whole-turn wall clock. */
  turnTimeoutMs: 60_000,
  /** Lifetime messages of one conversation before the customer is asked to start over. */
  maxConversationMessages: 400,
} as const;

export const PROMPT_VERSION = "assistant-2026.10.02-1";

export type AiProviderName = "openai" | "scripted";

export interface AiConfig {
  provider: AiProviderName;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

/** The configured provider, or null when the assistant is not offered. */
export function getAiConfig(): AiConfig | null {
  const env = getServerEnv();
  const provider = env.AI_PROVIDER ?? (env.OPENAI_API_KEY ? "openai" : "off");
  if (provider === "off") return null;
  return {
    provider,
    model:
      provider === "scripted" ? "scripted-test-double" : (env.AI_MODEL ?? DEFAULT_OPENAI_MODEL),
    maxOutputTokens: env.AI_MAX_OUTPUT_TOKENS ?? 600,
    timeoutMs: env.AI_TIMEOUT_MS ?? 20_000,
  };
}

export const assistantEnabled = () => getAiConfig() !== null;
