import type { LLMProvider } from "./provider.js";
import type { ResolvedConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GeminiProvider } from "./gemini.js";

export function makeProvider(rt: ResolvedConfig): LLMProvider {
  if (rt.provider === "anthropic") return new AnthropicProvider(rt.apiKey, rt.model);
  if (rt.provider === "gemini") return new GeminiProvider(rt.apiKey, rt.model);
  return new OpenAIProvider(rt.apiKey, rt.model);
}
