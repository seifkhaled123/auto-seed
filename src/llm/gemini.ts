import { GoogleGenAI } from "@google/genai";
import { CLIError } from "../util/errors.js";
import { extractJSON, LLMProvider, LLMRequest, LLMResponse } from "./provider.js";

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  readonly model: string;
  private client: GoogleGenAI;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async generateJSON(input: LLMRequest): Promise<LLMResponse> {
    return runWithRetry(async () => {
      const res = await this.client.models.generateContent({
        model: this.model,
        contents: input.user,
        config: {
          systemInstruction: input.system,
          maxOutputTokens: input.maxTokens,
          responseMimeType: "application/json",
        },
      });
      const raw = res.text?.trim() ?? "";
      const json = extractJSON(raw);
      return {
        json,
        raw,
        usage: {
          inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    });
  }
}

async function runWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { status?: number; message?: string; code?: number };
    const status = e.status ?? e.code;
    if (status === 401 || status === 403) {
      throw new CLIError(
        `Gemini auth failed (${status}).`,
        3,
        "Re-run `auto-seed init` or set GEMINI_API_KEY.",
      );
    }
    if (status === 429 || (typeof status === "number" && status >= 500)) {
      await sleep(1000);
      try {
        return await fn();
      } catch (err2) {
        throw new CLIError(
          `Gemini call failed after retry: ${(err2 as Error).message}`,
          3,
        );
      }
    }
    throw new CLIError(`Gemini call failed: ${e.message ?? String(err)}`, 3);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
