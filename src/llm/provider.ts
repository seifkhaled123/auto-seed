export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMRequest {
  system: string;
  user: string;
  maxTokens: number;
}

export interface LLMResponse {
  /** Parsed JSON object from the model. The provider is responsible for stripping fences/etc. */
  json: unknown;
  /** Raw text the model emitted (for debugging). */
  raw: string;
  usage: TokenUsage;
}

export interface LLMProvider {
  readonly name: "anthropic" | "openai" | "gemini";
  readonly model: string;
  generateJSON(input: LLMRequest): Promise<LLMResponse>;
}

/** Pulls the first {...} JSON object out of a string, tolerating fenced blocks. */
export function extractJSON(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  // If body still starts with prose, find the first { ... } block.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const slice = start >= 0 && end > start ? body.slice(start, end + 1) : body;
  return JSON.parse(slice);
}
