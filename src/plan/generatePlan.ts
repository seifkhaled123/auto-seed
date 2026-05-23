import { z } from "zod";
import { CLIError } from "../util/errors.js";
import { log } from "../util/logger.js";
import { SchemaIR } from "../ir/types.js";
import type { LLMProvider, TokenUsage } from "../llm/provider.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompts.js";
import { SeedPlan } from "./schema.js";

export interface GeneratePlanInput {
  ir: SchemaIR;
  rowCounts: Record<string, number>;
  defaultRowCount: number;
  locale?: string;
  hint?: string;
  maxTokens?: number;
}

export interface GeneratePlanResult {
  plan: SeedPlan;
  usage: TokenUsage;
}

export async function generatePlan(
  provider: LLMProvider,
  input: GeneratePlanInput,
): Promise<GeneratePlanResult> {
  const maxTokens = input.maxTokens ?? 8000;

  const ask = async (extraError?: string) => {
    const user = buildUserPrompt({ ...input, extraValidationError: extraError });
    log.debug(`[plan] sending prompt to ${provider.name}/${provider.model} (~${user.length} chars)`);
    const res = await provider.generateJSON({
      system: SYSTEM_PROMPT,
      user,
      maxTokens,
    });
    log.debug(`[plan] usage: in=${res.usage.inputTokens} out=${res.usage.outputTokens}`);
    return res;
  };

  let res;
  try {
    res = await ask();
  } catch (err) {
    if (err instanceof CLIError) throw err;
    throw new CLIError(`LLM call failed: ${(err as Error).message}`, 3);
  }

  let parsed = SeedPlan.safeParse(coerceRawPlan(res.json));
  if (!parsed.success) {
    const msg = formatZodError(parsed.error);
    log.debug(`[plan] first response failed validation, retrying once: ${msg}`);
    try {
      res = await ask(msg);
    } catch (err) {
      if (err instanceof CLIError) throw err;
      throw new CLIError(`LLM retry failed: ${(err as Error).message}`, 3);
    }
    parsed = SeedPlan.safeParse(coerceRawPlan(res.json));
    if (!parsed.success) {
      throw new CLIError(
        `LLM returned invalid Seed Plan JSON after 2 attempts.`,
        3,
        formatZodError(parsed.error),
      );
    }
  }

  return { plan: parsed.data, usage: res.usage };
}

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
}

// Map well-known invalid strategy types that LLMs commonly return into valid equivalents.
const STRATEGY_COERCIONS: Record<string, Record<string, unknown>> = {
  boolean: { type: "faker", method: "datatype.boolean" },
  bool: { type: "faker", method: "datatype.boolean" },
  integer: { type: "sequence", start: 1 },
  int: { type: "sequence", start: 1 },
  string: { type: "faker", method: "lorem.words", args: [3] },
  float: { type: "faker", method: "number.float", args: [{ min: 0, max: 1000, fractionDigits: 2 }] },
  number: { type: "faker", method: "number.int", args: [{ min: 0, max: 1000 }] },
  date: { type: "faker", method: "date.recent" },
  datetime: { type: "faker", method: "date.recent" },
  timestamp: { type: "faker", method: "date.recent" },
  json: { type: "static", value: {} },
};

function coerceRawPlan(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const plan = raw as Record<string, unknown>;
  if (!Array.isArray(plan.tables)) return raw;
  return {
    ...plan,
    tables: plan.tables.map((t) => {
      if (!t || typeof t !== "object" || Array.isArray(t)) return t;
      const table = t as Record<string, unknown>;
      if (!Array.isArray(table.columns)) return t;
      return {
        ...table,
        columns: table.columns.map((c) => {
          if (!c || typeof c !== "object" || Array.isArray(c)) return c;
          const col = c as Record<string, unknown>;
          const s = col.strategy;
          if (!s || typeof s !== "object" || Array.isArray(s)) return c;
          const strat = s as Record<string, unknown>;
          const coerced = STRATEGY_COERCIONS[String(strat.type)];
          return coerced ? { ...col, strategy: coerced } : c;
        }),
      };
    }),
  };
}
