import OpenAI from "openai";
import { CLIError } from "../util/errors.js";
import { extractJSON, LLMProvider, LLMRequest, LLMResponse } from "./provider.js";

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly model: string;
  private client: OpenAI;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey, timeout: 120_000 });
    this.model = model;
  }

  async generateJSON(input: LLMRequest): Promise<LLMResponse> {
    return runWithRetry(async () => {
      const res = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: input.maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      });
      const raw = res.choices[0]?.message?.content?.trim() ?? "";
      const json = extractJSON(raw);
      return {
        json,
        raw,
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
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
        `OpenAI auth failed (401).`,
        3,
        "Re-run `auto-seed init` or set OPENAI_API_KEY.",
      );
    }
    if (e.status === 429 || (typeof e.status === "number" && e.status >= 500)) {
      await sleep(1000);
      try {
        return await fn();
      } catch (err2) {
        throw new CLIError(
          `OpenAI call failed after retry: ${(err2 as Error).message}`,
          3,
        );
      }
    }
    throw new CLIError(`OpenAI call failed: ${e.message ?? String(err)}`, 3);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
