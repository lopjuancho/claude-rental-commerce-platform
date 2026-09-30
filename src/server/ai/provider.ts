/**
 * Model provider abstraction (ADR 0017 §9). The orchestrator talks only to this interface, so the
 * provider and model can change without touching tools, policy or UI.
 */

export interface LlmToolCall {
  id: string;
  name: string;
  /** Raw JSON text as produced by the model — validated by the server, never trusted. */
  arguments: string;
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmToolSpec[];
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string | null;
  toolCalls: LlmToolCall[];
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** A provider failure. The message is safe to log; it never contains the key or the response body. */
export class LlmProviderError extends Error {
  constructor(
    readonly code: "TIMEOUT" | "HTTP" | "MALFORMED" | "NETWORK",
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}
