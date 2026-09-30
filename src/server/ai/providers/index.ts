import "server-only";
import { getServerEnv } from "@/server/env";
import type { AiConfig } from "../config";
import type { LlmProvider } from "../provider";
import { OpenAiProvider } from "./openai";
import { ScriptedProvider } from "./scripted";

/** The configured provider (the only place a provider is chosen). */
export function createProvider(config: AiConfig): LlmProvider {
  if (config.provider === "scripted") return new ScriptedProvider();
  const key = getServerEnv().OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not configured");
  return new OpenAiProvider(key, config.model, config.timeoutMs);
}
