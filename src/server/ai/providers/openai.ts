import { z } from "zod";
import {
  type LlmMessage,
  type LlmProvider,
  LlmProviderError,
  type LlmRequest,
  type LlmResponse,
} from "../provider";

const ENDPOINT = "https://api.openai.com/v1/chat/completions";

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal("function"),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .nullable()
            .optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({ prompt_tokens: z.number(), completion_tokens: z.number() })
    .partial()
    .optional(),
});

function toOpenAi(m: LlmMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

/**
 * OpenAI Chat Completions with function calling (server-side only). The API key never leaves this
 * object: it is not logged, not returned and not part of any error message.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = "openai";

  constructor(
    private readonly apiKey: string,
    readonly model: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages.map(toOpenAi),
          tools: req.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              ...(t.strict ? { strict: true } : {}),
            },
          })),
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_completion_tokens: req.maxOutputTokens,
          temperature: 0.2,
        }),
        signal,
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") {
        throw new LlmProviderError("TIMEOUT", "Model request timed out");
      }
      throw new LlmProviderError("NETWORK", "Model request failed");
    }
    if (!res.ok) {
      // Never surface the body: it can echo request content.
      throw new LlmProviderError(
        "HTTP",
        `Model request failed (${String(res.status)})`,
        res.status,
      );
    }
    const parsed = responseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LlmProviderError("MALFORMED", "Unexpected model response");
    const choice = parsed.data.choices[0];
    if (!choice) throw new LlmProviderError("MALFORMED", "Unexpected model response");
    const message = choice.message;
    return {
      text: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        arguments: c.function.arguments,
      })),
      usage: {
        inputTokens: parsed.data.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
