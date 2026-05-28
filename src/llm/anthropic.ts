import Anthropic from "@anthropic-ai/sdk";
import { CLIError } from "../util/errors.js";
import { extractJSON, LLMProvider, LLMRequest, LLMResponse } from "./provider.js";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, timeout: 120_000 });
    this.model = model;
  }

  async generateJSON(input: LLMRequest): Promise<LLMResponse> {
    return runWithRetry(async () => {
      const res = await this.client.messages.create({
        model: this.model,
        max_tokens: input.maxTokens,
        system: input.system,
        messages: [{ role: "user", content: input.user }],
      });
      const raw = res.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim();
      const json = extractJSON(raw);
      return {
        json,
        raw,
        usage: {
          inputTokens: res.usage.input_tokens ?? 0,
          outputTokens: res.usage.output_tokens ?? 0,
        },
      };
    });
  }
}

async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { status?: number; message?: string };
    if (e.status === 401) {
      throw new CLIError(
        `Anthropic auth failed (401).`,
        3,
        "Re-run `auto-seed init` or set ANTHROPIC_API_KEY.",
      );
    }
    if (e.status === 429 || (typeof e.status === "number" && e.status >= 500)) {
      // single retry with backoff
      await sleep(1000);
      try {
        return await fn();
      } catch (err2) {
        throw new CLIError(
          `Anthropic call failed after retry: ${(err2 as Error).message}`,
          3,
        );
      }
    }
    throw new CLIError(`Anthropic call failed: ${e.message ?? String(err)}`, 3);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
