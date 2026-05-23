import type { LLMProvider } from "./provider.js";
import type { ResolvedConfig } from "../config/config.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export function makeProvider(rt: ResolvedConfig): LLMProvider {
  if (rt.provider === "anthropic") return new AnthropicProvider(rt.apiKey, rt.model);
  return new OpenAIProvider(rt.apiKey, rt.model);
}
