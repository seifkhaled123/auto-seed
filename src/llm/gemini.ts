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
      const { human, quotaExhausted, retryMs } = parseGeminiError(e.message ?? String(err));
      if (quotaExhausted) {
        throw new CLIError(
          `Gemini quota exceeded: ${human}`,
          3,
          "Check your usage at https://ai.dev/rate-limit.",
        );
      }
      await sleep(Math.min(retryMs, 30_000));
      try {
        return await fn();
      } catch (err2) {
        const { human: h2 } = parseGeminiError((err2 as Error).message ?? String(err2));
        throw new CLIError(`Gemini call failed after retry: ${h2}`, 3);
      }
    }
    const { human } = parseGeminiError(e.message ?? String(err));
    throw new CLIError(`Gemini call failed: ${human}`, 3);
  }
}

function parseGeminiError(raw: string): { human: string; quotaExhausted: boolean; retryMs: number } {
  try {
    const body = JSON.parse(raw) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ "@type"?: string; retryDelay?: string }>;
      };
    };
    const errBody = body.error;
    const human = (errBody?.message ?? raw).split("\n")[0].trim();
    const quotaExhausted = errBody?.status === "RESOURCE_EXHAUSTED";
    const retryInfo = errBody?.details?.find((d) => d["@type"]?.includes("RetryInfo"));
    const retryMs = retryInfo?.retryDelay ? parseFloat(retryInfo.retryDelay) * 1000 : 5_000;
    return { human, quotaExhausted, retryMs };
  } catch {
    return { human: raw, quotaExhausted: false, retryMs: 5_000 };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
